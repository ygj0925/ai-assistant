"use client";

import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import { Modal } from "./modal";

type Schemas = components["schemas"];
type Settings = Schemas["PersonalMemorySettings"] | Schemas["ProjectMemorySettings"];
type Entry = Schemas["ManualMemory"];
const TEXT_LIMIT = 2_000;
const PAGE_SIZE = 12;

export function MemorySettings({ client, project, offline, close, returnFocus, describeError }: {
  client: AssistantClient;
  project?: { id: string; name: string };
  offline: boolean;
  close: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const projectId = project?.id;
  const title = project ? "项目记忆" : "个人记忆与指令";
  const [settings, setSettings] = useState<Settings>();
  const [draft, setDraft] = useState<Settings>();
  const [entries, setEntries] = useState<Entry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState<{ id: string; content: string }>();
  const [removing, setRemoving] = useState<Entry>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const scopeRequest = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const draftInstructions = draft && "instructions" in draft ? draft.instructions : undefined;

  useEffect(() => {
    const request = new AbortController();
    scopeRequest.current = request;
    setSettings(undefined);
    setDraft(undefined);
    setEntries([]);
    setCursor(null);
    setError("");
    setNotice("");
    setRemoving(undefined);
    setEditing(undefined);
    setBusy(false);
    if (!offline) {
      pending.current = true;
      setBusy(true);
      void (async () => {
        try {
          const state = await client.getMemorySettings(projectId, request.signal);
          const page = state.enabled ? await client.listMemories(projectId, { limit: PAGE_SIZE }, request.signal) : undefined;
          if (request.signal.aborted) return;
          setSettings(state);
          setDraft(state);
          setEntries(page?.items ?? []);
          setCursor(page?.nextCursor ?? null);
        } catch (failure) {
          if (!request.signal.aborted) setError(describeError(failure, "暂时无法读取记忆设置。"));
        } finally {
          if (!request.signal.aborted) {
            pending.current = false;
            setBusy(false);
          }
        }
      })();
    }
    return () => {
      request.abort();
      pending.current = false;
    };
  }, [client, describeError, offline, projectId, revision]);

  async function operate(action: (signal: AbortSignal) => Promise<void>) {
    const signal = scopeRequest.current?.signal;
    if (!signal || signal.aborted || offline || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action(signal);
    } catch (failure) {
      if (signal.aborted) return;
      if (failure instanceof AssistantApiError && (failure.status === 403 || failure.status === 404)) {
        setEntries([]);
        setCursor(null);
        setSettings(undefined);
        setDraft(undefined);
        setEditing(undefined);
        setRemoving(undefined);
      }
      setError(describeError(failure, "暂时无法保存，请重试。"));
    } finally {
      if (!signal.aborted) {
        pending.current = false;
        setBusy(false);
      }
    }
  }

  async function loadEntries(signal: AbortSignal, after?: string) {
    const page = await client.listMemories(projectId, { limit: PAGE_SIZE, cursor: after }, signal);
    if (signal.aborted) return;
    setEntries((current) => after ? [...current, ...page.items.filter((entry) => !current.some(({ id }) => id === entry.id))]
      : page.items);
    setCursor(page.nextCursor);
  }

  async function saveSettings(event: FormEvent) {
    event.preventDefault();
    if (!draft || !settings || (draftInstructions !== undefined && [...draftInstructions].length > TEXT_LIMIT)) return;
    const patch: Schemas["PersonalMemorySettingsPatch"] = {};
    if (draft.enabled !== settings.enabled) patch.enabled = draft.enabled;
    if ("referenceHistory" in draft && "referenceHistory" in settings) {
      if (draft.referenceHistory !== settings.referenceHistory) patch.referenceHistory = draft.referenceHistory;
      if (draft.instructions !== settings.instructions) patch.instructions = draft.instructions;
    }
    if (!Object.keys(patch).length) return;
    await operate(async (signal) => {
      const saved = await client.updateMemorySettings(patch, projectId, signal);
      if (signal.aborted) return;
      setSettings(saved);
      setDraft(saved);
      setNotice("设置已保存。");
      if (saved.enabled) await loadEntries(signal);
      else {
        setEntries([]);
        setCursor(null);
        setContent("");
        setEditing(undefined);
        setRemoving(undefined);
      }
    });
  }

  async function addEntry(event: FormEvent) {
    event.preventDefault();
    if (!settings?.enabled || !content.trim() || [...content].length > TEXT_LIMIT) return;
    await operate(async (signal) => {
      await client.createMemory(content, projectId, signal);
      if (signal.aborted) return;
      setContent("");
      await loadEntries(signal);
      if (!signal.aborted) setNotice("记忆已添加。");
    });
  }

  async function editEntry(event: FormEvent) {
    event.preventDefault();
    if (!settings?.enabled || !editing || !editing.content.trim() || [...editing.content].length > TEXT_LIMIT) return;
    await operate(async (signal) => {
      await client.replaceMemory(editing.id, editing.content, projectId, signal);
      if (signal.aborted) return;
      setEditing(undefined);
      await loadEntries(signal);
      if (!signal.aborted) setNotice("记忆已更新。");
    });
  }

  return <Modal label={title} className="action-dialog resource-dialog" close={close} returnFocus={returnFocus}>
    <h2>{title}</h2>
    {project && <p>{project.name}</p>}
    <p>保存的条目可在这里管理。参与聊天取决于当前模型和工作空间权限。</p>
    {offline && <p role="status">联网后可读取记忆设置。</p>}
    {busy && !settings && <p role="status">正在读取设置…</p>}
    {error && <p role="alert" className="error-box">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {error && !settings && <button type="button" className="button secondary" disabled={busy || offline}
      onClick={() => setRevision((current) => current + 1)}>重新读取</button>}
    {draft && <form className="account-data-section" onSubmit={(event) => void saveSettings(event)}>
      <label className="memory-toggle"><input type="checkbox" checked={draft.enabled} disabled={busy || offline} onChange={(event) => {
        setDraft({ ...draft, enabled: event.target.checked });
      }} /> 启用{project ? "项目" : "个人"}记忆</label>
      {"referenceHistory" in draft && <>
        <label className="memory-toggle"><input type="checkbox" checked={draft.referenceHistory} disabled={busy || offline} onChange={(event) => {
          setDraft({ ...draft, referenceHistory: event.target.checked });
        }} /> 允许引用聊天历史</label>
        <label className="dialog-field">自定义指令
          <textarea rows={4} value={draft.instructions} readOnly={busy || offline} onChange={(event) => {
            setDraft({ ...draft, instructions: event.target.value });
          }} />
        </label>
        <p className="list-notice">{draftInstructions !== undefined && [...draftInstructions].length > TEXT_LIMIT
          ? "指令超出 2,000 个字符。" : "最多 2,000 个字符。清空后保存可移除旧指令。"}</p>
      </>}
      <div className="dialog-actions">
        <button className="button primary" type="submit" disabled={busy || offline ||
          (draftInstructions !== undefined && [...draftInstructions].length > TEXT_LIMIT)}>保存设置</button>
      </div>
    </form>}
    {settings?.enabled && draft?.enabled && <section aria-label="已保存记忆" className="account-data-section">
      <h3>已保存记忆</h3>
      {!entries.length && <p>暂无记忆条目。</p>}
      <ul className="private-record-list">
        {entries.map((entry) => <li key={entry.id}>
          <p className="resource-text">{entry.content}</p>
          <div className="dialog-actions">
            <button type="button" className="button secondary" disabled={busy || offline || !!removing || !!editing}
              onClick={() => setEditing({ id: entry.id, content: entry.content })}>编辑记忆</button>
            <button type="button" className="button secondary" disabled={busy || offline || !!removing || !!editing}
              onClick={() => setRemoving(entry)}>删除记忆</button>
          </div>
        </li>)}
      </ul>
      {removing && <div aria-label="删除记忆确认">
        <p>永久删除选中的记忆？</p>
        <button type="button" className="button secondary" disabled={busy} onClick={() => setRemoving(undefined)}>取消</button>
        <button type="button" className="button secondary danger-text" disabled={busy || offline} onClick={() => void operate(async (signal) => {
          await client.deleteMemory(removing.id, projectId, signal);
          if (signal.aborted) return;
          setEntries((current) => current.filter(({ id }) => id !== removing.id));
          setRemoving(undefined);
          setNotice("记忆已删除。");
        })}>确认删除</button>
      </div>}
      {cursor && <button className="button secondary" type="button" disabled={busy || offline}
        onClick={() => void operate((signal) => loadEntries(signal, cursor))}>加载更多记忆</button>}
      {editing ? <form onSubmit={(event) => void editEntry(event)}>
        <label className="dialog-field">修改记忆
          <textarea rows={3} autoFocus value={editing.content} readOnly={busy || offline} onChange={(event) => {
            setEditing({ ...editing, content: event.target.value });
          }} />
        </label>
        {[...editing.content].length > TEXT_LIMIT && <p role="status">记忆超出 2,000 个字符。</p>}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={() => setEditing(undefined)}>取消编辑</button>
          <button type="submit" className="button primary" disabled={busy || offline || !editing.content.trim() ||
            [...editing.content].length > TEXT_LIMIT}>保存记忆</button>
        </div>
      </form> : <form onSubmit={(event) => void addEntry(event)}>
        <label className="dialog-field">新记忆
          <textarea rows={3} value={content} readOnly={busy || offline} onChange={(event) => setContent(event.target.value)} />
        </label>
        {[...content].length > TEXT_LIMIT && <p role="status">记忆超出 2,000 个字符。</p>}
        <div className="dialog-actions">
          <button className="button primary" type="submit" disabled={busy || offline || !content.trim() ||
            [...content].length > TEXT_LIMIT}>添加记忆</button>
        </div>
      </form>}
    </section>}
    {settings && !settings.enabled && <p className="list-notice">关闭后暂停读写记忆。重新启用后，可查看之前保留的条目。</p>}
    <div className="dialog-actions"><button type="button" className="button secondary" onClick={close}>关闭</button></div>
  </Modal>;
}
