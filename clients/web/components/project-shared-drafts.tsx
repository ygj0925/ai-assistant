"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import { downloadBlob } from "@/lib/assistant";

type Schemas = components["schemas"];
type Draft = Schemas["ProjectSharedDraft"];
type Revision = Schemas["ProjectSharedDraftRevision"];
type Editor = { title: string; content: string; baseRevisionId?: string };
const byteLimit = 32 * 1024;
const versionLimit = 32;
const retention = "任何参与编辑的人注销账号后，受影响的文稿及全部版本都会删除。";

export function ProjectSharedDrafts({ client, projectId, role, describeError }: {
  client: AssistantClient;
  projectId: string;
  role: "owner" | "editor" | "viewer";
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [items, setItems] = useState<Schemas["ProjectSharedDraftSummary"][]>([]);
  const [record, setRecord] = useState<Draft>();
  const [revisions, setRevisions] = useState<Schemas["ProjectSharedDraftRevisionSummary"][]>([]);
  const [selectedRevision, setSelectedRevision] = useState<Revision>();
  const [editor, setEditor] = useState<Editor>();
  const [confirmShare, setConfirmShare] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"restore" | "delete">();
  const [conflicted, setConflicted] = useState(false);
  const [reviewedConflict, setReviewedConflict] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef<AbortController | null>(null);

  function closeRecord() {
    setRecord(undefined);
    setRevisions([]);
    setSelectedRevision(undefined);
    setEditor(undefined);
    setConfirmShare(false);
    setConflicted(false);
    setReviewedConflict(false);
    setConfirmAction(undefined);
  }

  useEffect(() => {
    const request = new AbortController();
    pending.current = request;
    void client.listProjectSharedDrafts(projectId, request.signal).then(({ items: fresh }) => {
      if (!request.signal.aborted) setItems(fresh);
    }).catch((failure) => {
      if (!request.signal.aborted) setError(describeError(failure, "暂时无法读取共享文稿。"));
    }).finally(() => {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    });
    return () => {
      request.abort();
      pending.current?.abort();
      pending.current = null;
    };
  }, [client, describeError, projectId]);

  async function work(operation: (signal: AbortSignal) => Promise<void>, fallback: string, keepEditorOnConflict = false) {
    if (pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation(request.signal);
    } catch (failure) {
      if (request.signal.aborted) return;
      if (failure instanceof AssistantApiError) {
        if (failure.status === 401 || failure.status === 403 || failure.status === 404) {
          closeRecord();
          setItems([]);
        }
        if (failure.status === 409 && keepEditorOnConflict) {
          setConflicted(true);
          setReviewedConflict(false);
          setConfirmAction(undefined);
          setError("文稿版本已变化或达到上限。请刷新，并核对当前版本与未保存的内容。");
          return;
        }
      }
      setError(describeError(failure, fallback));
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  function setHead(head: Draft) {
    setRecord(head);
    const { id, title, revisionId, versionNumber, updatedAt, canEdit } = head;
    const summary = { id, title, revisionId, versionNumber, updatedAt, canEdit };
    setItems((current) => [summary, ...current.filter((item) => item.id !== id)]);
  }

  async function loadDraft(id: string, signal: AbortSignal) {
    const [head, history] = await Promise.all([
      client.getProjectSharedDraft(projectId, id, signal), client.listProjectSharedDraftRevisions(projectId, id, signal),
    ]);
    if (signal.aborted) return;
    setHead(head);
    setRevisions(history.items);
    setSelectedRevision(undefined);
    setConfirmAction(undefined);
  }

  async function saved(head: Draft, signal: AbortSignal, message: string) {
    if (signal.aborted) return;
    closeRecord();
    setHead(head);
    setNotice(message);
    await loadDraft(head.id, signal);
  }

  const canEdit = !!record?.canEdit && role !== "viewer" && record.versionNumber < versionLimit;
  const validText = !!editor?.title.trim() && [...editor.title.trim()].length <= 120 && !!editor.content.trim() &&
    new TextEncoder().encode(editor.content).byteLength <= byteLimit;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!editor || !validText || conflicted) return;
    const text = { title: editor.title.trim(), content: editor.content };
    if (!record && role === "owner" && confirmShare) {
      void work(async (signal) => saved(await client.createProjectSharedDraft(projectId, { ...text, confirm: true }, signal),
        signal, "共享文稿已创建。"), "创建结果未确认，请先刷新列表核对。");
    } else if (record && canEdit && editor.baseRevisionId) {
      const baseRevisionId = editor.baseRevisionId;
      void work(async (signal) => saved(await client.reviseProjectSharedDraft(projectId, record.id,
        { baseRevisionId, ...text }, signal), signal, "新版本已保存。"), "暂时无法保存版本。", true);
    }
  }

  function reload() {
    void work(async (signal) => {
      const fresh = await client.listProjectSharedDrafts(projectId, signal);
      if (signal.aborted) return;
      setItems(fresh.items);
      if (record) {
        if (!fresh.items.some(({ id }) => id === record.id)) { closeRecord(); return; }
        await loadDraft(record.id, signal);
        if (!signal.aborted && conflicted) setReviewedConflict(true);
      }
    }, "暂时无法刷新共享文稿。");
  }

  return <section className="account-data-section" aria-label="共享文稿">
    <h4>共享文稿</h4>
    <div className="dialog-actions">
      <button type="button" className="button secondary" disabled={busy} onClick={reload}>刷新共享文稿</button>
      {role === "owner" && !editor && <button type="button" className="button secondary" disabled={busy || items.length >= 32}
        onClick={() => { closeRecord(); setEditor({ title: "", content: "" }); }}>新建共享文稿</button>}
    </div>
    {busy && <p role="status">正在核对共享文稿…</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!busy && !items.length && !error && <p>暂无共享文稿。</p>}
    <ul className="private-record-list">{items.map((item) => <li key={item.id}>
      <button type="button" className="button secondary" disabled={busy || !!editor} aria-pressed={record?.id === item.id}
        onClick={() => { closeRecord(); void work((signal) => loadDraft(item.id, signal), "暂时无法读取这份文稿。"); }}>
        {item.title} · 版本 {item.versionNumber}
      </button>
    </li>)}</ul>
    {record && <section className="resource-detail" aria-label="当前共享文稿">
      <h4>{record.title} · 版本 {record.versionNumber}</h4>
      <p className="list-notice">{retention}</p>
      <pre className="resource-text" aria-label="当前版本内容">{record.content}</pre>
      {record.versionNumber >= versionLimit && <p>已保存 32 个版本。可继续查阅和下载历史版本。</p>}
      <div className="dialog-actions">
        {canEdit && !editor && <button type="button" className="button secondary" disabled={busy || !!confirmAction}
          onClick={() => { setConflicted(false); setEditor({ title: record.title, content: record.content,
            baseRevisionId: record.revisionId }); }}>编辑当前版本</button>}
        {role === "owner" && !editor && <button type="button" className="button secondary" disabled={busy || !!confirmAction}
          onClick={() => setConfirmAction("delete")}>删除共享文稿</button>}
      </div>
      {!!revisions.length && <ul className="private-record-list" aria-label="共享文稿版本">{revisions.map((revision) => <li key={revision.id}>
        <button type="button" className="button secondary" disabled={busy || !!editor || !!confirmAction}
          onClick={() => void work(async (signal) => {
            const version = await client.getProjectSharedDraftRevision(projectId, record.id, revision.id, signal);
            if (!signal.aborted) setSelectedRevision(version);
          }, "暂时无法读取指定版本。")}>
          版本 {revision.versionNumber}{revision.authoredByMe ? " · 我保存" : ""}
        </button>
      </li>)}</ul>}
      {selectedRevision && <section className="resource-detail" aria-label="历史版本内容">
        <h4>版本 {selectedRevision.versionNumber} · {selectedRevision.title}</h4>
        <pre className="resource-text">{selectedRevision.content}</pre>
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={() => void work(async (signal) => {
            const blob = await client.downloadProjectSharedDraftRevision(projectId, record.id, selectedRevision.id, signal);
            if (!signal.aborted) downloadBlob("shared-draft.md", blob);
          }, "暂时无法下载指定版本。")}>下载版本 {selectedRevision.versionNumber}</button>
          {canEdit && !editor && selectedRevision.id !== record.revisionId && <button type="button" className="button secondary"
            disabled={busy || !!confirmAction} onClick={() => setConfirmAction("restore")}>恢复此版本</button>}
        </div>
      </section>}
      {confirmAction && <div className="resource-detail">
        <p>{confirmAction === "delete" ? "确定删除所有协作成员可见的文稿及历史版本？" : "把已选择的历史内容保存为一个新版本？"}</p>
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={() => setConfirmAction(undefined)}>取消</button>
          {confirmAction === "delete" ? <button type="button" className="button danger" disabled={busy} onClick={() => void work(async (signal) => {
            await client.deleteProjectSharedDraft(projectId, record.id, signal);
            if (!signal.aborted) {
              closeRecord();
              setItems((current) => current.filter(({ id }) => id !== record.id));
              setNotice("共享文稿已删除。");
            }
          }, "暂时无法删除共享文稿。")}>确认删除共享文稿</button>
            : <button type="button" className="button primary" disabled={busy || !selectedRevision} onClick={() => {
              if (!selectedRevision) return;
              void work(async (signal) => saved(await client.restoreProjectSharedDraftRevision(projectId, record.id, {
                baseRevisionId: record.revisionId, revisionId: selectedRevision.id,
              }, signal), signal, "历史版本已恢复为新版本。"), "版本可能已变化，请刷新后再试。");
            }}>确认恢复版本</button>}
        </div>
      </div>}
    </section>}
    {editor && <form className="account-data-section" onSubmit={submit}>
      {!record && <p>当前项目协作成员可以查阅此文稿。{retention}</p>}
      <label className="dialog-field">共享文稿标题<input value={editor.title} readOnly={busy} required maxLength={120}
        onChange={(event) => setEditor({ ...editor, title: event.target.value })} /></label>
      <label className="dialog-field">共享文稿正文<textarea value={editor.content} readOnly={busy} required rows={9}
        onChange={(event) => setEditor({ ...editor, content: event.target.value })} /></label>
      {!record && <label><input type="checkbox" checked={confirmShare} disabled={busy}
        onChange={(event) => setConfirmShare(event.target.checked)} /> 确认对此项目的协作成员共享</label>}
      {conflicted && <p role="status">已保留未保存的内容。刷新后可比对上方的最新版本。</p>}
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={busy}
          onClick={() => { setEditor(undefined); setConflicted(false); setConfirmShare(false); }}>取消编辑</button>
        {conflicted && reviewedConflict && record && <button type="button" className="button secondary" disabled={busy || !canEdit}
          onClick={() => { setEditor({ ...editor, baseRevisionId: record.revisionId }); setConflicted(false); }}>
          已核对，以最新版本为基线
        </button>}
        <button type="submit" className="button primary" disabled={busy || !validText || conflicted || (record ? !canEdit : !confirmShare)}>
          {record ? "保存共享版本" : "创建共享文稿"}
        </button>
      </div>
    </form>}
  </section>;
}
