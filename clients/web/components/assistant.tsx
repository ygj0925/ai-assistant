"use client";

import { ArrowRight, Leaf, LogIn, UserPlus } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AssistantApiError, AssistantClient } from "@ai-assistant/contracts";
import { errorText, type AccountErasureRequest, type Conversation, type User } from "@/lib/assistant";
import { ShareReceiver } from "./share-receiver";
import { ReminderShareReceiver } from "./reminder-share-receiver";
import { Workspace } from "./workspace";

export function Wordmark() {
  return <span className="wordmark"><span className="brand-mark"><Leaf size={22} aria-hidden="true" /></span>青屿助手</span>;
}

export function Assistant({ sharedEntry = false, reminderShareEntry = false }: {
  sharedEntry?: boolean;
  reminderShareEntry?: boolean;
}) {
  const [user, setUser] = useState<User | null>(null);
  const [viewingShare, setViewingShare] = useState(sharedEntry);
  const [viewingReminderShare, setViewingReminderShare] = useState(reminderShareEntry);
  const [reminderToken, setReminderToken] = useState("");
  const [reminderLinkRead, setReminderLinkRead] = useState(false);
  const [shareSignIn, setShareSignIn] = useState(false);
  const [initialConversation, setInitialConversation] = useState<Conversation | null>(null);
  const [registration, setRegistration] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [erasureNotice, setErasureNotice] = useState("");
  const [organizationSso, setOrganizationSso] = useState(false);
  const client = useRef<AssistantClient | null>(null);
  const authPending = useRef(false);
  const erasurePending = useRef(false);
  const password = useRef<HTMLInputElement>(null);
  const successNotice = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (erasureNotice) successNotice.current?.focus();
  }, [erasureNotice]);

  useEffect(() => {
    if (sharedEntry || reminderShareEntry) return;
    const request = new AbortController();
    void fetch("/api/assistant/v1/organization-sso/status", { cache: "no-store", signal: request.signal })
      .then((response) => response.ok ? response.json() : undefined)
      .then((result) => {
        if (!request.signal.aborted && result?.available === true) setOrganizationSso(true);
      }).catch(() => undefined);
    return () => request.abort();
  }, [sharedEntry, reminderShareEntry]);

  useEffect(() => {
    if (!reminderShareEntry) return;
    const hash = window.location.hash.slice(1);
    const token = hash.length < 256 ? new URLSearchParams(hash).get("r") : null;
    if (token && /^[A-Za-z0-9_-]{22,128}$/.test(token)) setReminderToken(token);
    if (hash) window.history.replaceState(null, "", "/reminder-share");
    setReminderLinkRead(true);
  }, [reminderShareEntry]);

  const getClient = useCallback(() => {
    client.current ??= new AssistantClient({ origin: window.location.origin });
    return client.current;
  }, []);

  const expireSession = useCallback(() => {
    // Other in-flight reads may observe revocation before the erasure receipt arrives.
    if (erasurePending.current) return;
    setUser(null);
    setInitialConversation(null);
    setRegistration(false);
    setShareSignIn(true);
    setNotice("登录已过期，请重新登录。");
    void client.current?.replaceSession(null).catch(() => undefined);
  }, []);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authPending.current) return;
    const form = new FormData(event.currentTarget);
    const credentials = { username: String(form.get("username")).trim(), password: String(form.get("password")) };
    if (new TextEncoder().encode(credentials.password).length > 72 ||
        registration && [...credentials.password].length < 12) {
      setNotice(registration ? "密码至少需要 12 个字符，并且最多使用 72 字节。" : "密码最多可使用 72 字节。");
      password.current?.focus();
      return;
    }
    authPending.current = true;
    setBusy(true);
    setNotice("");
    setErasureNotice("");
    const api = getClient();
    try {
      const session = await (registration ? api.register(credentials) : api.login(credentials));
      await api.replaceSession(session);
      setUser(session.user);
    } catch (error) {
      if (registration && error instanceof AssistantApiError && error.code === "CONFLICT") {
        setNotice("该用户名已被使用。");
      } else {
        setNotice(errorText(error, registration ? "暂时无法注册，请重试。" : "暂时无法登录，请重试。"));
      }
    } finally {
      authPending.current = false;
      setBusy(false);
    }
  }

  async function logout() {
    if (authPending.current) return;
    authPending.current = true;
    setBusy(true);
    setUser(null);
    setInitialConversation(null);
    setRegistration(false);
    setNotice("");
    try {
      await getClient().logout();
    } catch {
      await getClient().replaceSession(null).catch(() => undefined);
      setNotice("本机已退出。服务器暂未确认退出。");
    } finally {
      authPending.current = false;
      setBusy(false);
    }
  }

  async function eraseAccount(input: AccountErasureRequest) {
    erasurePending.current = true;
    try {
      await getClient().eraseAccount(input);
      setUser(null);
      setInitialConversation(null);
      setRegistration(false);
      setNotice("");
      setErasureNotice("账号已注销，所有设备会话已退出。");
    } finally {
      erasurePending.current = false;
    }
  }

  function openWorkspace(conversation?: Conversation) {
    window.history.replaceState(null, "", "/");
    setInitialConversation(conversation ?? null);
    setViewingShare(false);
    setViewingReminderShare(false);
    setReminderToken("");
    setShareSignIn(false);
  }

  async function switchWorkspace(workspaceId: string) {
    const selected = await getClient().switchWorkspace(workspaceId);
    setInitialConversation(null);
    setUser(selected);
  }

  async function returnToPersonalWorkspace() {
    const selected = await getClient().returnToPersonalWorkspace();
    setInitialConversation(null);
    setUser(selected);
  }

  const scope = user ? `${user.id}:${user.workspaceId}` : "guest";

  if (viewingShare && (!shareSignIn || user)) {
    return <ShareReceiver key={scope} brand={<Wordmark />} getClient={getClient}
      workspaceId={user?.workspaceId} onSwitchWorkspace={switchWorkspace} onExpire={expireSession} onCopy={openWorkspace} onOpenWorkspace={() => openWorkspace()}
      onSignIn={() => { setRegistration(false); setShareSignIn(true); }} />;
  }

  if (viewingReminderShare && reminderToken && user && client.current) {
    return <ReminderShareReceiver key={scope} client={client.current} token={reminderToken} brand={<Wordmark />}
      onExpire={expireSession} onOpenWorkspace={() => openWorkspace()} />;
  }

  if (viewingReminderShare && !reminderToken) {
    return <main className="sign-in">
      <div className="sign-in-brand"><Wordmark /></div>
      <div className="sign-in-main">
        <section className="sign-in-panel" aria-labelledby="reminder-share-entry">
          <h1 id="reminder-share-entry">分享的提醒</h1>
          {reminderLinkRead ? <>
            <p>此页面缺少有效的提醒分享链接。</p>
            <button type="button" className="button secondary" onClick={() => openWorkspace()}>返回青屿助手</button>
          </> : <p role="status">正在打开链接…</p>}
        </section>
      </div>
    </main>;
  }

  if (user && client.current) {
    return <Workspace key={scope} client={client.current} user={user} onExpire={expireSession}
      onLogout={logout} onErase={eraseAccount} onSwitchWorkspace={switchWorkspace}
      onReturnPersonalWorkspace={returnToPersonalWorkspace} initialConversation={initialConversation} />;
  }

  return (
    <main className="sign-in">
      <div className="sign-in-brand"><Wordmark /></div>
      <div className="sign-in-main">
        <section className="sign-in-panel" aria-labelledby="sign-in-heading">
          <div className="auth-icon">{registration ? <UserPlus aria-hidden="true" /> : <LogIn aria-hidden="true" />}</div>
          <h1 id="sign-in-heading">{registration ? "创建账号" : "登录青屿"}</h1>
          <p className="auth-subtitle">{viewingShare ? "登录后可以访问有权限的分享，并将其保存为独立对话。"
            : viewingReminderShare && reminderToken ? "登录后可核对分享的提醒，再决定是否启用。"
              : registration ? "创建账号后，你可以在工作区保存对话。" : "登录后即可查看和继续你的对话。"}</p>
          {erasureNotice && <p ref={successNotice} className="auth-success" role="status" tabIndex={-1}>{erasureNotice}</p>}
          <form className="auth-form" onSubmit={authenticate}>
            <div className="auth-field">
              <label htmlFor="username">用户名</label>
              <input id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false}
                required minLength={3} maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9_\-]{2,31}" disabled={busy}
                aria-describedby={registration ? "username-hint" : undefined} />
              {registration && <small id="username-hint">3–32 个字符，以字母或数字开头，可使用下划线和连字符。</small>}
            </div>
            <div className="auth-field">
              <label htmlFor="password">密码</label>
              <input ref={password} id="password" name="password" type="password" autoComplete={registration ? "new-password" : "current-password"}
                minLength={registration ? 12 : undefined} required disabled={busy}
                aria-describedby={registration ? "password-hint" : undefined} />
              {registration && <small id="password-hint">至少 12 个字符，最多 72 字节。</small>}
            </div>
            {notice && <p className="error-box" role="alert">{notice}</p>}
            <button className="button primary auth-submit" type="submit" disabled={busy}>
              {busy ? "正在处理…" : registration ? "创建账号" : "登录"} <ArrowRight size={18} aria-hidden="true" />
            </button>
          </form>
          {organizationSso && !registration && <div className="auth-mode">
            <a className="button secondary" href="/organization-sso">使用组织 SSO</a>
          </div>}
          <div className="auth-mode">
            <span>{registration ? "已有账号？" : "还没有账号？"}</span>
            <button type="button" className="button link-button" disabled={busy} onClick={() => {
              if (password.current) password.current.value = "";
              setRegistration(!registration);
              setNotice("");
            }}>{registration ? "返回登录" : "创建账号"}</button>
          </div>
          {viewingShare && <button type="button" className="button link-button" disabled={busy} onClick={() => {
            setShareSignIn(false);
            setNotice("");
          }}>返回分享</button>}
        </section>
      </div>
    </main>
  );
}
