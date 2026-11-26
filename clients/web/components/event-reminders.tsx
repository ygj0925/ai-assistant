"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import { Modal } from "./modal";

type Schemas = components["schemas"];
type Subscription = Schemas["SandboxEventReminder"];
type OccurrencePage = Schemas["SandboxEventReminderOccurrencePage"];
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const subscriptions: Record<Subscription["state"], string> = {
  active: "已启用", paused: "已暂停", authorization_revoked: "连接授权已撤回",
};
const deliveries: Record<Schemas["SandboxEventReminderOccurrence"]["state"], string> = {
  waiting: "等待送达", delivered: "已送达", skipped: "已跳过", withdrawn: "已撤回", expired: "已过期",
};

function timeText(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short", timeZone }).format(new Date(value));
}

export function EventReminders({ client, offline, opener, close, describeError }: {
  client: AssistantClient;
  offline: boolean;
  opener: RefObject<HTMLElement | null>;
  close: () => void;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [activeGrant, setActiveGrant] = useState<string>();
  const [events, setEvents] = useState<Schemas["SandboxConnectorAction"][]>([]);
  const [items, setItems] = useState<Subscription[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [occurrences, setOccurrences] = useState<OccurrencePage>();
  const [title, setTitle] = useState("");
  const [zone, setZone] = useState(timezone);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [operationId, setOperationId] = useState("");
  const [deleting, setDeleting] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef<AbortController>(null);
  const selected = items.find(({ id }) => id === selectedId);

  const load = useCallback(async (signal: AbortSignal) => {
    const [grant, records, actions] = await Promise.all([
      client.getSandboxConnectorAuthorization(signal), client.listSandboxEventReminders(signal),
      client.listSandboxConnectorActions({ limit: 25 }, signal),
    ]);
    if (signal.aborted) return;
    const id = grant.state === "authorized" ? grant.authorizationId : undefined;
    const available = id ? actions.items.filter((action) => action.authorizationId === id && action.state === "completed") : [];
    setActiveGrant(id);
    setItems(records.items);
    setEvents(available);
    setOperationId((current) => available.some((item) => item.id === current) ? current : "");
  }, [client]);

  const run = useCallback(async (action: (signal: AbortSignal) => Promise<void>) => {
    if (pending.current || offline) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    setNotice("");
    try { await action(request.signal); }
    catch (failure) {
      if (!request.signal.aborted) {
        if (failure instanceof AssistantApiError && [401, 403, 404, 409].includes(failure.status)) {
          setActiveGrant(undefined);
          setSelectedId("");
          setOccurrences(undefined);
        }
        setError(describeError(failure, "暂时无法完成操作，请刷新后核对授权。"));
      }
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }, [describeError, offline]);

  useEffect(() => {
    if (offline) {
      setActiveGrant(undefined);
      setItems([]);
      setOccurrences(undefined);
      setBusy(false);
      return;
    }
    void run(load);
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [load, offline, run]);

  async function showOccurrences(id: string, signal: AbortSignal, cursor?: string) {
    const page = await client.listSandboxEventReminderOccurrences(id, { limit: 25, cursor }, signal);
    if (signal.aborted) return;
    setSelectedId(id);
    setOccurrences((existing) => cursor && existing ? {
      items: [...existing.items, ...page.items.filter(({ id }) => !existing.items.some((previous) => previous.id === id))],
      nextCursor: page.nextCursor,
    } : page);
  }

  function create(event: FormEvent) {
    event.preventDefault();
    if (!activeGrant || !title.trim()) return;
    const timeZone = zone.trim();
    if (!timeZone || ((start || end) && (!start || !end || start === end))) {
      setError("请填写有效时区，或完整设置不同的静默开始和结束时间。");
      return;
    }
    try { new Intl.DateTimeFormat("zh-CN", { timeZone }); }
    catch { setError("请输入有效的 IANA 时区，例如 Asia/Shanghai。"); return; }
    void run(async (signal) => {
      const created = await client.createSandboxEventReminder({
        title: title.trim(), authorizationId: activeGrant, eventKind: "fixture_notice_recorded", timeZone,
        quietHours: start && end ? { start, end } : undefined,
      }, signal);
      if (signal.aborted) return;
      setItems((current) => [created, ...current]);
      setTitle("");
      await showOccurrences(created.id, signal);
    });
  }

  function receive() {
    if (!activeGrant || !operationId) return;
    void run(async (signal) => {
      const result = await client.receiveSandboxReminderEvent({ authorizationId: activeGrant, operationId }, signal);
      if (selected) await showOccurrences(selected.id, signal);
      if (!signal.aborted) setNotice(`新建 ${result.scheduled} 条，重复 ${result.duplicates} 条，跳过 ${result.skipped} 条。`);
    });
  }

  const locked = offline || busy;
  return <Modal label="连接器事件提醒" returnFocus={opener} close={close} className="action-dialog resource-dialog">
    <h2>连接器事件提醒</h2>
    {offline && <p role="status">联网后可核对订阅和投递。</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!activeGrant && !locked && <p>在「连接器沙箱」授权后可创建事件提醒。</p>}
    {activeGrant && <form className="account-data-section" onSubmit={create} aria-label="新增事件提醒">
      <h3>收到合成通知时提醒</h3>
      <label className="dialog-field">提醒名称<input value={title} required maxLength={200} readOnly={locked}
        onChange={(event) => setTitle(event.target.value)} /></label>
      <label className="dialog-field">提醒时区<input value={zone} required readOnly={locked}
        onChange={(event) => setZone(event.target.value)} /></label>
      <div className="dialog-actions">
        <label className="dialog-field">静默开始<input type="time" value={start} readOnly={locked}
          onChange={(event) => setStart(event.target.value)} /></label>
        <label className="dialog-field">静默结束<input type="time" value={end} readOnly={locked}
          onChange={(event) => setEnd(event.target.value)} /></label>
      </div>
      <button className="button primary" type="submit" disabled={locked}>创建事件提醒</button>
    </form>}
    {activeGrant && !!events.length && <section className="account-data-section" aria-label="合成事件投递">
      <h3>投递已核实的通知</h3>
      <label className="dialog-field">选择通知<select value={operationId} disabled={locked}
        onChange={(event) => setOperationId(event.target.value)}>
        <option value="">选择一条已核实通知</option>
        {events.map((item) => <option key={item.id} value={item.id}>
          {timeText(item.result?.recordedAt ?? item.updatedAt, timezone)} · {item.id.slice(0, 8)}
        </option>)}
      </select></label>
      <button className="button secondary" type="button" disabled={locked || !operationId} onClick={receive}>接收此事件</button>
    </section>}
    {!!items.length && <section className="account-data-section" aria-label="现有事件提醒">
      <h3>事件提醒</h3>
      <ul className="private-record-list">{items.map((row) => <li key={row.id}>
        <button className="button secondary" type="button" disabled={locked}
          aria-pressed={selectedId === row.id} onClick={() => void run((signal) => showOccurrences(row.id, signal))}>{row.title}</button>
        <p>{subscriptions[row.state]} · {row.timeZone}</p>
      </li>)}</ul>
    </section>}
    {selected && occurrences && <section className="account-data-section" aria-label="事件提醒详情">
      <h3>{selected.title}</h3>
      <div className="dialog-actions">
        {selected.state !== "authorization_revoked" && <button type="button" className="button secondary" disabled={locked}
          onClick={() => void run(async (signal) => {
            const current = await client.setSandboxEventReminderActive(selected.id, selected.state === "paused", signal);
            if (signal.aborted) return;
            setItems((existing) => existing.map((item) => item.id === current.id ? current : item));
            await showOccurrences(selected.id, signal);
          })}>{selected.state === "paused" ? "恢复事件提醒" : "暂停事件提醒"}</button>}
        {deleting === selected.id ? <>
          <button className="button secondary" type="button" disabled={locked} onClick={() => setDeleting("")}>返回</button>
          <button className="button secondary danger-text" type="button" disabled={locked} onClick={() => void run(async (signal) => {
            await client.deleteSandboxEventReminder(selected.id, signal);
            if (signal.aborted) return;
            setDeleting("");
            setSelectedId("");
            setOccurrences(undefined);
            await load(signal);
          })}>确认删除提醒</button>
        </> : <button className="button secondary" type="button" disabled={locked} onClick={() => setDeleting(selected.id)}>删除事件提醒</button>}
      </div>
      {!occurrences.items.length && <p>暂无投递记录。</p>}
      <ul className="private-record-list">{occurrences.items.map((item) => <li key={item.id}>
        <p>{deliveries[item.state]} · {timeText(item.deliveredAt ?? item.deliveryAt, selected.timeZone)}</p>
        {item.state === "delivered" && (item.readAt ? <p>已读</p> :
          <button className="button secondary" type="button" disabled={locked} onClick={() => void run(async (signal) => {
            const changed = await client.markSandboxEventReminderRead(selected.id, item.id, signal);
            if (!signal.aborted) setOccurrences((prior) => prior && {
              ...prior, items: prior.items.map((row) => row.id === changed.id ? changed : row),
            });
          })}>标为已读</button>)}
      </li>)}</ul>
      {occurrences.nextCursor && <button type="button" className="button secondary" disabled={locked}
        onClick={() => void run((signal) => showOccurrences(selected.id, signal, occurrences.nextCursor ?? undefined))}>更多投递记录</button>}
    </section>}
    <div className="dialog-actions">
      <button className="button secondary" type="button" disabled={locked} onClick={() => void run(async (signal) => {
        await load(signal);
        if (selected) await showOccurrences(selected.id, signal);
      })}>刷新订阅和投递</button>
      <button className="button secondary" type="button" onClick={close}>关闭</button>
    </div>
  </Modal>;
}
