"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import type { AssistantClient, components } from "@ai-assistant/contracts";
import { idempotencyKey } from "@/lib/assistant";
import { Modal } from "./modal";
import { ReminderSharePublisher } from "./reminder-share-publisher";

type Reminder = components["schemas"]["Reminder"];
type ReminderInput = components["schemas"]["ReminderInput"];
type Occurrence = components["schemas"]["ReminderOccurrence"];
const cadenceLabels = { once: "一次", daily: "每日", weekly: "每周" };
const stateLabels = { active: "已启用", paused: "已暂停", completed: "已完成", expired: "已过期" };
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function timeLabel(value: string, timeZone = localZone) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone }).format(new Date(value));
}

export function RemindersPanel({ client, offline, canShare, close, returnFocus, describeError }: {
  client: AssistantClient;
  offline: boolean;
  canShare: boolean;
  close: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [occurrences, setOccurrences] = useState<Occurrence[]>([]);
  const [reminderCursor, setReminderCursor] = useState<string | null>(null);
  const [occurrenceCursor, setOccurrenceCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [title, setTitle] = useState("");
  const [wallTime, setWallTime] = useState("");
  const [zone, setZone] = useState(localZone);
  const [cadence, setCadence] = useState<ReminderInput["cadence"]>("once");
  const [quiet, setQuiet] = useState(false);
  const [quietStart, setQuietStart] = useState("22:00");
  const [quietEnd, setQuietEnd] = useState("07:00");
  const titleTooLong = [...title].length > 200;
  const [deleting, setDeleting] = useState<string>();
  const [sharing, setSharing] = useState<string>();
  const pending = useRef<AbortController | null>(null);
  const lastCreate = useRef<{ signature: string; key: string }>(undefined);

  useEffect(() => {
    const initial = new AbortController();
    pending.current = initial;
    setError("");
    setBusy(!offline);
    if (offline) pending.current = null;
    else {
      void Promise.all([
        client.listReminders({ limit: 20 }, initial.signal),
        client.listReminderOccurrences({ limit: 20 }, initial.signal),
      ]).then(([rules, history]) => {
        if (initial.signal.aborted) return;
        setReminders(rules.items);
        setReminderCursor(rules.nextCursor);
        setOccurrences(history.items);
        setOccurrenceCursor(history.nextCursor);
      }).catch((failure) => {
        if (!initial.signal.aborted) setError(describeError(failure, "暂时无法读取提醒。"));
      }).finally(() => {
        if (pending.current === initial) {
          pending.current = null;
          setBusy(false);
        }
      });
    }
    return () => {
      initial.abort();
      pending.current?.abort();
      pending.current = null;
    };
  }, [client, describeError, offline]);

  async function act(operation: (signal: AbortSignal) => Promise<void>, fallback: string) {
    if (pending.current || offline) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation(request.signal);
    } catch (failure) {
      if (!request.signal.aborted) setError(describeError(failure, fallback));
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  function refresh() {
    void act(async (signal) => {
      const [rules, history] = await Promise.all([
        client.listReminders({ limit: 20 }, signal),
        client.listReminderOccurrences({ limit: 20 }, signal),
      ]);
      if (signal.aborted) return;
      setReminders(rules.items);
      setReminderCursor(rules.nextCursor);
      setOccurrences(history.items);
      setOccurrenceCursor(history.nextCursor);
    }, "暂时无法刷新提醒。");
  }

  function create(event: FormEvent) {
    event.preventDefault();
    const timeZone = zone.trim();
    if (!title.trim() || titleTooLong || !wallTime || !timeZone || (quiet && (!quietStart || !quietEnd || quietStart === quietEnd))) {
      setError("请填写提醒内容、日期和时区，并使用不同的静默起止时间。");
      return;
    }
    try {
      new Intl.DateTimeFormat("zh-CN", { timeZone });
    } catch {
      setError("请输入有效的 IANA 时区，例如 Asia/Shanghai。");
      return;
    }
    const input: ReminderInput = { title: title.trim(), startsAtLocal: wallTime, timeZone, cadence };
    if (quiet) input.quietHours = { start: quietStart, end: quietEnd };
    const signature = JSON.stringify(input);
    const previous = lastCreate.current;
    const key = previous?.signature === signature ? previous.key : idempotencyKey();
    lastCreate.current = { signature, key };
    void act(async (signal) => {
      const row = await client.createReminder(input, key, signal);
      if (signal.aborted) return;
      lastCreate.current = undefined;
      setReminders((known) => [row, ...known.filter(({ id }) => id !== row.id)]);
      setTitle("");
      setNotice("提醒已保存。到期后可以在送达记录中查看。");
    }, "暂时无法保存提醒。");
  }

  return <Modal label="定时提醒" className="action-dialog resource-dialog" close={close} returnFocus={returnFocus}>
    <h2>定时提醒</h2>
    <p>按指定时区创建站内提醒。静默时段的提醒会延后至静默结束。</p>
    {offline && <p role="status">联网后可刷新提醒。</p>}
    {busy && <p role="status">正在同步…</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button type="button" className="button secondary" disabled={offline || busy} onClick={refresh}>
        <RefreshCw size={16} aria-hidden="true" /> 刷新提醒
      </button>
    </div>
    <form className="account-data-section" onSubmit={create}>
      <label className="dialog-field">提醒内容
        <input required maxLength={400} value={title} readOnly={busy || offline} onChange={(event) => setTitle(event.target.value)} />
      </label>
      {titleTooLong && <p role="status">提醒内容最多 200 个字符。</p>}
      <div className="reminder-fields">
        <label className="dialog-field">首次提醒时间
          <input type="datetime-local" required value={wallTime} readOnly={busy || offline} onChange={(event) => setWallTime(event.target.value)} />
        </label>
        <label className="dialog-field">时区
          <input required value={zone} readOnly={busy || offline} onChange={(event) => setZone(event.target.value)} />
        </label>
        <label className="dialog-field">重复规则
          <select value={cadence} disabled={busy || offline} onChange={(event) => setCadence(event.target.value as ReminderInput["cadence"])}>
            <option value="once">一次</option>
            <option value="daily">每日</option>
            <option value="weekly">每周</option>
          </select>
        </label>
      </div>
      <label className="memory-toggle"><input type="checkbox" checked={quiet} disabled={busy || offline}
        onChange={(event) => setQuiet(event.target.checked)} /> 设置静默时段</label>
      {quiet && <div className="reminder-fields">
        <label className="dialog-field">静默开始
          <input type="time" required value={quietStart} readOnly={busy || offline} onChange={(event) => setQuietStart(event.target.value)} />
        </label>
        <label className="dialog-field">静默结束
          <input type="time" required value={quietEnd} readOnly={busy || offline} onChange={(event) => setQuietEnd(event.target.value)} />
        </label>
      </div>}
      <div className="dialog-actions">
        <button type="submit" className="button primary" disabled={offline || busy || !title.trim() || titleTooLong || !wallTime}>创建提醒</button>
      </div>
    </form>
    <section className="account-data-section" aria-label="已设置提醒">
      <h3>已设置提醒</h3>
      {!reminders.length && !busy && <p>暂无提醒。</p>}
      <ul className="private-record-list">
        {reminders.map((row) => <li key={row.id}>
          <p><strong>{row.title}</strong> · {cadenceLabels[row.cadence]} · {stateLabels[row.state]}</p>
          {row.nextDeliveryAt && <p>下次送达 {timeLabel(row.nextDeliveryAt, row.timeZone)}（{row.timeZone}）</p>}
          {deleting === row.id ? <>
            <p>删除此提醒及送达记录？</p>
            <div className="dialog-actions">
              <button type="button" className="button secondary" disabled={busy} onClick={() => setDeleting(undefined)}>取消</button>
              <button type="button" className="button secondary danger-text" disabled={busy || offline}
                onClick={() => void act(async (signal) => {
                  await client.deleteReminder(row.id, signal);
                  if (signal.aborted) return;
                  setReminders((known) => known.filter(({ id }) => id !== row.id));
                  setOccurrences((known) => known.filter(({ reminderId }) => reminderId !== row.id));
                  setDeleting(undefined);
                }, "暂时无法删除提醒。")}>确认删除</button>
            </div>
          </> : <div className="dialog-actions">
            {(row.state === "active" || row.state === "paused") && <button type="button" className="button secondary" disabled={busy || offline}
              onClick={() => void act(async (signal) => {
                const updated = await client.updateReminderState(row.id, row.state === "paused", signal);
                if (!signal.aborted) setReminders((known) => known.map((item) => item.id === updated.id ? updated : item));
              }, "暂时无法更新提醒。")}>{row.state === "active" ? "暂停" : "恢复"}</button>}
            <button type="button" className="button secondary" disabled={busy || offline} onClick={() => setDeleting(row.id)}>删除</button>
            {canShare && <button type="button" className="button secondary" disabled={busy || offline} aria-expanded={sharing === row.id}
              onClick={() => setSharing((current) => current === row.id ? undefined : row.id)}>分享设置</button>}
          </div>}
          {canShare && sharing === row.id && deleting !== row.id && <ReminderSharePublisher
            reminder={row} client={client} offline={offline} close={() => setSharing(undefined)}
            describeError={describeError} />}
        </li>)}
      </ul>
      {reminderCursor && <button type="button" className="button secondary" disabled={busy || offline}
        onClick={() => void act(async (signal) => {
          const page = await client.listReminders({ limit: 20, cursor: reminderCursor }, signal);
          if (signal.aborted) return;
          setReminders((known) => [...known, ...page.items.filter(({ id }) => !known.some((row) => row.id === id))]);
          setReminderCursor(page.nextCursor);
        }, "暂时无法读取更多提醒。")}>加载更多提醒</button>}
    </section>
    <section className="account-data-section" aria-label="送达记录">
      <h3>送达记录</h3>
      {!occurrences.length && !busy && <p>暂无送达记录。</p>}
      <ul className="private-record-list">
        {occurrences.map((row) => <li key={row.id}>
          <p>{row.title} · {row.outcome === "expired" ? "已过期" : row.readAt ? "已读" : "未读"} · {timeLabel(row.occurredAt)}</p>
          {row.outcome === "delivered" && !row.readAt && <button type="button" className="button secondary" disabled={busy || offline}
            onClick={() => void act(async (signal) => {
              const read = await client.markReminderOccurrenceRead(row.id, signal);
              if (!signal.aborted) setOccurrences((known) => known.map((item) => item.id === read.id ? read : item));
            }, "暂时无法标记已读。")}>标为已读</button>}
        </li>)}
      </ul>
      {occurrenceCursor && <button type="button" className="button secondary" disabled={busy || offline}
        onClick={() => void act(async (signal) => {
          const page = await client.listReminderOccurrences({ limit: 20, cursor: occurrenceCursor }, signal);
          if (signal.aborted) return;
          setOccurrences((known) => [...known, ...page.items.filter(({ id }) => !known.some((row) => row.id === id))]);
          setOccurrenceCursor(page.nextCursor);
        }, "暂时无法读取更多记录。")}>加载更多记录</button>}
    </section>
    <div className="dialog-actions"><button type="button" className="button secondary" onClick={close}>关闭</button></div>
  </Modal>;
}
