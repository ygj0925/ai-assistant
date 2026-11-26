"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import { idempotencyKey } from "@/lib/assistant";
import { Modal } from "./modal";

type Schemas = components["schemas"];
type Kind = Schemas["ReviewedCatalogKind"];
type Item = Schemas["ReviewedCatalogItem"];
type Reason = Schemas["ReviewedCatalogReportReason"];
type Release = Schemas["CatalogRelease"];
type Source = Schemas["CatalogReleaseSource"];
type Review = { source: Source; candidate: Schemas["CatalogReleasePreview"]; key: string };
const collection: Schemas["ReviewedCatalogPage"] = { items: [], nextCursor: null };
const submissions: Schemas["CatalogReleasePage"] = { items: [], nextCursor: null };
const kinds: Record<Kind, string> = { assistant: "助手", connector: "连接器" };
const stateLabel: Record<Release["state"], string> = {
  pending: "待审核", published: "已发布", rejected: "未通过", withdrawn: "已撤回", superseded: "已由新版取代",
};
const reasonLabels: Record<Reason, string> = {
  spam: "垃圾内容", misleading: "误导说明", privacy: "泄露隐私", unsafe: "不安全内容", other: "其他",
};
const allowedReasons = Object.entries(reasonLabels) as [Reason, string][];
const publicationDate = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" });

