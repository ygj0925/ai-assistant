"use client";

import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { AssistantApiError, type AssistantClient } from "@ai-assistant/contracts";
import { Modal } from "./modal";

export function LockedConversations({ client, offline, opener, close, onUnlock, describeError }: {
  client: AssistantClient;
  offline: boolean;
  opener: RefObject<HTMLElement | null>;
  close: () => void;
  onUnlock: (id: string) => Promise<void>;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [ids, setIds] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string>();
  const [busy, setBusy] = useState(!offline);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);

  async function load(signal: AbortSignal, after?: string) {
    const page = await client.listLockedConversations({ cursor: after, limit: 20 }, signal);
    if (signal.aborted) return;
    const next = page.items.map(({ id }) => id);
    setIds((previous) => after ? [...new Set([...previous, ...next])] : next);
    setCursor(page.nextCursor);
  }

  useEffect(() => {
    const request = new AbortController();
    setIds([]);
    setCursor(null);
    setChosen(undefined);
    setBusy(!offline);
    if (!offline) {
      pending.current = request;
      void load(request.signal).catch((failure) => {
        if (!request.signal.aborted) setError(describeError(failure, "暂时无法读取加锁对话。"));
      }).finally(() => {
        if (pending.current === request) { pending.current = null; setBusy(false); }
      });
    }
    return () => {
      request.abort();
      pending.current?.abort();
      pending.current = null;
    };
  }, [client, describeError, offline]);

  async function operate(operation: (signal: AbortSignal) => Promise<void>, message: string) {
    if (offline || pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    try {
      await operation(request.signal);
    } catch (failure) {
      if (request.signal.aborted) return;
      if (failure instanceof AssistantApiError && failure.code === "INVALID_CURRENT_PASSWORD") {
        setError("密码不正确。请重新输入当前账号密码。");
      } else setError(describeError(failure, message));
    } finally {
      if (pending.current === request) { pending.current = null; setBusy(false); }
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chosen || offline || pending.current) return;
    const password = new FormData(event.currentTarget).get("currentPassword");
    event.currentTarget.reset();
    if (typeof password !== "string" || !password) return;
    const id = chosen;
    void operate(async (signal) => {
      await client.unlockConversationReading(id, password, signal);
      if (signal.aborted) return;
      setChosen(undefined);
      setIds((current) => current.filter((item) => item !== id));
      await onUnlock(id);
    }, "暂时无法解锁。可刷新对话列表核对状态。");
  }

  return <Modal label="加锁的对话" className="action-dialog" returnFocus={opener} close={() => { if (!chosen || !busy) close(); }}>
    <h2>加锁的对话</h2>
    <p>输入当前账号密码后恢复阅读。列表只显示对话编号。</p>
    {offline && <p role="status">联网后可以核对并解锁。</p>}
    {busy && <p role="status">正在核对…</p>}
    {error && <p role="alert" className="error-box">{error}</p>}
    {!ids.length && !busy && !error && !offline && <p>暂无加锁对话。</p>}
    <ul className="private-record-list">{ids.map((id) => <li key={id}>
      <button type="button" className="button secondary" disabled={offline || busy || !!chosen} onClick={() => setChosen(id)}>
        解锁对话 {id.slice(0, 8)}
      </button>
    </li>)}</ul>
    {chosen && <form className="account-data-section" onSubmit={submit}>
      <label className="dialog-field">当前账号密码<input type="password" name="currentPassword" autoComplete="current-password"
        required autoFocus readOnly={busy} /></label>
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={() => { setChosen(undefined); setError(""); }}>取消</button>
        <button type="submit" className="button primary" disabled={offline || busy}>确认解锁</button>
      </div>
    </form>}
    <div className="dialog-actions">
      {!chosen && <button type="button" className="button secondary" disabled={offline || busy}
        onClick={() => void operate((signal) => load(signal), "暂时无法刷新加锁对话。")}>刷新列表</button>}
      {!chosen && cursor && <button type="button" className="button secondary" disabled={offline || busy}
        onClick={() => void operate((signal) => load(signal, cursor), "暂时无法读取更多对话。")}>加载更多</button>}
      <button type="button" className="button secondary" disabled={!!chosen && busy} onClick={close}>关闭</button>
    </div>
  </Modal>;
}
