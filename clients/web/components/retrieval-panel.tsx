"use client";

import { ExternalLink, RefreshCw, Search } from "lucide-react";
import { useId, useRef, useState, type FormEvent, type RefObject } from "react";
import type { AssistantClient, components } from "@ai-assistant/contracts";
import { safeSourceUrl } from "@/lib/assistant";
import { Modal } from "./modal";

type Answer = components["schemas"]["RetrievalAnswer"];

const sourceStatus = { available: "可用", stale: "已过期", unavailable: "不可用" } as const;
const checkedAt = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });

export function RetrievalPanel({ client, offline, close, returnFocus, describeError }: {
  client: AssistantClient;
  offline: boolean;
  close: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<Answer>();
  const [pending, setPending] = useState<"search" | "refresh">();
  const [error, setError] = useState("");
  const queryId = useId();
  const sourcePrefix = useId();
  const request = useRef(false);

  async function load(action: "search" | "refresh") {
    if (request.current || offline) return;
    const text = query.trim();
    if (action === "search" && (!text || [...text].length > 256)) {
      setError("请输入 1 到 256 个字符。");
      return;
    }
    const previous = answer;
    if (action === "refresh" && !previous) return;
    request.current = true;
    setPending(action);
    setError("");
    setAnswer(undefined);
    try {
      setAnswer(action === "refresh" && previous ? await client.getRetrievalAnswer(previous.id) : await client.retrieveAnswer(text));
    } catch (failure) {
      setError(describeError(failure, action === "refresh" ? "暂时无法重新核对来源，请重新检索。" : "暂时无法检索来源。"));
    } finally {
      setPending(undefined);
      request.current = false;
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void load("search");
  }

  const positions = new Map(answer?.citations.map((source, index) => [source.id, { index: index + 1, available: source.status === "available" }]));
  return <Modal label="来源检索" className="action-dialog retrieval-dialog" close={close} returnFocus={returnFocus}>
    <h2>来源检索</h2>
    <p>从已收录的资料中查找有来源支持的说明。</p>
    <form onSubmit={submit}>
      <label className="dialog-field" htmlFor={queryId}>检索内容
        <input id={queryId} autoFocus value={query} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="dialog-actions">
        <button type="button" className="button secondary" onClick={close}>关闭</button>
        <button type="submit" className="button primary" disabled={!query.trim() || !!pending || offline}>
          <Search size={17} aria-hidden="true" /> 检索
        </button>
      </div>
    </form>
    {offline && <p role="status">联网后可重新检索。</p>}
    {pending && <p role="status">{pending === "search" ? "正在检索…" : "正在核对来源…"}</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    {answer && <section className="retrieval-results" aria-label="检索结果">
      <h3>检索结果</h3>
      {answer.state === "no_sources" && <p role="status">没有可用来源支持此次检索。</p>}
      {answer.state === "partial" && <p role="status">部分来源已经失效，仅展示仍有可用来源支持的说明。</p>}
      {answer.claims.map((claim, claimIndex) => {
        const citations = claim.citationIds.flatMap((id) => {
          const position = positions.get(id);
          return position?.available ? [position.index] : [];
        });
        if (!citations.length) return null;
        return <p key={`${claimIndex}:${claim.citationIds[0]}`} className="retrieval-claim">{claim.text}{citations.map((number) =>
          <a key={number} href={`#${sourcePrefix}-${number}`} aria-label={`来源 ${number}`}>[{number}]</a>)}</p>;
      })}
      {!!answer.citations.length && <>
        <h3>来源</h3>
        <ol className="retrieval-sources">
          {answer.citations.map((source, index) => {
            const address = safeSourceUrl(source.url);
            return <li key={source.id} id={`${sourcePrefix}-${index + 1}`} tabIndex={-1}>
              <strong>{source.title}</strong>
              <span className="list-notice">{sourceStatus[source.status]} · 取得于 <time dateTime={source.accessedAt}>{checkedAt.format(new Date(source.accessedAt))}</time></span>
              {source.status === "available" && source.excerpt && <p>{source.excerpt}</p>}
              {source.status === "available" && address && <a href={address} target="_blank" rel="noopener noreferrer">打开来源 <ExternalLink size={14} aria-hidden="true" /></a>}
            </li>;
          })}
        </ol>
        <button type="button" className="button secondary" disabled={offline || !!pending} onClick={() => void load("refresh")}>
          <RefreshCw size={16} aria-hidden="true" /> 重新核对来源
        </button>
      </>}
    </section>}
  </Modal>;
}