export function ReviewedCatalog({ client, offline, canSubmitAssistant, canSubmitConnector, opener, close, describeError }: {
  client: AssistantClient;
  offline: boolean;
  canSubmitAssistant: boolean;
  canSubmitConnector: boolean;
  opener: RefObject<HTMLElement | null>;
  close: () => void;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [mode, setMode] = useState<"browse" | "author">("browse");
  const [filter, setFilter] = useState<Kind>();
  const [publicPage, setPublicPage] = useState(collection);
  const [detail, setDetail] = useState<Item>();
  const [report, setReport] = useState<Reason>();
  const [authorPage, setAuthorPage] = useState(submissions);
  const [assistants, setAssistants] = useState<Schemas["CustomAssistantPage"]>({ items: [], nextCursor: null });
  const [versions, setVersions] = useState<Schemas["CustomAssistantVersion"][]>([]);
  const [assistantId, setAssistantId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [sourceKind, setSourceKind] = useState<Kind>(canSubmitAssistant ? "assistant" : "connector");
  const [summary, setSummary] = useState("");
  const [review, setReview] = useState<Review>();
  const [withdraw, setWithdraw] = useState<Release>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef<AbortController>(null);
  const retryableDetail = useRef<Item>(undefined);

  const discard = useCallback(() => {
    pending.current?.abort();
    pending.current = null;
    retryableDetail.current = undefined;
    setBusy(false);
    setPublicPage(collection);
    setDetail(undefined);
    setReport(undefined);
    setAuthorPage(submissions);
    setAssistants({ items: [], nextCursor: null });
    setVersions([]);
    setAssistantId("");
    setVersionId("");
    setSummary("");
    setReview(undefined);
    setWithdraw(undefined);
    setNotice("");
  }, []);

  const run = useCallback(async (operation: (signal: AbortSignal) => Promise<void>, fallback: string) => {
    if (offline || pending.current || document.hidden) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    setNotice("");
    try { await operation(request.signal); }
    catch (failure) {
      if (!request.signal.aborted) {
        if (failure instanceof AssistantApiError && [401, 403, 404, 409].includes(failure.status)) {
          const selectedId = retryableDetail.current?.id;
          if (failure.status === 404 && selectedId) {
            setPublicPage((page) => ({ ...page, items: page.items.filter((item) => item.id !== selectedId) }));
          }
          retryableDetail.current = undefined;
          setDetail(undefined);
          setReport(undefined);
          setReview(undefined);
          setWithdraw(undefined);
        }
        setError(describeError(failure, fallback));
      }
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }, [describeError, offline]);

  const loadEntries = useCallback(async (signal: AbortSignal) => {
    const latest = await client.listReviewedCatalog({ kind: filter, limit: 20 }, signal);
    if (!signal.aborted) setPublicPage(latest);
  }, [client, filter]);

  const loadAuthor = useCallback(async (signal: AbortSignal) => {
    const [latest, defined] = await Promise.all([
      client.listCatalogAuthorReleases({ limit: 20 }, signal),
      canSubmitAssistant ? client.listCustomAssistants({ limit: 20 }, signal) : Promise.resolve({ items: [], nextCursor: null }),
    ]);
    if (!signal.aborted) { setAuthorPage(latest); setAssistants(defined); }
  }, [canSubmitAssistant, client]);

  useEffect(() => {
    if (offline) { discard(); return; }
    function load() {
      void run(mode === "browse" ? loadEntries : loadAuthor, "暂时无法读取审核目录。");
    }
    function visibilityChanged() {
      if (document.hidden) discard();
      else load();
    }
    load();
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      pending.current?.abort();
      pending.current = null;
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [discard, loadAuthor, loadEntries, mode, offline, run]);

  useEffect(() => {
    if (mode !== "browse" || offline) return;
    const timer = window.setInterval(() => {
      const shown = retryableDetail.current;
      if (!shown || document.hidden) return;
      void run(async (signal) => {
        const live = await client.getReviewedCatalogItem(shown.id, signal);
        if (signal.aborted) return;
        if (live.releaseId !== shown.releaseId) {
          retryableDetail.current = undefined;
          setDetail(undefined);
          setReport(undefined);
          await loadEntries(signal);
        }
      }, "此目录版本已无法查看，请刷新目录。");
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [client, loadEntries, mode, offline, run]);

  function chooseAssistant(id: string) {
    setAssistantId(id);
    setVersions([]);
    setVersionId("");
    if (!id) return;
    void run(async (signal) => {
      const { items } = await client.listCustomAssistantVersions(id, { limit: 20 }, signal);
      if (signal.aborted) return;
      setVersions(items.filter((version) => !version.resourceIds.length && !version.tools.length));
    }, "暂时无法读取此助手的版本。");
  }

  function prepareSubmission(event: FormEvent) {
    event.preventDefault();
    const source: Source = sourceKind === "assistant" ? {
      kind: "assistant", assistantId, versionId, summary: summary.trim() || undefined,
    } : { kind: "connector" };
    void run(async (signal) => {
      const candidate = await client.previewCatalogRelease(source, signal);
      if (!signal.aborted) setReview({ source, candidate, key: idempotencyKey() });
    }, "暂时无法预览此提交。");
  }

  const locked = offline || busy;
  return <Modal label="已审核目录" returnFocus={opener} close={close} className="action-dialog resource-dialog">
    <h2>已审核目录</h2>
    {error && <p className="error-box" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {offline && <p role="status">联网后可查看当前审核版本。</p>}
    <div className="dialog-actions">
      <button type="button" className="button secondary" aria-pressed={mode === "browse"} disabled={locked}
        onClick={() => { if (mode !== "browse") { discard(); setMode("browse"); } }}>浏览目录</button>
      {(canSubmitAssistant || canSubmitConnector) && <button type="button" className="button secondary"
        aria-pressed={mode === "author"} disabled={locked}
        onClick={() => { if (mode !== "author") { discard(); setMode("author"); } }}>我的提交</button>}
    </div>
    {mode === "browse" && !offline && <section className="account-data-section" aria-label="公开目录">
      <label className="dialog-field">类别<select value={filter ?? ""} disabled={locked} onChange={(event) => {
        discard();
        setFilter(event.target.value === "assistant" || event.target.value === "connector" ? event.target.value : undefined);
      }}><option value="">全部</option><option value="assistant">助手</option><option value="connector">连接器</option></select></label>
      {!busy && !publicPage.items.length && <p>暂无可查看的审核条目。</p>}
      <ul className="private-record-list">{publicPage.items.map((item) => <li key={item.id}>
        <button type="button" className="button secondary" disabled={locked} onClick={() => void run(async (signal) => {
          const current = await client.getReviewedCatalogItem(item.id, signal);
          if (!signal.aborted) { retryableDetail.current = current; setDetail(current); setReport(undefined); }
        }, "此目录版本已无法查看，请刷新目录。")}>{item.title}</button>
        <p>{kinds[item.kind]} · 版本 {item.versionNumber}</p>
        {item.summary && <p>{item.summary}</p>}
      </li>)}</ul>
      {publicPage.nextCursor && <button type="button" className="button secondary" disabled={locked}
        onClick={() => void run(async (signal) => {
          const next = await client.listReviewedCatalog({ kind: filter, limit: 20, cursor: publicPage.nextCursor ?? undefined }, signal);
          if (!signal.aborted) setPublicPage({ items: [...publicPage.items, ...next.items], nextCursor: next.nextCursor });
        }, "暂时无法读取更多条目。")}>更多条目</button>}
      {detail && <section className="account-data-section" aria-label="已审核版本详情">
        <h3>{detail.title} · 版本 {detail.versionNumber}</h3>
        <p>{publicationDate.format(new Date(detail.publishedAt))}</p>
        {detail.summary && <p>{detail.summary}</p>}
        {detail.instructions && <pre className="resource-text">{detail.instructions}</pre>}
        {detail.connectorId && <p>仅供查阅，不提供安装或运行。标识 {detail.connectorId}</p>}
        {report ? <form onSubmit={(event) => {
          event.preventDefault();
          void run(async (signal) => {
            await client.reportReviewedCatalogItem(detail.id, { releaseId: detail.releaseId, reason: report }, signal);
            if (!signal.aborted) { setReport(undefined); setNotice("已记录此版本的举报。"); }
          }, "暂时无法提交举报。");
        }}>
          <label className="dialog-field">举报原因<select value={report} disabled={locked}
            onChange={(event) => setReport(event.target.value as Reason)}>
            {allowedReasons.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select></label>
          <div className="dialog-actions"><button type="button" className="button secondary" disabled={locked}
            onClick={() => setReport(undefined)}>取消举报</button>
          <button type="submit" className="button primary" disabled={locked}>确认举报</button></div>
        </form> : <button type="button" className="button secondary" disabled={locked} onClick={() => setReport("spam")}>举报该版本</button>}
      </section>}
      <button type="button" className="button secondary" disabled={locked} onClick={() => void run(async (signal) => {
        retryableDetail.current = undefined;
        setDetail(undefined);
        setReport(undefined);
        await loadEntries(signal);
      }, "暂时无法刷新条目。")} >刷新目录</button>
    </section>}
    {mode === "author" && !offline && <section className="account-data-section" aria-label="我的目录提交">
      <h3>我的目录提交</h3>
      <ul className="private-record-list">{authorPage.items.map((release) => <li key={release.id}>
        <h4>{release.title} · 版本 {release.versionNumber}</h4>
        <p>{stateLabel[release.state]}</p>
        {(release.state === "published" || release.state === "pending") && <button type="button"
          className="button secondary" disabled={locked || !!review || !!withdraw} onClick={() => setWithdraw(release)}>撤回此版本</button>}
      </li>)}</ul>
      {authorPage.nextCursor && <button type="button" className="button secondary" disabled={locked}
        onClick={() => void run(async (signal) => {
          const next = await client.listCatalogAuthorReleases({ limit: 20, cursor: authorPage.nextCursor ?? undefined }, signal);
          if (!signal.aborted) setAuthorPage({ items: [...authorPage.items, ...next.items], nextCursor: next.nextCursor });
        }, "暂时无法读取更多提交。")}>更多提交</button>}
      {withdraw && <div className="account-data-section">
        <p>撤回 {withdraw.title} 的版本 {withdraw.versionNumber} 后，该版本将退出审核或失去目录访问。</p>
        <div className="dialog-actions"><button type="button" className="button secondary" disabled={locked}
          onClick={() => setWithdraw(undefined)}>取消撤回</button>
        <button type="button" className="button primary" disabled={locked} onClick={() => void run(async (signal) => {
          const updated = await client.withdrawCatalogRelease(withdraw.id, signal);
          if (!signal.aborted) {
            setAuthorPage((page) => ({ ...page, items: page.items.map((item) => item.id === updated.id ? updated : item) }));
            setWithdraw(undefined); setNotice("已撤回目录版本。");
          }
        }, "暂时无法撤回该版本。")}>确认撤回目录版本</button></div>
      </div>}
      {review ? <section className="account-data-section" aria-label="提交审核前预览">
        <h4>{review.candidate.title} · 版本 {review.candidate.versionNumber}</h4>
        <p>审核获准后，目录访问者可以阅读下列内容。</p>
        {review.candidate.summary && <p>{review.candidate.summary}</p>}
        {review.candidate.instructions && <pre className="resource-text">{review.candidate.instructions}</pre>}
        <div className="dialog-actions"><button type="button" className="button secondary" disabled={locked}
          onClick={() => setReview(undefined)}>返回编辑</button>
        <button type="button" className="button primary" disabled={locked} onClick={() => void run(async (signal) => {
          await client.submitCatalogRelease({ ...review.source, contentDigest: review.candidate.contentDigest, confirm: true }, review.key, signal);
          if (!signal.aborted) { setReview(undefined); setNotice("版本已提交审核。"); await loadAuthor(signal); }
        }, "暂时无法提交审核。")}>确认提交审核</button></div>
      </section> : !withdraw && <form onSubmit={prepareSubmission}>
        <label className="dialog-field">提交类别<select value={sourceKind} disabled={locked} onChange={(event) => {
          setSourceKind(event.target.value === "connector" ? "connector" : "assistant");
        }}>{canSubmitAssistant && <option value="assistant">定制助手</option>}
          {canSubmitConnector && <option value="connector">沙箱连接器说明</option>}
        </select></label>
        {sourceKind === "assistant" && <>
          <label className="dialog-field">我的定制助手<select value={assistantId} disabled={locked}
            onChange={(event) => chooseAssistant(event.target.value)}>
            <option value="">选择定制助手</option>
            {assistants.items.filter((item) => item.status === "active").map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></label>
          {assistants.nextCursor && <button type="button" className="button secondary" disabled={locked}
            onClick={() => void run(async (signal) => {
              const next = await client.listCustomAssistants({ limit: 20, cursor: assistants.nextCursor ?? undefined }, signal);
              if (!signal.aborted) setAssistants({ items: [...assistants.items, ...next.items], nextCursor: next.nextCursor });
            }, "暂时无法读取更多助手。")}>更多助手</button>}
          <label className="dialog-field">提交版本<select value={versionId} disabled={locked || !assistantId}
            onChange={(event) => setVersionId(event.target.value)}>
            <option value="">选择版本</option>
            {versions.map((version) => <option key={version.id} value={version.id}>版本 {version.number} · {version.name}</option>)}
          </select></label>
          {assistantId && !versions.length && !busy && <p>只有未关联资料和工具的版本可提交。</p>}
          <label className="dialog-field">公开说明<input value={summary} maxLength={240} readOnly={locked}
            onChange={(event) => setSummary(event.target.value)} /></label>
        </>}
        <button type="submit" className="button secondary" disabled={locked || (sourceKind === "assistant" && !versionId)}>预览提交内容</button>
      </form>}
      <button type="button" className="button secondary" disabled={locked || !!review || !!withdraw}
        onClick={() => void run(loadAuthor, "暂时无法刷新提交。")} >刷新审核状态</button>
    </section>}
    <div className="dialog-actions"><button type="button" className="button secondary" onClick={close}>关闭</button></div>
  </Modal>;
}
