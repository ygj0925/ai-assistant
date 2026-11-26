"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AssistantClient, components } from "@ai-assistant/contracts";
import { ContentReport } from "./content-report";

const siteRoute = /^\/assistant-sites\/([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/;

export function HostedSiteReport({ client, offline, describeError }: {
  client: AssistantClient;
  offline: boolean;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [link, setLink] = useState("");
  const [target, setTarget] = useState<components["schemas"]["HostedSiteReportTarget"]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);

  useEffect(() => () => pending.current?.abort(), []);

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || offline) return;
    setError("");
    setTarget(undefined);
    let url: URL;
    try { url = new URL(link.trim()); }
    catch { setError("请输入完整的公开站点链接。"); return; }
    const id = url.pathname.match(siteRoute)?.[1];
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!id || !((url.protocol === "http:" && loopback) || url.protocol === "https:") ||
      url.search || url.hash || url.username || url.password) {
      setError("请输入完整的公开站点链接。");
      return;
    }
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    try {
      const current = await client.getHostedSiteReportTarget(id, request.signal);
      if (request.signal.aborted) return;
      if (current.siteId !== id || current.publicUrl !== url.href) {
        setError("此链接与当前服务审核的公开站点不匹配。");
      } else setTarget(current);
    } catch (failure) {
      if (!request.signal.aborted) setError(describeError(failure, "暂时无法核对该发布版本。"));
    } finally {
      pending.current = null;
      if (!request.signal.aborted) setBusy(false);
    }
  }

  return <section className="account-data-section" aria-label="举报公开站点">
    <h3>举报公开站点</h3>
    <form onSubmit={review}>
      <label className="dialog-field">公开站点链接<input type="text" inputMode="url" maxLength={500}
        required value={link} disabled={offline || busy} onChange={(event) => {
          setLink(event.target.value);
          setTarget(undefined);
          setError("");
        }} /></label>
      <button className="button secondary" type="submit" disabled={offline || busy}>
        {busy ? "正在核对发布版本…" : "核对发布版本"}
      </button>
    </form>
    {error && <p className="error-box" role="alert">{error}</p>}
    {target && <>
      <p><a href={target.publicUrl} target="_blank" rel="noreferrer noopener">打开已核对的站点</a></p>
      <ContentReport key={target.revision} title="举报公开站点" triggerLabel="举报已核对的站点"
        disabled={offline || busy} describeError={describeError} submit={(reason, signal) => client.submitReport({
          targetType: "hosted_site", targetId: target.siteId, revision: target.revision, reason,
        }, signal)} />
    </>}
  </section>;
}
