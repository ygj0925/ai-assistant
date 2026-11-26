"use client";

import { Copy, Link2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { AssistantApiError, type AssistantClient } from "@ai-assistant/contracts";
import { errorText, type Conversation } from "@/lib/assistant";
import { shareAudienceLabel, shareDate, shareScopeLabel, tokenFromFragment, type ShareView } from "@/lib/sharing";
import { ShareMessages } from "./share-messages";
import { ContentReport } from "./content-report";
import { WorkspaceSwitch } from "./workspace-switch";

function inaccessible(error: unknown) {
  return error instanceof AssistantApiError && [401, 403, 404, 410].includes(error.status);
}

export function ShareReceiver({ brand, getClient, workspaceId, onSwitchWorkspace, onSignIn, onExpire, onCopy, onOpenWorkspace }: {
  brand: ReactNode;
  getClient: () => AssistantClient;
  workspaceId?: string;
  onSwitchWorkspace: (workspaceId: string) => Promise<void>;
  onSignIn: () => void;
  onExpire: () => void;
  onCopy: (conversation: Conversation) => void;
  onOpenWorkspace: () => void;
}) {
  const signedIn = Boolean(workspaceId);
  const [token, setToken] = useState<string | null | undefined>();
  const [view, setView] = useState<ShareView | null>(null);
  const [loading, setLoading] = useState(true);
  const [copying, setCopying] = useState(false);
  const [reportingAvailable, setReportingAvailable] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const currentToken = useRef<string | null>(null);
  const copyLock = useRef(false);

  useEffect(() => {
    let generation = 0;
    let needsValidation = true;

    function clearSnapshot() {
      generation += 1;
      needsValidation = true;
      setView(null);
      setReportingAvailable(false);
      setError("");
      setBlocked(false);
      setLoading(true);
    }

    function refresh() {
      clearSnapshot();
      const value = tokenFromFragment(window.location.hash);
      currentToken.current = value;
      setToken(value);
      if (!value || document.visibilityState === "hidden") return;

      needsValidation = false;
      const attempt = generation;
      const current = () => attempt === generation && currentToken.current === value;
      void getClient().getCapabilities().then(({ capabilities }) => {
        if (current()) setReportingAvailable(capabilities.some(({ id, available, reason }) =>
          id === "shared_reply_reporting" && (available || !signedIn && reason === "SIGN_IN_REQUIRED")));
      }).catch(() => { /* A share can still be opened when the reporting capability is unavailable. */ });
      void getClient().readShare(value).then((next) => {
        if (current()) setView(next);
      }).catch((failure: unknown) => {
        if (!current()) return;
        if (signedIn && failure instanceof AssistantApiError && failure.status === 401) {
          onExpire();
        } else if (inaccessible(failure)) {
          setBlocked(true);
        } else {
          setError("暂时无法读取分享，请稍后重试。");
        }
      }).finally(() => {
        if (current()) setLoading(false);
      });
    }

    function onFocus() { if (needsValidation && document.visibilityState !== "hidden") refresh(); }
    function onBlur() { needsValidation = true; }
    function onVisibility() {
      if (document.visibilityState === "hidden") clearSnapshot();
      else onFocus();
    }
    function onPageHide() {
      // Commit before the browser can retain the DOM in its back-forward cache.
      flushSync(clearSnapshot);
    }
    function onPageShow(event: PageTransitionEvent) { if (event.persisted) onFocus(); }

    refresh();
    window.addEventListener("hashchange", refresh);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      generation += 1;
      currentToken.current = null;
      window.removeEventListener("hashchange", refresh);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [getClient, signedIn, onExpire, revision]);

  async function copy() {
    if (!token || !view || copyLock.current) return;
    copyLock.current = true;
    setCopying(true);
    setError("");
    try {
      const conversation = await getClient().copyShare(token);
      if (currentToken.current === token) onCopy(conversation);
    } catch (failure) {
      if (currentToken.current !== token) return;
      if (failure instanceof AssistantApiError && failure.status === 401) {
        onExpire();
      } else if (inaccessible(failure)) {
        setView(null);
        setBlocked(true);
      } else {
        setError("暂时无法创建副本，请稍后重试。");
      }
    } finally {
      copyLock.current = false;
      setCopying(false);
    }
  }

  const visible = !!token && view;
  return (
    <main className="shared-page">
      <div className="sign-in-brand">{brand}</div>
      <section className="shared-body" aria-labelledby="shared-heading">
        <div className="auth-icon"><Link2 aria-hidden="true" /></div>
        <h1 id="shared-heading">{visible ? visible.title : "会话分享"}</h1>
        {token === null && <p role="status">分享链接无效。</p>}
        {token !== null && loading && <p role="status">正在读取分享…</p>}
        {blocked && <p role="status">此分享已撤销、过期或当前无权访问。</p>}
        {error && <p role="alert" className="error-box">{error}</p>}
        {visible && <>
          <p className="share-note">
            {shareScopeLabel(visible.scope)} · {shareAudienceLabel(visible.audience)} · 快照不含附件
          </p>
          <ShareMessages messages={visible.messages} reportReply={token && signedIn && reportingAvailable ? (index) => (
            <ContentReport title="举报共享回复" triggerLabel={`举报共享回复 ${index + 1}`} disabled={copying}
              submit={(reason, signal) => getClient().submitReport({ targetType: "shared_reply", shareToken: token, replyIndex: index, reason }, signal)}
              describeError={(failure, fallback) => {
                if (failure instanceof AssistantApiError && failure.status === 401) { onExpire(); return ""; }
                return errorText(failure, fallback);
              }} />
          ) : undefined} />
          <p className="share-note">有效期至 <time dateTime={visible.expiresAt}>{shareDate(visible.expiresAt)}</time></p>
        </>}
        <div className="shared-actions">
          {!signedIn && (blocked || visible) &&
            <button className="button primary" type="button" onClick={onSignIn}>
              {visible ? "登录后继续对话" : "登录后尝试访问"}
            </button>}
          {!signedIn && visible && reportingAvailable && visible.messages.some((message) => message.role === "assistant") &&
            <button className="button secondary" type="button" onClick={onSignIn}>登录后举报</button>}
          {signedIn && visible && <button className="button primary" type="button" disabled={copying}
            onClick={() => void copy()}><Copy size={17} aria-hidden="true" />{copying ? "正在创建副本…" : "创建独立副本"}</button>}
          {token && error && !view && <button className="button secondary" type="button" disabled={loading}
            onClick={() => setRevision((value) => value + 1)}>重新读取</button>}
          {workspaceId && <WorkspaceSwitch client={getClient()} selectedId={workspaceId} onSwitch={onSwitchWorkspace} onExpire={onExpire} />}
          {signedIn ? <button type="button" className="button link-button" disabled={copying} onClick={onOpenWorkspace}>前往青屿助手</button>
            : <a href="/" rel="noreferrer" className="button link-button">前往青屿助手</a>}
        </div>
      </section>
    </main>
  );
}
