"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import { ContentReport } from "./content-report";
import { ReminderShareDetails, reminderShareTime } from "./reminder-share-details";

type Schemas = components["schemas"];

function describe(failure: unknown, fallback: string) {
  if (failure instanceof AssistantApiError) {
    if (failure.status === 404) return "分享链接已过期、被撤回，或提醒已不适用。";
    if (failure.status === 403) return "当前工作空间无法使用提醒分享。";
    if (failure.code === "SHARE_PREVIEW_STALE") return "提醒预览已变化，刷新核对后再确认。";
    if (failure.status === 409) return "当前账号已达到提醒数量上限。";
  }
  return fallback;
}

export function ReminderShareReceiver({ client, token, brand, onExpire, onOpenWorkspace }: {
  client: AssistantClient;
  token: string;
  brand: ReactNode;
  onExpire: () => void;
  onOpenWorkspace: () => void;
}) {
  const [preview, setPreview] = useState<Schemas["ReminderShareView"]>();
  const [reportingAvailable, setReportingAvailable] = useState(false);
  const [copied, setCopied] = useState<Schemas["Reminder"]>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => {
    const request = new AbortController();
    pending.current = request;
    setLoading(true);
    setError("");
    setPreview(undefined);
    setReportingAvailable(false);
    void client.getCapabilities(request.signal).then(({ capabilities }) => {
      if (!request.signal.aborted) setReportingAvailable(capabilities.some(({ id, available }) =>
        id === "reminder_share_reporting" && available));
    }).catch(() => { /* Sharing remains usable without its reporting capability. */ });
    void client.readReminderShare(token, request.signal).then((reviewed) => {
      if (!request.signal.aborted) setPreview(reviewed);
    }).catch((failure) => {
      if (request.signal.aborted) return;
      if (failure instanceof AssistantApiError && failure.status === 401) onExpire();
      else setError(describe(failure, "暂时无法读取分享提醒，请重试。"));
    }).finally(() => {
      if (pending.current === request) {
        pending.current = null;
        setLoading(false);
      }
    });
    return () => {
      request.abort();
      pending.current?.abort();
      pending.current = null;
    };
  }, [client, onExpire, refresh, token]);

  async function apply() {
    if (!preview || copied || pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setApplying(true);
    setError("");
    try {
      const reminder = await client.applyReminderShare({ token, revision: preview.revision, confirm: true }, request.signal);
      if (!request.signal.aborted) setCopied(reminder);
    } catch (failure) {
      if (request.signal.aborted) return;
      if (failure instanceof AssistantApiError && failure.status === 401) {
        onExpire();
        return;
      }
      if (failure instanceof AssistantApiError && (failure.status === 404 || failure.code === "SHARE_PREVIEW_STALE")) {
        setPreview(undefined);
      }
      setError(describe(failure, "暂时无法启用提醒，请重试。"));
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setApplying(false);
      }
    }
  }

  return <main className="sign-in">
    <div className="sign-in-brand">{brand}</div>
    <div className="sign-in-main">
      <section className="sign-in-panel" aria-labelledby="shared-reminder-title">
        <h1 id="shared-reminder-title">分享的提醒</h1>
        {loading && <p role="status">正在读取分享…</p>}
        {error && <p className="error-box" role="alert">{error}</p>}
        {copied ? <p className="auth-success" role="status">已在当前工作空间启用「{copied.title}」。</p> : preview && <>
          <ReminderShareDetails preview={preview} />
          <p>链接有效期至 {reminderShareTime(preview.expiresAt)}。确认后会在当前工作空间创建独立的提醒。</p>
          <button className="button primary" type="button" disabled={loading || applying} onClick={() => void apply()}>
            {applying ? "正在启用…" : "在当前工作空间启用"}
          </button>
          {reportingAvailable && <ContentReport key={preview.revision} title="举报分享的提醒" disabled={loading || applying}
            submit={(reason, signal) => client.submitReport({ targetType: "reminder_share", shareToken: token,
              revision: preview.revision, reason }, signal)} describeError={(failure, fallback) => {
              if (failure instanceof AssistantApiError && failure.status === 401) { onExpire(); return ""; }
              return describe(failure, fallback);
            }} />}
        </>}
        {!loading && !copied && !preview && <button type="button" className="button secondary"
          onClick={() => setRefresh((value) => value + 1)}>重试</button>}
        <button className="button secondary" type="button" disabled={applying} onClick={onOpenWorkspace}>进入工作区</button>
      </section>
    </div>
  </main>;
}
