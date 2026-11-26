import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import type { AssistantClient, components } from "@ai-assistant/contracts";
import type { Conversation } from "@/lib/assistant";
import { MemorySettings } from "./memory-settings";
import { Modal } from "./modal";
import { ProjectAttachments, type ProjectAttachmentFormat } from "./project-attachments";
import { ProjectResources } from "./project-resources";

type Project = components["schemas"]["Project"];

type ProjectsPanelProps = {
  client: AssistantClient;
  selectedProjectId?: string | null;
  conversation?: Conversation | null;
  offline?: boolean;
  mode?: "browse" | "move";
  resourcesAvailable?: boolean;
  analysisAvailable?: boolean;
  memoryAvailable?: boolean;
  attachmentsAvailable?: boolean;
  audioAttachmentsAvailable?: boolean;
  audioUploadsAvailable?: boolean;
  pdfAttachmentsAvailable?: boolean;
  pdfUploadsAvailable?: boolean;
  generalPdfAvailable?: boolean;
  pdfOcrAvailable?: boolean;
  localImageEditsAvailable?: boolean;
  close: () => void;
  returnFocus?: RefObject<HTMLElement | null>;
  onSelect: (project: Project | null | undefined) => void;
  onMoved: (conversation: Conversation) => void;
  describeError: (error: unknown, fallback: string) => string;
};

