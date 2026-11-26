"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import { Modal } from "./modal";

type Product = components["schemas"]["SyntheticProduct"];
type Source = components["schemas"]["SyntheticProductSource"];
const states: Record<Product["status"], string> = {
  available: "有货", out_of_stock: "缺货", delisted: "已下架", expired: "价格已过期", unavailable: "来源不可用",
};
const when = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });

function offer(row: Product) {
  return row.price ? `${row.price.amount} ${row.price.currency}` : "暂无有效价格";
}

export function ProductCatalogue({ client, offline, opener, close, describeError }: {
  client: AssistantClient;
  offline: boolean;
  opener: RefObject<HTMLElement | null>;
  close: () => void;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Product[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [compared, setCompared] = useState<Product[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [source, setSource] = useState<Source>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const pending = useRef<AbortController>(null);

  const queryPage = useCallback(async (value: string, signal: AbortSignal, after?: string) => {
    const page = await client.searchSyntheticProducts({ q: value || undefined, limit: 24, cursor: after }, signal);
    if (signal.aborted) return;
    setQuery(value);
    setItems((prior) => after ? [...prior, ...page.items.filter((item) => !prior.some(({ id }) => id === item.id))]
      : page.items);
    setCursor(page.nextCursor);
  }, [client]);

  const run = useCallback(async (task: (signal: AbortSignal) => Promise<void>) => {
    if (pending.current || offline) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    setSource(undefined);
    try { await task(request.signal); }
    catch (failure) {
      if (!request.signal.aborted) {
        if (failure instanceof AssistantApiError && [401, 403, 404, 409].includes(failure.status)) {
          setItems([]);
          setCompared([]);
        }
        setError(describeError(failure, "暂时无法核对商品信息。请刷新后重试。"));
      }
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }, [describeError, offline]);

  useEffect(() => {
    if (offline) {
      setItems([]);
      setCompared([]);
      setSource(undefined);
      setBusy(false);
      return;
    }
    void run((signal) => queryPage("", signal));
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [offline, queryPage, run]);

  useEffect(() => {
    if (!source) return;
    const remaining = Math.min(60_000, Math.max(0, Date.parse(source.expiresAt) - Date.now()));
    const timer = window.setTimeout(() => setSource(undefined), remaining);
    return () => window.clearTimeout(timer);
  }, [source]);

  function search(event: FormEvent) {
    event.preventDefault();
    setCompared([]);
    void run((signal) => queryPage(draft.trim(), signal));
  }

  function choose(id: string) {
    setSelected((prior) => prior.includes(id) ? prior.filter((item) => item !== id) : [...prior, id]);
    setCompared([]);
  }

  function review(product: Product) {
    const snapshot = product.source;
    if (!snapshot) return;
    void run(async (signal) => {
      const current = await client.recheckSyntheticProductSource(product.id, snapshot.snapshotId, signal);
      if (!signal.aborted) setSource(current);
    });
  }

  const locked = offline || busy;
  return <Modal label="合成商品目录" returnFocus={opener} close={close} className="action-dialog resource-dialog">
    <h2>合成商品目录</h2>
    <p>这些测试商品使用模拟商家报价和时间记录。</p>
    {offline && <p role="status">联网后可查看当前报价。</p>}
    {error && <p role="alert" className="error-box">{error}</p>}
    <form className="account-data-section" onSubmit={search}>
      <label className="dialog-field">搜索商品<input value={draft} onChange={(event) => setDraft(event.target.value)}
        readOnly={locked} maxLength={100} /></label>
      <button className="button primary" type="submit" disabled={locked}>搜索</button>
    </form>
    {!!items.length && <section className="account-data-section" aria-label="搜索结果">
      <h3>搜索结果</h3>
      <ul className="private-record-list">{items.map((item) => <li key={item.id}>
        <h4>{item.title}</h4>
        <p>{item.description}</p>
        <p>{offer(item)} · {states[item.status]}{item.observedAt && ` · ${when.format(new Date(item.observedAt))}`}</p>
        <div className="dialog-actions">
          <label><input type="checkbox" checked={selected.includes(item.id)}
            disabled={locked || (selected.length >= 4 && !selected.includes(item.id))}
            onChange={() => choose(item.id)} /> 对比 {item.title}</label>
          {item.source && <button type="button" className="button secondary" disabled={locked}
            onClick={() => review(item)}>核对商品来源</button>}
        </div>
      </li>)}</ul>
      {cursor && <button type="button" className="button secondary" disabled={locked}
        onClick={() => void run((signal) => queryPage(query, signal, cursor))}>更多商品</button>}
    </section>}
    {!locked && !items.length && !error && <p>没有符合条件的商品。</p>}
    <div className="dialog-actions">
      {!!selected.length && <button type="button" className="button secondary" disabled={locked}
        onClick={() => { setSelected([]); setCompared([]); }}>清空所选</button>}
      <button type="button" className="button secondary" disabled={locked || selected.length < 2}
        onClick={() => void run(async (signal) => {
          const response = await client.compareSyntheticProducts(selected, signal);
          if (!signal.aborted) setCompared(response.items);
        })}>对比所选商品</button>
    </div>
    {!!compared.length && <section className="account-data-section" aria-label="商品对比">
      <h3>商品对比</h3>
      <ul className="private-record-list">{compared.map((item) => <li key={item.id}>
        <h4>{item.title}</h4>
        <p>{item.category} · {states[item.status]}</p>
        <p>{offer(item)}{item.observedAt && ` · ${when.format(new Date(item.observedAt))}`}</p>
        {item.source && <button type="button" className="button secondary" disabled={locked}
          onClick={() => review(item)}>核对商品来源</button>}
      </li>)}</ul>
    </section>}
    {source && <section className="account-data-section" aria-label="当前商品来源">
      <p>{source.merchantName} · 核对时间 {when.format(new Date(source.observedAt))}</p>
      <a className="button secondary" href={source.merchantUrl} rel="noreferrer noopener" target="_blank">打开测试商家来源</a>
    </section>}
    <div className="dialog-actions">
      <button className="button secondary" type="button" onClick={close}>关闭</button>
    </div>
  </Modal>;
}
