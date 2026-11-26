"use client";

import { useEffect, useRef, useState } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import { ReminderShareDetails, reminderShareTime } from "./reminder-share-details";

type Schemas = components["schemas"];
type Publication = Schemas["ReminderSharePublished"];
type Preview = Schemas["ReminderSharePreview"];
type Link = Schemas["ReminderShareInfo"];

export function ReminderSharePublisher({ reminder, client, offline, close, describeError }: {
  reminder: Schemas["Reminder"];
  client: AssistantClient;
  offline: boolean;
  close: () => void;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [preview, setPreview] = useState<Preview>();
  const [links, setLinks] = useState<Link[]>([]);
  const [published, setPublished] = useState<Publication>();
  const [revokeId, setRevokeId] = useState<string>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const address = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const request = new AbortController();
    setBusy(!offline);
    if (!offline) {
      pending.current = request;
      setError("");
      void client.listReminderShares(reminder.id, request.signal).then(({ items }) => {
        if (!request.signal.aborted) setLinks(items);
      }).catch((failure) => {
        if (!request.signal.aborted) setError(describeError(failure, "暂时无法读取分享链接。"));
      }).finally(() => {
        if (pending.current === request) {
          pending.current = null;
          setBusy(false);
        }
      });
    }
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [client, describeError, offline, reminder.id]);

  async function act(action: (signal: AbortSignal) => Promise<void>, fallback: string) {
    if (offline || pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action(request.signal);
    } catch (failure) {
      if (!request.signal.aborted) {
        if (failure instanceof AssistantApiError && failure.code === "SHARE_PREVIEW_STALE") {
          setPreview(undefined);
          setError("提醒时间已变化，请重新预览后分享。");
        } else setError(describeError(failure, fallback));
      }
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  const url = published && new URL(`/reminder-share#r=${encodeURIComponent(published.token)}`, window.location.origin).href;
  const disabled = busy || offline;
  return <section className="account-data-section" aria-label="提醒分享">
    <h3>分享提醒</h3>
    {error && <p role="alert" className="error-box">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {busy && <p role="status">正在同步…</p>}
    {!preview && reminder.state === "active" && <button className="button secondary" type="button" disabled={disabled}
      onClick={() => void act(async (signal) => {
        const reviewed = await client.previewReminderShare(reminder.id, signal);
        if (!signal.aborted) setPreview(reviewed);
      }, "此提醒暂时无法分享。")}>预览将公开的日程</button>}
    {preview && <>
      <ReminderShareDetails preview={preview} />
      <p>持有链接并登录的人可以将这些设置复制到自己的工作空间。</p>
      <div className="dialog-actions">
        <button className="button secondary" type="button" disabled={busy} onClick={() => setPreview(undefined)}>取消预览</button>
        <button className="button primary" type="button" disabled={disabled} onClick={() => void act(async (signal) => {
          const link = await client.publishReminderShare(reminder.id, preview.revision, signal);
          if (signal.aborted) return;
          setPublished(link);
          setPreview(undefined);
          const summary = { id: link.id, createdAt: link.createdAt, expiresAt: link.expiresAt, available: true };
          setLinks((items) => [summary, ...items.filter(({ id }) => id !== link.id)]);
        }, "暂时无法创建分享链接。")}>确认生成链接</button>
      </div>
    </>}
    {published && url && <div className="account-data-section">
      <label className="dialog-field">提醒分享链接 <input ref={address} readOnly value={url} /></label>
      <button className="button secondary" type="button" onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setNotice("已复制分享链接。");
        } catch {
          address.current?.focus();
          address.current?.select();
          setNotice("已选中链接，可以手动复制。");
        }
      }}>复制链接</button>
    </div>}
    {!!links.length && <ul className="private-record-list">
      {links.map((link) => <li key={link.id}>
        <p>{link.revokedAt ? "链接已撤销" : link.available
          ? `链接有效期至 ${reminderShareTime(link.expiresAt)}` : "链接当前不可用"}</p>
        {!link.revokedAt && (revokeId === link.id ? <div className="dialog-actions">
          <button className="button secondary" type="button" disabled={busy} onClick={() => setRevokeId(undefined)}>取消</button>
          <button className="button secondary danger-text" type="button" disabled={disabled}
            onClick={() => void act(async (signal) => {
              await client.revokeReminderShare(link.id, signal);
              if (signal.aborted) return;
              setLinks((items) => items.filter(({ id }) => id !== link.id));
              setPublished((latest) => latest?.id === link.id ? undefined : latest);
              setRevokeId(undefined);
              setNotice("已撤销此链接。");
            }, "暂时无法撤销链接。")}>确认撤销链接</button>
        </div> : <button className="button secondary" type="button" disabled={disabled}
          onClick={() => setRevokeId(link.id)}>撤销链接</button>)}
      </li>)}
    </ul>}
    <button className="button secondary" type="button" onClick={close}>返回提醒列表</button>
  </section>;
}
