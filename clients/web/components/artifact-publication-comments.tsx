"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AssistantClient, components } from "@ai-assistant/contracts";
import { idempotencyKey } from "@/lib/assistant";

type Comment = components["schemas"]["ArtifactPublicationComment"];
const date = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });

export function ArtifactPublicationComments({ client, projectId, publicationId, canWrite, offline, describeError }: {
  client: AssistantClient;
  projectId: string;
  publicationId: string;
  canWrite: boolean;
  offline: boolean;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [items, setItems] = useState<Comment[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<string>();
  const [busy, setBusy] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const pending = useRef<AbortController | null>(null);
  const retry = useRef<{ content: string; key: string }>(undefined);
  const exceeds = new TextEncoder().encode(draft).byteLength > 4096;

  useEffect(() => {
    const request = new AbortController();
    setBusy(!offline);
    if (!offline) {
      pending.current = request;
      setError("");
      void client.listArtifactPublicationComments(projectId, publicationId, request.signal)
        .then(({ items }) => { if (!request.signal.aborted) setItems(items); })
        .catch((failure) => {
          if (!request.signal.aborted) {
            setItems([]);
            setError(describeError(failure, "暂时无法读取此版本的评论。"));
          }
        }).finally(() => {
          if (pending.current === request) {
            pending.current = null;
            setBusy(false);
          }
        });
    } else {
      setItems([]);
    }
    return () => {
      request.abort();
      pending.current?.abort();
      pending.current = null;
    };
  }, [client, describeError, offline, projectId, publicationId, refresh]);

  async function work(action: (signal: AbortSignal) => Promise<void>, fallback: string) {
    if (offline || !canWrite || pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    try {
      await action(request.signal);
    } catch (failure) {
      if (!request.signal.aborted) setError(describeError(failure, fallback));
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || exceeds) return;
    void work(async (signal) => {
      const previous = retry.current;
      const key = previous?.content === draft ? previous.key : idempotencyKey();
      retry.current = { content: draft, key };
      const stored = await client.createArtifactPublicationComment(projectId, publicationId, draft, key, signal);
      if (signal.aborted) return;
      setItems((known) => [stored, ...known.filter(({ id }) => id !== stored.id)]);
      setDraft("");
      retry.current = undefined;
    }, "暂时无法提交评论。");
  }

  const locked = busy || offline;
  return <section className="account-data-section" aria-label="版本评论">
    <h5>版本评论</h5>
    {error && <p role="alert" className="error-box">{error}</p>}
    {!items.length && !busy && !offline && !error && <p>此版本暂无评论。</p>}
    {canWrite && <form onSubmit={submit}>
      <label className="dialog-field">评论正文
        <textarea rows={3} readOnly={locked} value={draft} maxLength={4096}
          onChange={(event) => setDraft(event.target.value)} />
      </label>
      {exceeds && <p role="alert">评论最多使用 4 KiB UTF-8 文本。</p>}
      <button type="submit" className="button primary" disabled={locked || !draft.trim() || exceeds}>提交评论</button>
    </form>}
    <button type="button" className="button secondary" disabled={locked}
      onClick={() => setRefresh((count) => count + 1)}>刷新评论</button>
    {!!items.length && <ul className="private-record-list">{items.map((comment) => <li key={comment.id}>
      <p>{comment.authoredByMe ? "我" : "协作成员"} · {date.format(new Date(comment.createdAt))}</p>
      <p className="resource-text">{comment.content}</p>
      {canWrite && comment.canDelete && (deleting === comment.id ? <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={() => setDeleting(undefined)}>取消删除</button>
        <button type="button" className="button secondary danger-text" disabled={locked} onClick={() => void work(async (signal) => {
          await client.deleteArtifactPublicationComment(projectId, publicationId, comment.id, signal);
          if (!signal.aborted) {
            setDeleting(undefined);
            setItems((known) => known.filter(({ id }) => id !== comment.id));
          }
        }, "暂时无法删除此评论。")}>确认删除评论</button>
      </div> : <button type="button" className="button secondary" disabled={locked}
        onClick={() => setDeleting(comment.id)}>删除评论</button>)}
    </li>)}</ul>}
  </section>;
}
