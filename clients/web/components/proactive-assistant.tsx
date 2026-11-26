"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import type { AssistantClient, components } from "@ai-assistant/contracts";
import { Modal } from "./modal";

type Preferences = components["schemas"]["ProactivePreferencesWrite"];
type Suggestion = components["schemas"]["ProactiveSuggestions"]["items"][number];
const descriptions: Record<Suggestion["kind"], string> = {
  review_reminders: "查看尚未阅读的定时提醒",
  review_upcoming: "核对未来一天内的定时提醒",
};

export function ProactiveAssistant({ client, offline, opener, close, openReminders, describeError }: {
  client: AssistantClient;
  offline: boolean;
  opener: RefObject<HTMLElement | null>;
  close: () => void;
  openReminders: () => void;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [preferences, setPreferences] = useState<Preferences>();
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const active = useRef<AbortController>(null);

  const accept = useCallback((value: Preferences) => {
    setPreferences({
      enabled: value.enabled, role: value.role, notification: value.notification, timeZone: value.timeZone,
    });
    setStart(value.quietHours?.start ?? "");
    setEnd(value.quietHours?.end ?? "");
  }, []);

  const run = useCallback(async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (offline || active.current || document.hidden) return;
    const request = new AbortController();
    active.current = request;
    setBusy(true);
    setError("");
    setNotice("");
    try { await operation(request.signal); }
    catch (failure) {
      if (!request.signal.aborted) {
        setSuggestions([]);
        setError(describeError(failure, "无法更新主动建议。请重新核对设置。"));
      }
    } finally {
      if (active.current === request) {
        active.current = null;
        setBusy(false);
      }
    }
  }, [describeError, offline]);

  const loadSuggestions = useCallback(async (signal: AbortSignal) => {
    const { items } = await client.listProactiveSuggestions(signal);
    if (!signal.aborted) setSuggestions(items);
  }, [client]);

  const load = useCallback(async (signal: AbortSignal) => {
    const value = await client.getProactivePreferences(signal);
    if (signal.aborted) return;
    accept(value);
    await loadSuggestions(signal);
  }, [accept, client, loadSuggestions]);

  useEffect(() => {
    if (offline) {
      setSuggestions([]);
      setBusy(false);
      return;
    }
    function visibilityChanged() {
      if (document.hidden) {
        active.current?.abort();
        active.current = null;
        setSuggestions([]);
      } else void run(load);
    }
    void run(load);
    document.addEventListener("visibilitychange", visibilityChanged);
    return () => {
      active.current?.abort();
      active.current = null;
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [load, offline, run]);

  function save(event: FormEvent) {
    event.preventDefault();
    if (!preferences) return;
    const timeZone = preferences.timeZone.trim();
    if (!timeZone || ((start || end) && (!start || !end || start === end))) {
      setError("请填写有效时区，或完整设置不同的静默开始和结束时间。");
      return;
    }
    try { new Intl.DateTimeFormat("zh-CN", { timeZone }); }
    catch { setError("请输入有效的 IANA 时区，例如 Asia/Shanghai。"); return; }
    void run(async (signal) => {
      const result = await client.updateProactivePreferences({
        ...preferences, timeZone, quietHours: start && end ? { start, end } : undefined,
      }, signal);
      if (signal.aborted) return;
      accept(result);
      await loadSuggestions(signal);
      if (!signal.aborted) setNotice(result.enabled ? "已保存主动建议设置。" : "已关闭主动建议。");
    });
  }

  const locked = offline || busy;
  return <Modal label="主动建议" returnFocus={opener} close={close} className="action-dialog resource-dialog">
    <h2>主动建议</h2>
    <p>根据当前工作空间中你自己的定时提醒生成建议，可随时关闭。</p>
    {error && <p className="error-box" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {offline && <p role="status">联网后可核对当前设置。</p>}
    {preferences && <form className="account-data-section" onSubmit={save} aria-label="主动建议设置">
      <label className="dialog-field"><input type="checkbox" checked={preferences.enabled} disabled={locked}
        onChange={(event) => setPreferences({ ...preferences, enabled: event.target.checked })} /> 启用主动建议</label>
      <label className="dialog-field">建议类型<select value={preferences.role} disabled={locked}
        onChange={(event) => setPreferences({ ...preferences, role: event.target.value === "schedule_planner" ? "schedule_planner" : "reminder_review" })}>
        <option value="reminder_review">查看未读提醒</option><option value="schedule_planner">核对即将到来的提醒</option>
      </select></label>
      <label className="dialog-field">通知方式<select value={preferences.notification} disabled={locked}
        onChange={(event) => setPreferences({ ...preferences, notification: event.target.value === "silent" ? "silent" : "in_app" })}>
        <option value="in_app">站内建议</option><option value="silent">静音</option>
      </select></label>
      <label className="dialog-field">时区<input value={preferences.timeZone} readOnly={locked} required
        onChange={(event) => setPreferences({ ...preferences, timeZone: event.target.value })} /></label>
      <div className="dialog-actions">
        <label className="dialog-field">静默开始<input type="time" value={start} readOnly={locked}
          onChange={(event) => setStart(event.target.value)} /></label>
        <label className="dialog-field">静默结束<input type="time" value={end} readOnly={locked}
          onChange={(event) => setEnd(event.target.value)} /></label>
      </div>
      <button className="button primary" type="submit" disabled={locked}>保存设置</button>
    </form>}
    {!offline && !!suggestions.length && <section className="account-data-section" aria-label="当前建议">
      <h3>当前建议</h3>
      <ul className="private-record-list">{suggestions.map((item) => <li key={item.id}>
        <p>{descriptions[item.kind]}</p>
        <div className="dialog-actions">
          <button className="button secondary" type="button" disabled={locked} onClick={openReminders}>查看定时提醒</button>
          <button className="button secondary" type="button" disabled={locked} onClick={() => void run(async (signal) => {
            await client.dismissProactiveSuggestion(item.id, signal);
            await loadSuggestions(signal);
          })}>关闭这条建议</button>
        </div>
      </li>)}</ul>
    </section>}
    <div className="dialog-actions">
      <button className="button secondary" type="button" disabled={locked}
        onClick={() => void run(loadSuggestions)}>刷新建议</button>
      <button className="button secondary" type="button" onClick={close}>关闭</button>
    </div>
  </Modal>;
}
