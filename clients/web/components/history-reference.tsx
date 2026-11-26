"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { AssistantClient, components } from "@ai-assistant/contracts";
import { readHistory, type Conversation } from "@/lib/assistant";
import { Modal } from "./modal";

type Reference = components["schemas"]["HistoryReferenceSelection"];
type Receipt = components["schemas"]["HistoryReferenceReceipt"];

export function HistoryReferencePicker({ client, targetId, offline, opener, close, select, describeError }: {
  client: AssistantClient;
  targetId?: string;
  offline: boolean;
  opener: RefObject<HTMLElement | null>;
  close: () => void;
  select: (reference: Reference) => void;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [allowed, setAllowed] = useState<boolean>();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [source, setSource] = useState<Conversation>();
  const [replies, setReplies] = useState<{ id: string; excerpt: string }[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);

  async function browse(signal: AbortSignal, after?: string) {
    const page = await client.listConversations({ unfiled: true, limit: 20, cursor: after }, signal);
    if (signal.aborted) return;
    const list = page.items.filter(({ id, projectId }) => id !== targetId && !projectId);
    setConversations((prior) => after ? [...prior, ...list.filter(({ id }) => !prior.some((item) => item.id === id))] : list);
    setCursor(page.nextCursor);
  }

  async function start(signal: AbortSignal) {
    const settings = await client.getMemorySettings(undefined, signal);
    if (signal.aborted) return;
    const enabled = "referenceHistory" in settings && settings.referenceHistory === true;
    setAllowed(enabled);
    if (enabled) await browse(signal);
  }

  useEffect(() => {
    setBusy(!offline);
    setAllowed(undefined);
    setSource(undefined);
    setReplies([]);
    setConversations([]);
    if (offline) return;
    const request = new AbortController();
    pending.current = request;
    void start(request.signal).catch((failure) => {
      if (!request.signal.aborted) setError(describeError(failure, "暂时无法读取历史引用设置。"));
    }).finally(() => {
      if (pending.current === request) { pending.current = null; setBusy(false); }
    });
    return () => {
      request.abort();
      pending.current?.abort();
      pending.current = null;
    };
  }, [client, describeError, offline, targetId]);

  async function run(operation: (signal: AbortSignal) => Promise<void>, fallback: string) {
    if (offline || pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    try { await operation(request.signal); }
    catch (failure) { if (!request.signal.aborted) setError(describeError(failure, fallback)); }
    finally { if (pending.current === request) { pending.current = null; setBusy(false); } }
  }

  function choose(conversation: Conversation) {
    setSource(undefined);
    setReplies([]);
    void run(async (signal) => {
      const messages = await readHistory(client, conversation.id, signal);
      if (signal.aborted) return;
      setSource(conversation);
      setReplies(messages.filter((item) => item.role === "assistant" && item.generation).reverse().slice(0, 20)
        .map(({ id, content }) => ({ id, excerpt: [...content].slice(0, 160).join("") })));
    }, "无法读取此对话中的已完成回复。");
  }

  return <Modal label="引用历史回复" className="action-dialog resource-dialog" returnFocus={opener} close={close}>
    <h2>引用历史回复</h2>
    {offline ? <p role="status">联网后可选择历史回复。</p>
      : allowed === false ? <p>在「个人记忆」中启用聊天历史引用后，可选择一条已完成回复。</p>
        : <p>所选回复会作为本次发送的附加上下文。</p>}
    {busy && <p role="status">正在核对来源…</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    {allowed && !source && <>
      {!busy && !conversations.length && <p>没有可选的其他普通对话。</p>}
      <ul className="private-record-list">{conversations.map((item) => <li key={item.id}>
        <button type="button" className="button secondary" disabled={busy || offline} onClick={() => choose(item)}>{item.title}</button>
      </li>)}</ul>
      {cursor && <button type="button" className="button secondary" disabled={busy || offline}
        onClick={() => void run((signal) => browse(signal, cursor), "暂时无法读取更多对话。")}>加载更多对话</button>}
    </>}
    {source && <section className="account-data-section" aria-label="可选的完成回复">
      <h3>{source.title}</h3>
      {!replies.length && <p>此对话暂无已完成的助手回复。</p>}
      <ul className="private-record-list">{replies.map(({ id, excerpt }) => <li key={id}>
        <p className="resource-text">{excerpt}</p>
        <button type="button" className="button secondary" disabled={offline || busy}
          onClick={() => select({ sourceConversationId: source.id, sourceMessageId: id })}>引用这条回复</button>
      </li>)}</ul>
      <button type="button" className="button secondary" disabled={busy} onClick={() => { setSource(undefined); setReplies([]); }}>
        返回对话列表
      </button>
    </section>}
    <div className="dialog-actions">
      {error && <button type="button" className="button secondary" disabled={busy || offline}
        onClick={() => void run(start, "暂时无法读取历史引用设置。")}>重试</button>}
      <button type="button" className="button secondary" onClick={close}>关闭</button>
    </div>
  </Modal>;
}

export function HistoryReferenceDetails({ client, conversationId, messageId, offline, openSource, describeError }: {
  client: AssistantClient;
  conversationId: string;
  messageId: string;
  offline: boolean;
  openSource: (id: string) => Promise<void>;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [receipt, setReceipt] = useState<Receipt>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    if (offline) setReceipt(undefined);
    return () => pending.current?.abort();
  }, [client, conversationId, messageId, offline]);

  async function review(open: boolean) {
    if (offline || pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    setReceipt(undefined);
    try {
      const result = await client.getMessageHistoryReference(conversationId, messageId, request.signal);
      if (request.signal.aborted) return;
      setReceipt(result);
      if (open && result.status === "available") await openSource(result.sourceConversationId);
    } catch (failure) {
      if (!request.signal.aborted) setError(describeError(failure, "暂时无法核对本次引用来源。"));
    } finally {
      if (pending.current === request) { pending.current = null; setBusy(false); }
    }
  }

  return <div className="history-reference" aria-label="历史回复来源">
    <button type="button" className="button compact-button" disabled={busy || offline}
      onClick={() => void review(false)}>查看历史来源</button>
    {receipt?.status === "unavailable" && <p role="status">此回复曾使用历史来源。当前无法再次访问。</p>}
    {receipt?.status === "available" && <div className="dialog-actions">
      <p role="status">来源回复 {receipt.sourceMessageId.slice(0, 8)}</p>
      <button type="button" className="button secondary" disabled={busy || offline} onClick={() => void review(true)}>打开来源对话</button>
    </div>}
    {error && <p className="error-box" role="alert">{error}</p>}
  </div>;
}
