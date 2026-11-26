"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AssistantClient } from "@ai-assistant/contracts";

export function OrganizationSsoLink({ client }: { client: AssistantClient }) {
  const [linked, setLinked] = useState<boolean>();
  const [review, setReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const password = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const request = new AbortController();
    function clear() {
      if (!document.hidden) return;
      pending.current?.abort();
      pending.current = null;
      if (password.current) password.current.value = "";
      setReview(false);
      setBusy(false);
    }
    setLinked(undefined);
    void client.getOrganizationSsoLink(request.signal).then(({ eligible, linked }) => {
      if (!request.signal.aborted && (eligible || linked)) setLinked(linked);
    }).catch(() => undefined);
    document.addEventListener("visibilitychange", clear);
    return () => {
      request.abort();
      document.removeEventListener("visibilitychange", clear);
      pending.current?.abort();
      pending.current = null;
    };
  }, [client]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || linked === undefined || document.hidden) return;
    const entered = password.current?.value ?? "";
    if (!entered || new TextEncoder().encode(entered).length > 72) {
      setError("请输入当前青屿账号密码，最多 72 字节。");
      return;
    }
    if (password.current) password.current.value = "";
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      if (linked) {
        await client.revokeOrganizationSsoLink(entered, request.signal);
        if (!request.signal.aborted) {
          setLinked(false);
          setReview(false);
          setMessage("已解除组织身份绑定，现有组织 SSO 会话已撤销。");
        }
      } else {
        const result = await client.startOrganizationSsoLink(entered, request.signal);
        if (!request.signal.aborted) window.location.assign(result.authorizationUrl);
      }
    } catch {
      if (!request.signal.aborted) {
        setError("无法完成操作。请核对当前青屿账号密码和组织资格。");
        password.current?.focus();
      }
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  if (linked === undefined) return null;
  return <section className="account-data-section" aria-label="组织 SSO 身份">
    <h3>组织 SSO 身份</h3>
    <p>{linked ? "已绑定组织身份，可在独立入口查看自己的组织对话摘要。" : "你可以核对目录身份，并启用组织 SSO。"}</p>
    {message && <p role="status">{message}</p>}
    {error && <p role="alert" className="error-box">{error}</p>}
    {review ? <form onSubmit={submit}>
      <label className="dialog-field">当前青屿账号密码
        <input ref={password} type="password" required autoComplete="current-password" disabled={busy} />
      </label>
      {linked && <p>解除绑定会退出此组织的所有 SSO 会话。</p>}
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={busy}
          onClick={() => { setError(""); setReview(false); }}>取消</button>
        <button type="submit" className="button primary" disabled={busy}>
          {busy ? "正在核对…" : linked ? "确认解除绑定" : "确认并前往组织验证"}
        </button>
      </div>
    </form> : <button type="button" className="button secondary"
      onClick={() => { setMessage(""); setReview(true); }}>{linked ? "解除组织身份绑定" : "绑定组织身份"}</button>}
  </section>;
}
