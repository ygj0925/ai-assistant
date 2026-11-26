"use client";

import { Copy, Link2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type RefObject } from "react";
import { AssistantApiError, type AssistantClient } from "@ai-assistant/contracts";
import type { Conversation } from "@/lib/assistant";
import {
  shareAudienceLabel, shareDate, shareScopeLabel, tokenFromFragment,
  type SharePreview, type ShareRecord, type ShareSelection,
} from "@/lib/sharing";
import { Modal } from "./modal";
import { ShareMessages } from "./share-messages";

type PanelProps = {
  client: AssistantClient;
  conversation: Conversation;
  offline: boolean;
  close: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  describeError: (error: unknown, fallback: string) => string;
};

export function PublishShare({
  client, conversation, offline, close, returnFocus, describeError, sourceMessageId, scope,
}: PanelProps & Pick<ShareSelection, "sourceMessageId" | "scope">) {
  const [audience, setAudience] = useState<ShareSelection["audience"]>("workspace");
  const [preview, setPreview] = useState<SharePreview | null>(null);
  const [published, setPublished] = useState<{ url: string; expiresAt: string } | null>(null);
  const [busy, setBusy] = useState<"preview" | "publish">();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const live = useRef(false);
  const linkField = useRef<HTMLInputElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const previewId = useId();
  const linkId = useId();
  const audienceId = useId();
  const canUseLink = conversation.projectId == null;

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  useEffect(() => { if (preview) previewHeading.current?.focus(); }, [preview]);
  useEffect(() => { if (published) linkField.current?.focus(); }, [published]);

  async function prepare() {
    if (offline || pending.current) return;
    pending.current = true;
    setBusy("preview");
    setError("");
    try {
      const result = await client.previewShare(conversation.id, { sourceMessageId, scope, audience });
      if (live.current) setPreview(result);
    } catch (failure) {
      if (!live.current) return;
      if (audience === "link" && failure instanceof AssistantApiError && failure.status === 403) {
        setError("当前对话不能使用公开链接。请选择工作空间成员或检查分享权限。");
      } else {
        setError(describeError(failure, "暂时无法预览分享，请稍后重试。"));
      }
    } finally {
      pending.current = false;
      if (live.current) setBusy(undefined);
    }
  }

  async function publish() {
    if (!preview || offline || pending.current) return;
    pending.current = true;
    setBusy("publish");
    setError("");
    try {
      const created = await client.createShare(conversation.id, {
        sourceMessageId, scope: preview.scope, audience: preview.audience, revision: preview.revision,
      });
      if (!live.current) return;
      const destination = new URL("/share", window.location.origin);
      destination.hash = created.token;
      if (!tokenFromFragment(destination.hash)) throw new Error("Invalid share token");
      setPublished({ url: destination.href, expiresAt: created.expiresAt });
    } catch (failure) {
      if (!live.current) return;
      setPreview(null);
      if (failure instanceof AssistantApiError && failure.status === 409) {
        setError("对话内容或分享权限已变化。请重新预览后确认。");
      } else {
        setError(describeError(failure, "发布未确认。请先到分享管理查看，再决定是否重试。"));
      }
    } finally {
      pending.current = false;
      if (live.current) setBusy(undefined);
    }
  }

  async function copyLink() {
    if (!published) return;
    try {
      await navigator.clipboard.writeText(published.url);
      setNotice("已复制分享链接。");
    } catch {
      linkField.current?.focus();
      linkField.current?.select();
      setNotice("已选中链接，可以使用复制快捷键。");
    }
  }

  const title = scope === "reply" ? "分享回复" : "分享当前分支";
  return <Modal label={title} className="action-dialog share-dialog" returnFocus={returnFocus} close={close}>
    <div className="share-panel" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      {published ? <>
        <p>分享已发布。请保存链接，它只在本次发布时显示。</p>
        <label className="dialog-field" htmlFor={linkId}>分享链接
          <input ref={linkField} id={linkId} type="text" value={published.url} readOnly />
        </label>
        <p className="share-note">有效期至 <time dateTime={published.expiresAt}>{shareDate(published.expiresAt)}</time></p>
        {notice && <p className="share-note" role="status">{notice}</p>}
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={close}>完成</button>
          <button className="button primary" type="button" onClick={() => void copyLink()}>
            <Copy size={16} aria-hidden="true" /> 复制链接
          </button>
        </div>
      </> : <>
        <p className="share-note">{conversation.title} · {shareScopeLabel(scope)}</p>
        <label className="dialog-field" htmlFor={audienceId}>分享对象
          <select id={audienceId} value={audience} disabled={!!busy} onChange={(event) => {
            setAudience(event.target.value as ShareSelection["audience"]);
            setPreview(null);
            setError("");
          }}>
            <option value="workspace">工作空间成员</option>
            {canUseLink && <option value="link">知道链接的人</option>}
          </select>
        </label>
        <p className="share-note">{audience === "link"
          ? "任何获得链接的人都可以查看快照。"
          : "只有具备访问权限的工作空间成员可以查看快照。"}</p>
        <p className="share-note">快照保留发布时的消息文本。项目附件和资料沿用原有访问权限。</p>
        {preview && <section className="share-preview">
          <h3 ref={previewHeading} id={previewId} tabIndex={-1}>分享预览</h3>
          <p className="share-note">{preview.title} · {shareAudienceLabel(preview.audience)}</p>
          <div className="share-preview-scroll" role="region" aria-labelledby={previewId} tabIndex={0}>
            <ShareMessages messages={preview.messages} />
          </div>
        </section>}
        {offline && <p className="share-note" role="status">连接网络后可继续分享。</p>}
        {busy === "publish" && <p className="share-note" role="status">正在发布。关闭后可在管理分享查看结果。</p>}
        {error && <p className="error-box" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button className="button secondary" type="button" onClick={close}>{busy === "publish" ? "关闭" : "取消"}</button>
          {preview ? <button className="button primary" type="button" disabled={offline || !!busy}
            onClick={() => void publish()}><Link2 size={16} aria-hidden="true" />
            {busy === "publish" ? "正在发布…" : "确认发布"}</button>
            : <button className="button primary" type="button" disabled={offline || !!busy}
              onClick={() => void prepare()}>{busy === "preview" ? "正在预览…" : "预览分享"}</button>}
        </div>
      </>}
    </div>
  </Modal>;
}

export function ManageShares({ client, conversation, offline, close, returnFocus, describeError }: PanelProps) {
  const [items, setItems] = useState<ShareRecord[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(!offline);
  const [revokeTarget, setRevokeTarget] = useState<ShareRecord>();
  const [revoked, setRevoked] = useState<Set<string>>(new Set());
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const headingId = useId();
  const revokeHeadingId = useId();
  const generation = useRef(0);
  const revokeLock = useRef(false);
  const live = useRef(false);
  const status = useRef<HTMLParagraphElement>(null);
  const revokeHeading = useRef<HTMLHeadingElement>(null);
  const revokeOpener = useRef<HTMLButtonElement>(null);

  const read = useCallback(async (cursor?: string) => {
    const version = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const result = await client.listShares(conversation.id, { cursor, limit: 25 });
      if (version !== generation.current) return;
      setItems((existing) => cursor ? [...existing, ...result.items.filter(
        (item) => !existing.some((cached) => cached.id === item.id),
      )] : result.items);
      setNextCursor(result.nextCursor);
    } catch (failure) {
      if (version === generation.current) setError(describeError(failure, "暂时无法加载分享记录。"));
    } finally {
      if (version === generation.current) setLoading(false);
    }
  }, [client, conversation.id, describeError]);

  useEffect(() => {
    live.current = true;
    if (!offline) void read();
    else setLoading(false);
    return () => { generation.current += 1; live.current = false; };
  }, [offline, read]);
  useEffect(() => { if (notice) status.current?.focus(); }, [notice]);
  useEffect(() => { if (revokeTarget) revokeHeading.current?.focus(); }, [revokeTarget]);

  async function revoke() {
    if (offline || !revokeTarget || revokeLock.current) return;
    const id = revokeTarget.id;
    revokeLock.current = true;
    setRevoking(true);
    setError("");
    setNotice("");
    try {
      await client.revokeShare(id);
      if (!live.current) return;
      setRevoked((existing) => new Set(existing).add(id));
      setRevokeTarget(undefined);
      setNotice("原分享链接已撤销。");
    } catch (failure) {
      if (live.current) setError(describeError(failure, "暂时无法撤销分享，请稍后重试。"));
    } finally {
      revokeLock.current = false;
      if (live.current) setRevoking(false);
    }
  }

  return <Modal label="管理分享" className="action-dialog share-dialog" returnFocus={returnFocus} close={close}>
    <div className="share-panel" aria-labelledby={headingId}>
      <h2 id={headingId}>管理分享</h2>
      <p className="share-note">{conversation.title}</p>
      {offline && <p className="share-note" role="status">连接网络后可管理分享。</p>}
      {loading && <p className="share-note" role="status">正在读取分享记录…</p>}
      {revoking && <p className="share-note" role="status">正在撤销。关闭后可重新打开管理分享查看结果。</p>}
      {!items.length && !loading && !offline && !error && <p>暂无分享记录。</p>}
      {error && <p className="error-box" role="alert">{error}</p>}
      {notice && <p className="share-note" ref={status} role="status" tabIndex={-1}>{notice}</p>}
      {!!items.length && <ul className="share-records">
        {items.map((item) => {
          const inactive = item.revokedAt || revoked.has(item.id);
          const expired = Date.parse(item.expiresAt) <= Date.now();
          return <li key={item.id}>
            <div>
              <strong>{shareScopeLabel(item.scope)} · {shareAudienceLabel(item.audience)}</strong>
              <p className="share-note">发布于 <time dateTime={item.createdAt}>{shareDate(item.createdAt)}</time></p>
              <p className="share-note">有效期至 <time dateTime={item.expiresAt}>{shareDate(item.expiresAt)}</time></p>
            </div>
            {inactive ? <span className="share-note">已撤销</span>
              : expired ? <span className="share-note">已过期</span>
              : <button type="button" className="button danger-text" disabled={offline || revoking}
                onClick={(event) => {
                  revokeOpener.current = event.currentTarget;
                  setRevokeTarget(item);
                  setNotice("");
                  setError("");
                }}>撤销分享</button>}
          </li>;
        })}
      </ul>}
      {revokeTarget && <section className="share-revoke" aria-labelledby={revokeHeadingId}>
        <h3 id={revokeHeadingId} ref={revokeHeading} tabIndex={-1}>
          <ShieldCheck size={17} aria-hidden="true" /> 确认撤销分享
        </h3>
        <p className="share-note">{shareScopeLabel(revokeTarget.scope)} · {shareAudienceLabel(revokeTarget.audience)} ·
          <time dateTime={revokeTarget.createdAt}>{shareDate(revokeTarget.createdAt)}</time></p>
        <p>撤销会停用原分享链接。接收者此前创建的副本由接收者管理。</p>
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={revoking} onClick={() => {
            setRevokeTarget(undefined);
            revokeOpener.current?.focus();
          }}>取消撤销</button>
          <button type="button" className="button danger" disabled={offline || revoking}
            onClick={() => void revoke()}>{revoking ? "正在撤销…" : "确认撤销"}</button>
        </div>
      </section>}
      <div className="dialog-actions">
        {error && !revokeTarget && <button type="button" className="button link-button" disabled={offline || loading} onClick={() => void read()}>重试读取</button>}
        {nextCursor && <button type="button" className="button secondary" disabled={offline || loading}
          onClick={() => void read(nextCursor)}>加载更多</button>}
        <button type="button" className="button secondary" onClick={close}>关闭</button>
      </div>
    </div>
  </Modal>;
}
