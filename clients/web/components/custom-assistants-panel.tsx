"use client";

import { RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import { idempotencyKey } from "@/lib/assistant";
import { Modal } from "./modal";

type Schemas = components["schemas"];
type Assistant = Schemas["CustomAssistant"];
type ListItem = Schemas["CustomAssistantListItem"];
type Version = Schemas["CustomAssistantVersion"];
type Project = Schemas["Project"];
type Material = Schemas["ProjectResourceSummary"];
type Draft = { name: string; instructions: string; projectId: string; resourceIds: string[]; lookup: boolean };
const EMPTY: Draft = { name: "", instructions: "", projectId: "", resourceIds: [], lookup: false };
const LOOKUP = "project_resource_lookup";
const date = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });

export function CustomAssistantsPanel({ client, offline, close, returnFocus, describeError }: {
  client: AssistantClient;
  offline: boolean;
  close: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [items, setItems] = useState<ListItem[]>([]);
  const [itemCursor, setItemCursor] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectCursor, setProjectCursor] = useState<string | null>(null);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [materialCursor, setMaterialCursor] = useState<string | null>(null);
  const [versions, setVersions] = useState<Version[]>([]);
  const [assistant, setAssistant] = useState<Assistant>();
  const [viewVersion, setViewVersion] = useState<Version>();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef<AbortController | null>(null);
  const retry = useRef<{ payload: string; key: string }>(undefined);

  async function lists(signal: AbortSignal) {
    const [definitions, ownedProjects] = await Promise.all([
      client.listCustomAssistants({ limit: 16 }, signal), client.listProjects({ limit: 20 }, signal),
    ]);
    if (signal.aborted) return;
    setItems(definitions.items);
    setItemCursor(definitions.nextCursor);
    setProjects(ownedProjects.items);
    setProjectCursor(ownedProjects.nextCursor);
  }

  useEffect(() => {
    const request = new AbortController();
    if (offline) {
      pending.current = null;
      setBusy(false);
      return;
    }
    pending.current = request;
    setBusy(true);
    setError("");
    void lists(request.signal).catch((failure) => {
      if (!request.signal.aborted) setError(describeError(failure, "暂时无法读取定制助手。"));
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
  }, [client, describeError, offline]);

  async function act(run: (signal: AbortSignal) => Promise<void>, fallback: string) {
    if (pending.current || offline) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await run(request.signal);
    } catch (failure) {
      if (!request.signal.aborted) {
        setError(failure instanceof AssistantApiError && failure.status === 409
          ? "版本或所选资料已变化。请刷新并核对后重试。" : describeError(failure, fallback));
      }
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  async function loadMaterials(projectId: string, signal: AbortSignal, after?: string) {
    const page = projectId ? await client.listProjectResources(projectId, { limit: 20, cursor: after }, signal) : undefined;
    if (signal.aborted) return;
    const found = page?.items ?? [];
    setMaterials((known) => after ? [...known, ...found.filter((item) => !known.some(({ id }) => item.id === id))] : found);
    setMaterialCursor(page?.nextCursor ?? null);
  }

  async function select(item: Assistant, signal: AbortSignal) {
    if (signal.aborted) return;
    const head = item.head;
    setAssistant(item);
    setDraft({ name: head.name, instructions: head.instructions, projectId: item.projectId ?? "",
      resourceIds: head.resourceIds, lookup: head.tools.includes(LOOKUP) });
    setViewVersion(undefined);
    setRestoring(false);
    setDeleting(false);
    setVersions([]);
    setMaterials([]);
    setMaterialCursor(null);
    const [history] = await Promise.all([
      client.listCustomAssistantVersions(item.id, { limit: 20 }, signal),
      loadMaterials(item.projectId ?? "", signal),
    ]);
    if (!signal.aborted) setVersions(history.items);
  }

  function clear() {
    setAssistant(undefined);
    setViewVersion(undefined);
    setRestoring(false);
    setDeleting(false);
    setVersions([]);
    setMaterials([]);
    setMaterialCursor(null);
    setDraft(EMPTY);
    setNotice("");
    setError("");
  }

  function save(event: FormEvent) {
    event.preventDefault();
    const name = draft.name.trim();
    if (!name || [...name].length > 120 || [...draft.instructions].length > 2000 ||
      (draft.lookup && !draft.resourceIds.length)) return;
    const input: Schemas["CustomAssistantContent"] = {
      name, instructions: draft.instructions, resourceIds: draft.resourceIds,
      tools: draft.lookup ? [LOOKUP] : [],
    };
    void act(async (signal) => {
      let result: Assistant;
      if (assistant) {
        result = await client.createCustomAssistantVersion(assistant.id, { ...input, baseVersionId: assistant.head.id }, signal);
      } else {
        const create = { ...input, projectId: draft.projectId || undefined };
        const payload = JSON.stringify(create);
        const prior = retry.current;
        const key = prior && prior.payload === payload ? prior.key : idempotencyKey();
        retry.current = { payload, key };
        result = await client.createCustomAssistant(create, key, signal);
        if (!signal.aborted) retry.current = undefined;
      }
      await select(result, signal);
      await lists(signal);
      if (!signal.aborted) setNotice(`已保存版本 ${result.head.number}。`);
    }, "暂时无法保存定制助手。");
  }

  function rollback() {
    if (!assistant || !viewVersion) return;
    void act(async (signal) => {
      const result = await client.rollbackCustomAssistant(assistant.id, {
        baseVersionId: assistant.head.id, versionId: viewVersion.id,
      }, signal);
      await select(result, signal);
      await lists(signal);
      if (!signal.aborted) setNotice(`已从版本 ${viewVersion.number} 创建版本 ${result.head.number}。`);
    }, "暂时无法还原版本。");
  }

  const unavailable = draft.resourceIds.filter((id) => !materials.some((item) => item.id === id));
  const busyOrOffline = busy || offline;
  return <Modal label="定制助手" className="action-dialog resource-dialog" close={close} returnFocus={returnFocus}>
    <h2>定制助手</h2>
    {offline && <p role="status">联网后可查看当前版本。</p>}
    {busy && <p role="status">正在同步…</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button type="button" className="button secondary" disabled={busyOrOffline} onClick={() => void act(async (signal) => {
        await lists(signal);
        if (!signal.aborted && assistant) await select(await client.getCustomAssistant(assistant.id, signal), signal);
      }, "暂时无法刷新定制助手。")}><RefreshCw size={16} aria-hidden="true" /> 刷新</button>
      <button type="button" className="button secondary" disabled={busy} onClick={clear}>新建定制助手</button>
    </div>
    {!!items.length && <section className="account-data-section" aria-label="已保存定制助手">
      <ul className="private-record-list">{items.map((item) => <li key={item.id}>
        <button type="button" className="button secondary" disabled={busyOrOffline} aria-pressed={assistant?.id === item.id}
          onClick={() => void act(async (signal) => select(await client.getCustomAssistant(item.id, signal), signal),
            "暂时无法打开定制助手。")}>
          {item.name} · 版本 {item.headVersionNumber}{item.status === "requires_review" && " · 待核对"}
        </button>
      </li>)}</ul>
      {itemCursor && <button type="button" className="button secondary" disabled={busyOrOffline}
        onClick={() => void act(async (signal) => {
          const page = await client.listCustomAssistants({ limit: 16, cursor: itemCursor }, signal);
          if (signal.aborted) return;
          setItems((known) => [...known, ...page.items.filter((item) => !known.some(({ id }) => id === item.id))]);
          setItemCursor(page.nextCursor);
        }, "暂时无法读取更多定制助手。")}>加载更多定制助手</button>}
    </section>}
    <form className="account-data-section" onSubmit={save}>
      <label className="dialog-field">助手名称
        <input value={draft.name} readOnly={busyOrOffline} required onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
      </label>
      <label className="dialog-field">助手指令
        <textarea rows={4} value={draft.instructions} readOnly={busyOrOffline}
          onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} />
      </label>
      <label className="dialog-field">绑定私有项目
        <select value={draft.projectId} disabled={busyOrOffline || !!assistant} onChange={(event) => {
          const projectId = event.target.value;
          setDraft({ ...draft, projectId, lookup: false, resourceIds: [] });
          setMaterials([]);
          setMaterialCursor(null);
          void act((signal) => loadMaterials(projectId, signal), "暂时无法读取项目资料。");
        }}>
          <option value="">不绑定项目</option>
          {draft.projectId && !projects.some(({ id }) => id === draft.projectId) && <option value={draft.projectId}>已绑定项目</option>}
          {projects.map(({ id, name }) => <option value={id} key={id}>{name}</option>)}
        </select>
      </label>
      {!assistant && projectCursor && <button className="button secondary" type="button" disabled={busyOrOffline}
        onClick={() => void act(async (signal) => {
          const page = await client.listProjects({ limit: 20, cursor: projectCursor }, signal);
          if (signal.aborted) return;
          setProjects((known) => [...known, ...page.items.filter((item) => !known.some(({ id }) => id === item.id))]);
          setProjectCursor(page.nextCursor);
        }, "暂时无法读取更多项目。")}>加载更多项目</button>}
      {draft.projectId && <fieldset className="research-source-options">
        <legend>私有知识资料（最多 8 项）</legend>
        {!materials.length && !busy && <p>当前项目暂无可用文本资料。</p>}
        {materials.map((item) => {
          const added = draft.resourceIds.includes(item.id);
          return <label className="memory-toggle" key={item.id}>
            <input type="checkbox" checked={added} disabled={busyOrOffline || (!added && draft.resourceIds.length >= 8)}
              onChange={() => setDraft({ ...draft, resourceIds: added ? draft.resourceIds.filter((id) => id !== item.id)
                : [...draft.resourceIds, item.id] })} /> {item.name}
          </label>;
        })}
        {materialCursor && <button className="button secondary" type="button" disabled={busyOrOffline}
          onClick={() => void act((signal) => loadMaterials(draft.projectId, signal, materialCursor), "暂时无法读取更多资料。")}>
          加载更多资料
        </button>}
        {!!unavailable.length && !materialCursor && <button className="button secondary" type="button" disabled={busyOrOffline}
          onClick={() => setDraft({ ...draft, resourceIds: draft.resourceIds.filter((id) => !unavailable.includes(id)) })}>
          移除 {unavailable.length} 项不可用引用
        </button>}
        <label className="memory-toggle"><input type="checkbox" checked={draft.lookup} disabled={busyOrOffline}
          onChange={(event) => setDraft({ ...draft, lookup: event.target.checked })} /> 允许检索所选项目资料</label>
        {draft.lookup && !draft.resourceIds.length && <p>启用检索时至少需要选一项资料。</p>}
      </fieldset>}
      <div className="dialog-actions">
        <button type="submit" className="button primary" disabled={busyOrOffline || !draft.name.trim() ||
          [...draft.name.trim()].length > 120 || [...draft.instructions].length > 2000 ||
          (draft.lookup && !draft.resourceIds.length)}>{assistant ? "保存新版本" : "创建助手"}</button>
      </div>
    </form>
    {assistant && <section className="account-data-section" aria-label="版本记录">
      <h3>版本记录</h3>
      <ul className="private-record-list">{versions.map((version) => <li key={version.id}>
        <button type="button" className="button secondary" disabled={busyOrOffline} aria-pressed={viewVersion?.id === version.id}
          onClick={() => void act(async (signal) => {
            const current = await client.getCustomAssistantVersion(assistant.id, version.id, signal);
            if (!signal.aborted) { setViewVersion(current); setRestoring(false); }
          }, "暂时无法读取此版本。")}>版本 {version.number}{version.id === assistant.head.id ? "（当前）" : ""}
          {" · "}{date.format(new Date(version.createdAt))}</button>
      </li>)}</ul>
      {viewVersion && <>
        <p>{viewVersion.name}</p>
        {viewVersion.instructions && <p className="resource-text">{viewVersion.instructions}</p>}
        <p>引用资料 {viewVersion.resourceIds.length} 项{viewVersion.tools.includes(LOOKUP) && " · 已启用资料检索"}</p>
        {(viewVersion.id !== assistant.head.id || assistant.status === "requires_review") &&
          (restoring ? <div className="dialog-actions">
            <button type="button" className="button secondary" disabled={busy} onClick={() => setRestoring(false)}>取消</button>
            <button type="button" className="button primary" disabled={busyOrOffline} onClick={rollback}>确认还原此版本</button>
          </div> : <button type="button" className="button secondary" disabled={busyOrOffline}
            onClick={() => setRestoring(true)}>基于此版本还原</button>)}
      </>}
    </section>}
    <div className="dialog-actions">
      {assistant && !deleting && <button type="button" className="button secondary danger-text" disabled={busyOrOffline}
        onClick={() => setDeleting(true)}>删除定制助手</button>}
      {assistant && deleting && <>
        <p>删除此助手及其版本记录？</p>
        <button type="button" className="button secondary" disabled={busy} onClick={() => setDeleting(false)}>取消</button>
        <button type="button" className="button secondary danger-text" disabled={busyOrOffline}
          onClick={() => void act(async (signal) => {
            await client.deleteCustomAssistant(assistant.id, signal);
            if (signal.aborted) return;
            clear();
            await lists(signal);
          }, "暂时无法删除定制助手。")}>确认删除</button>
      </>}
      <button type="button" className="button secondary" onClick={close}>关闭</button>
    </div>
  </Modal>;
}
