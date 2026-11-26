"use client";

import { Download, Plus, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import type { AssistantClient, components } from "@ai-assistant/contracts";
import { downloadBlob } from "@/lib/assistant";
import { AnalysisPanel } from "./analysis-panel";
import { Modal } from "./modal";

type Resource = components["schemas"]["ProjectResource"];
type ResourceSummary = components["schemas"]["ProjectResourceSummary"];
type Project = components["schemas"]["Project"];
const MAX_BYTES = 16 * 1024;
const encoder = new TextEncoder();

export function ProjectResources({ project, client, offline, analysisAvailable, close, returnFocus, describeError }: {
  project: Project;
  client: AssistantClient;
  offline: boolean;
  analysisAvailable: boolean;
  close: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [items, setItems] = useState<ResourceSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Resource>();
  const [pending, setPending] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const analysisTrigger = useRef<HTMLButtonElement>(null);
  const active = useRef(false);
  const revision = useRef(0);
  const lock = useRef(false);
  const fileRead = useRef(0);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; revision.current += 1; fileRead.current += 1; };
  }, []);

  const load = useCallback(async (q: string, after?: string) => {
    const request = ++revision.current;
    setLoading(true);
    setError("");
    if (!after) setCursor(null);
    try {
      const page = await client.listProjectResources(project.id, { q: q || undefined, limit: 20, cursor: after });
      if (request !== revision.current) return;
      setItems((known) => after ? [...known, ...page.items.filter((item) => !known.some(({ id }) => id === item.id))] : page.items);
      setCursor(page.nextCursor);
    } catch (failure) {
      if (request === revision.current) setError(describeError(failure, "暂时无法读取项目资料。"));
    } finally {
      if (request === revision.current) setLoading(false);
    }
  }, [client, describeError, project.id]);

  useEffect(() => {
    if (!offline) void load(filter);
    else { revision.current += 1; setLoading(false); }
  }, [filter, load, offline]);

  async function run(label: string, operation: () => Promise<void>, failureNote: string) {
    if (offline || lock.current) return;
    lock.current = true;
    setPending(label);
    setError("");
    setNotice("");
    try { await operation(); }
    catch (failure) { if (active.current) setError(describeError(failure, failureNote)); }
    finally {
      lock.current = false;
      if (active.current) setPending(undefined);
    }
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = query.trim();
    if ([...text].length > 100) { setError("检索内容最多 100 个字符。"); return; }
    setSelected(undefined);
    setRemoving(false);
    if (text === filter) void load(text);
    else setFilter(text);
  }

  async function readFile(file?: File) {
    const version = ++fileRead.current;
    if (!file) return;
    setError("");
    const types = analysisAvailable ? /\.(txt|csv)$/i : /\.txt$/i;
    if (!types.test(file.name) || file.size > MAX_BYTES) {
      setError(analysisAvailable ? "请选择 16 KiB 以内的 UTF-8 .txt 或 .csv 文件。" : "请选择 16 KiB 以内的 UTF-8 .txt 文件。");
      return;
    }
    try {
      const value = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      if (!active.current || fileRead.current !== version) return;
      setName((previous) => previous || file.name);
      setContent(value);
    } catch {
      if (active.current && fileRead.current === version) setError("无法将该文件读取为 UTF-8 文本。");
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = name.trim();
    if (!title || [...title].length > 120 || !content.trim() || encoder.encode(content).length > MAX_BYTES) {
      setError("请填写资料名称和文本。名称最多 120 个字符，文件最多 16 KiB。");
      return;
    }
    void run("save", async () => {
      const saved = await client.createProjectResource(project.id, { name: title, content });
      if (!active.current) return;
      setName("");
      setContent("");
      setAdding(false);
      setSelected(saved);
      setQuery("");
      setFilter("");
      setNotice("资料已保存。");
      if (!filter) await load("");
    }, "暂时无法确认保存结果，请先刷新资料列表。");
  }

  function remove() {
    if (!selected || !removing) return;
    void run("delete", async () => {
      await client.deleteProjectResource(project.id, selected.id);
      if (!active.current) return;
      setRemoving(false);
      setSelected(undefined);
      setNotice("资料已删除。");
      await load(filter);
    }, "暂时无法删除资料。");
  }

  return <Modal label="项目资料" className="action-dialog resource-dialog" close={close} returnFocus={returnFocus}>
    <h2>项目资料</h2>
    <p>{project.name}</p>
    <form onSubmit={search}>
      <label className="dialog-field">检索资料<input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="dialog-actions">
        <button type="submit" className="button secondary" disabled={offline || loading || !!pending}><Search size={16} aria-hidden="true" /> 检索</button>
        {!adding && <button type="button" className="button primary" disabled={offline || !!pending} onClick={() => {
          setAdding(true); setRemoving(false); setSelected(undefined); setError(""); setNotice("");
        }}><Plus size={17} aria-hidden="true" /> 添加资料</button>}
      </div>
    </form>
    {offline && <p role="status">联网后可读取项目资料。</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {adding && <form className="resource-detail" onSubmit={save}>
      <label className="dialog-field">资料名称<input value={name} onChange={(event) => setName(event.target.value)} required maxLength={240} /></label>
      <label className="dialog-field">选择 UTF-8 文本文件<input type="file" accept={analysisAvailable ? ".txt,.csv,text/plain,text/csv" : ".txt,text/plain"}
        disabled={!!pending} onChange={(event) => void readFile(event.target.files?.[0])} /></label>
      <label className="dialog-field">资料文本<textarea value={content} rows={5} required onChange={(event) => { fileRead.current += 1; setContent(event.target.value); }} /></label>
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={!!pending} onClick={() => { setAdding(false); fileRead.current += 1; }}>取消</button>
        <button type="submit" className="button primary" disabled={offline || !!pending}>{pending === "save" ? "正在保存…" : "保存资料"}</button>
      </div>
    </form>}
    {loading && <p role="status">正在读取资料…</p>}
    {!loading && !items.length && !error && !offline && <p>暂无匹配资料。</p>}
    <ul aria-label="资料列表" className="workspace-options">
      {items.map((item) => <li key={item.id}><button className="button conversation" type="button" disabled={offline || !!pending}
        aria-current={selected?.id === item.id ? "true" : undefined} onClick={() => {
          setAdding(false); setRemoving(false); setSelected(undefined); fileRead.current += 1;
          void run(item.id, async () => {
            const next = await client.getProjectResource(project.id, item.id);
            if (active.current) setSelected(next);
          }, "暂时无法读取资料文本。");
        }}>{item.name}</button></li>)}
    </ul>
    {selected && <section className="resource-detail" aria-label="资料内容">
      <h3>{selected.name}</h3>
      <p className="resource-text">{selected.content}</p>
      {removing && <p>删除这份项目资料？</p>}
      <div className="dialog-actions">
        {removing ? <>
          <button className="button secondary" type="button" disabled={!!pending} onClick={() => setRemoving(false)}>取消删除</button>
          <button className="button danger" type="button" disabled={offline || !!pending} onClick={remove}>确认删除</button>
        </> : <>
          <button className="button secondary" type="button" disabled={offline || !!pending} onClick={() => {
            void run("download", async () => {
              const verified = await client.getProjectResource(project.id, selected.id);
              if (!active.current) return;
              const filename = verified.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80) || "项目资料";
              downloadBlob(/\.txt$/i.test(filename) ? filename : `${filename}.txt`, new Blob([verified.content], { type: "text/plain;charset=UTF-8" }));
            }, "暂时无法下载这份资料。");
          }}><Download size={16} aria-hidden="true" /> 下载文本</button>
          {analysisAvailable && <button ref={analysisTrigger} type="button" className="button secondary" disabled={offline || !!pending}
            onClick={() => setAnalysisOpen(true)}>分析 CSV</button>}
          <button className="button danger-text" type="button" disabled={offline || !!pending} onClick={() => setRemoving(true)}><Trash2 size={16} aria-hidden="true" /> 删除资料</button>
        </>}
      </div>
    </section>}
    <div className="dialog-actions">
      {cursor && <button className="button" type="button" disabled={offline || loading || !!pending} onClick={() => void load(filter, cursor)}>加载更多</button>}
      <button className="button secondary" type="button" onClick={close}>关闭</button>
    </div>
    {analysisOpen && selected && <AnalysisPanel client={client} offline={offline} projectId={project.id} resourceId={selected.id}
      name={selected.name} close={() => setAnalysisOpen(false)} returnFocus={analysisTrigger} describeError={describeError} />}
  </Modal>;
}
