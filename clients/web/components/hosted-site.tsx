"use client";

import { useEffect, useRef, useState } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import { WebsiteSandbox } from "./website-draft-editor";

type Site = components["schemas"]["HostedSiteRelease"];
type Preview = components["schemas"]["HostedSitePreview"];

function servingLink(value: string) {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return undefined;
    const testHost = url.hostname === "localhost" || url.hostname.endsWith(".localhost");
    if (url.protocol === "https:" || (url.protocol === "http:" && testHost)) return url.href;
  } catch { /* A malformed address is displayed as unavailable. */ }
  return undefined;
}

export function HostedSite({ client, projectId, artifactId, versionId, versionNumber, canPreview, disabled, describeError }: {
  client: AssistantClient;
  projectId: string;
  artifactId: string;
  versionId: string;
  versionNumber: number;
  canPreview: boolean;
  disabled: boolean;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [status, setStatus] = useState<Site | null>();
  const [review, setReview] = useState<{ candidate: Preview; html: string; current: string | null }>();
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController>(null);

  useEffect(() => {
    function clearOnHide() {
      if (!document.hidden) return;
      pending.current?.abort();
      pending.current = null;
      setBusy(false);
      setStatus(undefined);
      setReview(undefined);
      setRevoking(false);
    }
    document.addEventListener("visibilitychange", clearOnHide);
    return () => {
      pending.current?.abort();
      pending.current = null;
      document.removeEventListener("visibilitychange", clearOnHide);
    };
  }, []);

  async function run(action: (signal: AbortSignal) => Promise<void>, fallback: string) {
    if (disabled || pending.current || document.hidden) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(request.signal); }
    catch (failure) {
      if (!request.signal.aborted) {
        setStatus(undefined);
        setReview(undefined);
        setRevoking(false);
        setError(failure instanceof AssistantApiError && failure.status === 409
          ? "公开版本已变化，请刷新并重新审核。" : describeError(failure, fallback));
      }
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  async function reload(signal: AbortSignal) {
    const { release } = await client.getHostedSite(projectId, artifactId, signal);
    if (!signal.aborted) setStatus(release);
    return release;
  }

  const selected = review?.candidate.versionId === versionId ? review : undefined;
  const url = status?.accessible ? servingLink(status.url) : undefined;
  const locked = disabled || busy;
  return <section className="account-data-section" aria-label="站点公开托管">
    <h3>站点公开托管</h3>
    {error && <p className="error-box" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {status === null && <p>暂无公开站点。</p>}
    {status && <p>{url ? <a href={url} target="_blank" rel="noreferrer noopener">打开公开站点</a>
      : "当前发布地址无法访问。"}</p>}
    <div className="dialog-actions">
      <button type="button" className="button secondary" disabled={locked} onClick={() => void run(async (signal) => {
        setReview(undefined);
        setRevoking(false);
        await reload(signal);
      }, "暂时无法读取公开发布状态。")}>刷新发布状态</button>
      {canPreview && !selected && !revoking && <button type="button" className="button secondary" disabled={locked}
        onClick={() => void run(async (signal) => {
          const [release, candidate, content] = await Promise.all([reload(signal),
            client.previewHostedSite(projectId, artifactId, versionId, signal),
            client.previewWebpageArtifact(artifactId, versionId, signal)]);
          const html = await content.text();
          if (!signal.aborted) setReview({ candidate, html, current: release?.revision ?? null });
        }, "暂时无法审核所选网页。")}>审核公开版本 {versionNumber}</button>}
      {status && !revoking && !selected && <button type="button" className="button secondary danger-text" disabled={locked}
        onClick={() => setRevoking(true)}>撤回公开站点</button>}
    </div>
    {selected && <>
      <h4>{selected.candidate.title} · 版本 {selected.candidate.versionNumber}</h4>
      <p>发布后，任何获得站点地址的人都可以查看以下内容。</p>
      <WebsiteSandbox title="公开发布前预览" html={selected.html} />
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={locked} onClick={() => setReview(undefined)}>取消发布</button>
        <button type="button" className="button primary" disabled={locked} onClick={() => void run(async (signal) => {
          const release = await client.publishHostedSite(projectId, artifactId, {
            versionId: selected.candidate.versionId, contentDigest: selected.candidate.contentDigest,
            expectedRevision: selected.current, confirm: true,
          }, signal);
          if (!signal.aborted) {
            setStatus(release);
            setReview(undefined);
            setNotice(`版本 ${selected.candidate.versionNumber} 已公开。`);
          }
        }, "暂时无法公开此版本。")}>确认公开版本 {selected.candidate.versionNumber}</button>
      </div>
    </>}
    {revoking && status && <>
      <p>撤回后，访问此地址会被拒绝。项目版本可继续编辑。</p>
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={locked} onClick={() => setRevoking(false)}>取消撤回</button>
        <button type="button" className="button secondary danger-text" disabled={locked} onClick={() => void run(async (signal) => {
          await client.revokeHostedSite(projectId, artifactId, status.revision, signal);
          if (!signal.aborted) {
            setStatus(null);
            setRevoking(false);
            setNotice("已撤回公开站点。");
          }
        }, "暂时无法撤回公开站点。")}>确认撤回公开站点</button>
      </div>
    </>}
  </section>;
}