export function ProjectsPanel({ client, selectedProjectId, conversation, offline = false, mode = "browse",
  resourcesAvailable = false, analysisAvailable = false, memoryAvailable = false, attachmentsAvailable = false,
  audioAttachmentsAvailable = false, audioUploadsAvailable = false, pdfAttachmentsAvailable = false, pdfUploadsAvailable = false,
  generalPdfAvailable = false, pdfOcrAvailable = false,
  localImageEditsAvailable = false,
  close, returnFocus, onSelect, onMoved, describeError }: ProjectsPanelProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editor, setEditor] = useState<{ project?: Project }>();
  const [resourceProject, setResourceProject] = useState<Project>();
  const resourcesTrigger = useRef<HTMLButtonElement>(null);
  const [memoryProject, setMemoryProject] = useState<Project>();
  const memoryTrigger = useRef<HTMLButtonElement>(null);
  const [attachmentProject, setAttachmentProject] = useState<{ project: Project; kind: ProjectAttachmentFormat }>();
  const attachmentTrigger = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  const operation = useRef(false);
  const listVersion = useRef(0);
  const editTrigger = useRef<HTMLButtonElement | null>(null);
  const browsing = mode === "browse";
  const title = browsing ? "项目" : "移动对话到项目";

  const load = useCallback(async (after?: string) => {
    const version = ++listVersion.current;
    setLoading(true);
    setError("");
    try {
      const page = await client.listProjects({ limit: 20, cursor: after });
      if (version !== listVersion.current) return;
      setProjects((current) => after ? [...current, ...page.items.filter((item) => !current.some(({ id }) => id === item.id))]
        : page.items);
      setCursor(page.nextCursor);
    } catch (failure) {
      if (version === listVersion.current) setError(describeError(failure, "暂时无法读取项目。"));
    } finally {
      if (version === listVersion.current) setLoading(false);
    }
  }, [client, describeError]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      listVersion.current += 1;
    };
  }, [load]);

  async function change(action: () => Promise<void>, fallback: string) {
    if (operation.current || offline) return;
    operation.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (failure) {
      if (mounted.current) setError(describeError(failure, fallback));
    } finally {
      operation.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  function select(project: Project | null | undefined) {
    if (operation.current) return;
    onSelect(project);
    close();
  }

  function closeEditor() {
    if (operation.current) return;
    setEditor(undefined);
    setError("");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const description = String(form.get("description") ?? "");
    if (!name || [...name].length > 120 || [...description].length > 4_000) {
      setError("请输入项目名称。名称最多 120 个字符，说明最多 4,000 个字符。");
      return;
    }
    const id = editor?.project?.id;
    void change(async () => {
      if (id) await client.updateProject(id, { name, description });
      else await client.createProject({ name, description });
      if (!mounted.current) return;
      setEditor(undefined);
      setNotice(id ? "项目已更新。" : "项目已创建。");
      await load();
    }, "暂时无法保存项目。");
  }

  function move(project: Project | null) {
    if (!conversation) return;
    void change(async () => {
      const result = await client.moveConversation(conversation.id, project?.id ?? null);
      if (!mounted.current) return;
      onMoved(result);
      setNotice(project ? `已将对话移入「${project.name}」。` : "对话已移至未归类。");
    }, "暂时无法移动对话。");
  }

  return <Modal label={title} className="action-dialog" returnFocus={returnFocus}
    close={() => { if (!operation.current) close(); }}>
    <h2>{title}</h2>
    {browsing && <section className="account-data-section" aria-label="项目视图">
      <div className="dialog-actions">
        <button type="button" className="button secondary" aria-pressed={selectedProjectId === undefined}
          disabled={busy} onClick={() => select(undefined)}>全部对话</button>
        <button type="button" className="button secondary" aria-pressed={selectedProjectId === null}
          disabled={busy} onClick={() => select(null)}>未归类</button>
        <button type="button" className="button primary" aria-disabled={offline || busy || undefined}
          onClick={(event) => {
            if (offline || operation.current) return;
            editTrigger.current = event.currentTarget;
            setError("");
            setEditor({});
          }}>新建项目</button>
      </div>
    </section>}
    {!browsing && !conversation && <p>请先打开要移动的对话。</p>}
    {conversation && <p>当前对话：{conversation.title}</p>}
    {notice && <p role="status" className="history-notice">{notice}</p>}
    {error && !editor && <p role="alert" className="error-box">{error}</p>}
    {loading && <p role="status" className="history-notice">正在读取项目…</p>}
    {!loading && !error && !projects.length && <p className="history-notice">暂无项目。</p>}
    <div className="account-data-section">
      {projects.map((project) => <section key={project.id} className="account-data-section" aria-label={project.name}>
        {browsing ? <button type="button" className="button conversation" aria-pressed={selectedProjectId === project.id}
          disabled={busy} onClick={() => select(project)}>{project.name}</button> : <h3>{project.name}</h3>}
        {project.description && <p className="history-notice">{project.description}</p>}
        <div className="dialog-actions">
          {browsing && resourcesAvailable && <button className="button secondary" type="button" disabled={busy}
            aria-label={`查看项目资料 ${project.name}`} onClick={(event) => {
              resourcesTrigger.current = event.currentTarget;
              setResourceProject(project);
            }}>资料</button>}
          {browsing && memoryAvailable && <button type="button" className="button secondary" disabled={busy}
            aria-label={`查看项目记忆 ${project.name}`} onClick={(event) => {
              memoryTrigger.current = event.currentTarget;
              setMemoryProject(project);
            }}>记忆</button>}
          {browsing && attachmentsAvailable && <button type="button" className="button secondary" disabled={busy}
            aria-label={`查看项目图像 ${project.name}`} onClick={(event) => {
              attachmentTrigger.current = event.currentTarget;
              setAttachmentProject({ project, kind: "png" });
            }}>图像</button>}
          {browsing && audioAttachmentsAvailable && <button type="button" className="button secondary" disabled={busy}
            aria-label={`查看项目音频 ${project.name}`} onClick={(event) => {
              attachmentTrigger.current = event.currentTarget;
              setAttachmentProject({ project, kind: "wav" });
            }}>音频</button>}
          {browsing && pdfAttachmentsAvailable && <button type="button" className="button secondary" disabled={busy}
            aria-label={`查看项目 PDF ${project.name}`} onClick={(event) => {
              attachmentTrigger.current = event.currentTarget;
              setAttachmentProject({ project, kind: "pdf" });
            }}>PDF</button>}
          {browsing && <button type="button" className="button secondary" aria-label={`编辑项目 ${project.name}`}
            aria-disabled={offline || busy || undefined} onClick={(event) => {
              if (offline || operation.current) return;
              editTrigger.current = event.currentTarget;
              void change(async () => {
                const current = await client.getProject(project.id);
                if (mounted.current) setEditor({ project: current });
              }, "暂时无法读取项目详情。");
            }}>编辑</button>}
          {conversation && <button type="button" className="button secondary" aria-label={`将对话移入 ${project.name}`}
            disabled={busy || offline || conversation.projectId === project.id} onClick={() => move(project)}>移入</button>}
        </div>
      </section>)}
      {cursor && <button type="button" className="button secondary load-more" disabled={loading || busy || offline}
        onClick={() => void load(cursor)}>加载更多项目</button>}
      {error && !editor && !loading && <button type="button" className="button link-button" disabled={busy || offline}
        onClick={() => void load()}>重新读取项目</button>}
      {conversation?.projectId && <button type="button" className="button secondary" disabled={busy || offline}
        onClick={() => move(null)}>移至未归类</button>}
    </div>
    <div className="dialog-actions">
      <button type="button" className="button secondary" disabled={busy} onClick={close}>关闭</button>
    </div>

    {memoryProject && <MemorySettings key={memoryProject.id} client={client} project={memoryProject} offline={offline}
      describeError={describeError} returnFocus={memoryTrigger} close={() => setMemoryProject(undefined)} />}
    {attachmentProject && <ProjectAttachments key={`${attachmentProject.project.id}/${attachmentProject.kind}`}
      client={client} project={attachmentProject.project} kind={attachmentProject.kind}
      canEditPng={localImageEditsAvailable} generalPdf={generalPdfAvailable} pdfOcr={pdfOcrAvailable}
      openAudio={audioUploadsAvailable && !offline && attachmentProject.kind === "png"
        ? () => setAttachmentProject({ project: attachmentProject.project, kind: "wav" }) : undefined}
      uploadsAllowed={attachmentProject.kind === "png" || (attachmentProject.kind === "wav" ? audioUploadsAvailable : pdfUploadsAvailable)}
      offline={offline} describeError={describeError} returnFocus={attachmentTrigger}
      close={() => setAttachmentProject(undefined)} />}
    {editor && <Modal label={editor.project ? "编辑项目" : "新建项目"} className="action-dialog"
      returnFocus={editTrigger} close={closeEditor}>
      <form onSubmit={submit}>
        <h2>{editor.project ? "编辑项目" : "新建项目"}</h2>
        <label className="dialog-field">项目名称
          <input name="name" defaultValue={editor.project?.name ?? ""} required autoFocus readOnly={busy} />
        </label>
        <label className="dialog-field">项目说明
          <textarea name="description" defaultValue={editor.project?.description ?? ""} rows={4} readOnly={busy} />
        </label>
        {error && <p role="alert" className="error-box">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={closeEditor}>取消</button>
          <button type="submit" className="button primary" disabled={busy || offline}>{busy ? "正在保存…" : "保存"}</button>
        </div>
      </form>
    </Modal>}
    {resourceProject && <ProjectResources key={resourceProject.id} project={resourceProject} client={client} offline={offline}
      analysisAvailable={analysisAvailable} close={() => setResourceProject(undefined)} returnFocus={resourcesTrigger} describeError={describeError} />}
  </Modal>;
}
