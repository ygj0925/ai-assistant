"use client";

import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import { downloadBlob, idempotencyKey } from "@/lib/assistant";
import { codeDownloadName, codeDraft, codeDraftError, CodeDraftEditor, CodeDraftView } from "./code-draft-editor";
import { imageAssetDraft, imageAssetError, ImageAssetEditor, ImageAssetView } from "./image-asset-editor";
import { HostedSite } from "./hosted-site";
import { Modal } from "./modal";
import { presentationDraft, presentationError, PresentationEditor, PresentationView } from "./presentation-editor";
import { serializeSpreadsheet, spreadsheetDraft, SpreadsheetEditor, SpreadsheetView } from "./spreadsheet-editor";
import { useWebsiteSandboxSupport, websiteDraft, websiteDraftError, WebsiteDraftEditor, WebsiteDraftView,
  WebsiteSandbox } from "./website-draft-editor";

type Schemas = components["schemas"];
type Draft = { title: string; content: string; format: Schemas["ArtifactFormat"]; projectId: string };
type Artifact = Schemas["Artifact"];
type Version = Schemas["ArtifactVersion"];
type Source = { id: string; title: string; content: string };
const byteLimit = 32768;
const createLabels: Record<Schemas["ArtifactFormat"], string> = {
  text: "创建文稿", markdown: "创建文稿", sheet: "创建表格", slides: "创建幻灯片", code: "创建代码稿", webpage: "创建网页草案",
  image: "创建图片资产",
};

function versionText(version: Version): string {
  return "content" in version ? version.content : "";
}

function versionSheet(version: Version) {
  return "sheet" in version ? version.sheet : undefined;
}

function versionPresentation(version: Version) {
  return "presentation" in version ? version.presentation : undefined;
}

function versionCode(version: Version) {
  return "code" in version ? version.code : undefined;
}

function versionWebsite(version: Version) {
  return "website" in version ? version.website : undefined;
}

function versionImage(version: Version) {
  return "image" in version ? version.image : undefined;
}

function VersionContent({ version }: { version: Version }) {
  const sheet = versionSheet(version);
  if (sheet) return <SpreadsheetView sheet={sheet} />;
  const presentation = versionPresentation(version);
  if (presentation) return <PresentationView deck={presentation} />;
  const code = versionCode(version);
  if (code) return <CodeDraftView code={code} />;
  const website = versionWebsite(version);
  if (website) return <WebsiteDraftView website={website} />;
  const image = versionImage(version);
  return image ? <ImageAssetView image={image} /> : <pre className="resource-text">{versionText(version)}</pre>;
}

export function ArtifactsPanel({ client, offline, canPublish, canPublishWebpages, canPublishImages, canHostWebpages, typedPublications, typedFromReply,
  canEditSheets, canEditSlides, canEditCode, canEditWebsites, canEditImages,
  currentProject, source, close, opener, describeError }: {
  client: AssistantClient;
  offline: boolean;
  canPublish: boolean;
  canPublishWebpages: boolean;
  canPublishImages: boolean;
  canHostWebpages: boolean;
  typedPublications: { sheet: boolean; slides: boolean; code: boolean };
  typedFromReply: boolean;
  canEditSheets: boolean;
  canEditSlides: boolean;
  canEditCode: boolean;
  canEditWebsites: boolean;
  canEditImages: boolean;
  currentProject?: string | null;
  source?: Source;
  close: () => void;
  opener: RefObject<HTMLElement | null>;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [artifact, setArtifact] = useState<Artifact>();
  const [retired, setRetired] = useState<Schemas["ArtifactSummary"]>();
  const [reply, setReply] = useState(source);
  const [sheet, setSheet] = useState(() => spreadsheetDraft());
  const [presentation, setPresentation] = useState(() => presentationDraft());
  const [code, setCode] = useState(() => codeDraft());
  const [website, setWebsite] = useState(() => websiteDraft());
  const [image, setImage] = useState(() => imageAssetDraft());
  const [confirmSource, setConfirmSource] = useState(false);
  const [webPreview, setWebPreview] = useState<{ version: number; html: string }>();
  const [imagePreview, setImagePreview] = useState<{ versionId: string; version: number; url: string; alt: string }>();
  const webPreviewSupported = useWebsiteSandboxSupport();
  const [draft, setDraft] = useState<Draft>({
    title: source?.title ?? "", content: source?.content ?? "", format: "markdown", projectId: currentProject ?? "",
  });
  const [listing, setListing] = useState<Schemas["ArtifactPage"]>({ items: [], nextCursor: null });
  const [projects, setProjects] = useState<Schemas["ProjectPage"]>({ items: [], nextCursor: null });
  const [versions, setVersions] = useState<Schemas["ArtifactVersionPage"]>({ items: [], nextCursor: null });
  const [historical, setHistorical] = useState<Version>();
  const [publishing, setPublishing] = useState<Version>();
  const [restore, setRestore] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(true);
  const pending = useRef<AbortController | null>(null);
  const retry = useRef<{ signature: string; key: string }>(undefined);

  useEffect(() => () => { if (imagePreview) URL.revokeObjectURL(imagePreview.url); }, [imagePreview]);

  async function loadList(signal: AbortSignal) {
    const fresh = await client.listArtifacts({ limit: 20, projectId: currentProject ?? undefined }, signal);
    if (!signal.aborted) setListing(fresh);
  }

  useEffect(() => {
    const request = new AbortController();
    setBusy(!offline);
    if (offline) {
      setWebPreview(undefined);
      setImagePreview(undefined);
      setPublishing(undefined);
    }
    if (!offline) {
      pending.current = request;
      setError("");
      void Promise.all([loadList(request.signal), client.listProjects({ limit: 20 }, request.signal)])
        .then(([, owned]) => { if (!request.signal.aborted) setProjects(owned); })
        .catch((failure) => {
          if (!request.signal.aborted) setError(describeError(failure, "暂时无法打开文稿。"));
        }).finally(() => {
          if (pending.current === request) {
            pending.current = null;
            setBusy(false);
          }
        });
    }
    return () => {
      request.abort();
      pending.current?.abort();
      pending.current = null;
    };
  }, [client, currentProject, describeError, offline]);

  async function work(action: (signal: AbortSignal) => Promise<void>, fallback: string) {
    if (pending.current || offline) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setNotice("");
    setError("");
    try {
      await action(request.signal);
    } catch (failure) {
      if (!request.signal.aborted) {
        if (failure instanceof AssistantApiError && [401, 403, 404, 423].includes(failure.status)) {
          setWebPreview(undefined);
          setImagePreview(undefined);
          if (failure.status === 423) reset();
        }
        setError(failure instanceof AssistantApiError && failure.status === 409
          ? "当前版本已变化或已达到数量上限，请刷新核对。" : describeError(failure, fallback));
      }
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  async function review(record: Artifact, signal: AbortSignal) {
    if (signal.aborted) return;
    setArtifact(record);
    setRetired(undefined);
    setReply(undefined);
    setDraft({ title: record.head.title, content: versionText(record.head), format: record.format, projectId: record.projectId ?? "" });
    setSheet(spreadsheetDraft(versionSheet(record.head)));
    setPresentation(presentationDraft(versionPresentation(record.head)));
    setCode(codeDraft(versionCode(record.head)));
    setWebsite(websiteDraft(versionWebsite(record.head)));
    setImage(imageAssetDraft(versionImage(record.head)));
    setWebPreview(undefined);
    setImagePreview(undefined);
    setVersions({ items: [], nextCursor: null });
    setHistorical(undefined);
    setPublishing(undefined);
    setRestore(false);
    setDeleting(false);
    const history = await client.listArtifactVersions(record.id, { limit: 20 }, signal);
    if (!signal.aborted) setVersions(history);
  }

  function reset() {
    setArtifact(undefined);
    setRetired(undefined);
    setReply(undefined);
    setDraft({ title: "", content: "", format: "markdown", projectId: currentProject ?? "" });
    setSheet(spreadsheetDraft());
    setPresentation(presentationDraft());
    setCode(codeDraft());
    setWebsite(websiteDraft());
    setImage(imageAssetDraft());
    setConfirmSource(false);
    setWebPreview(undefined);
    setImagePreview(undefined);
    setVersions({ items: [], nextCursor: null });
    setHistorical(undefined);
    setPublishing(undefined);
    setRestore(false);
    setDeleting(false);
    setNotice("");
    setError("");
  }

  const bytes = new TextEncoder().encode(draft.content).byteLength;
  const title = draft.title.trim();
  const publicationProject = artifact?.projectId;
  const editingSheet = draft.format === "sheet";
  const editingSlides = draft.format === "slides";
  const editingCode = draft.format === "code";
  const editingWebsite = draft.format === "webpage";
  const editingImage = draft.format === "image";
  const generateWebsite = editingWebsite && !!reply && !artifact;
  const textual = draft.format === "text" || draft.format === "markdown";
  const typedReply = !!reply && (editingSheet || editingSlides || editingCode || editingImage);
  const deckError = editingSlides ? presentationError(presentation) : undefined;
  const codeError = editingCode ? codeDraftError(code) : undefined;
  const websiteError = editingWebsite && !generateWebsite ? websiteDraftError(website) : undefined;
  const imageError = editingImage ? imageAssetError(image) : undefined;
  const writable = { text: true, markdown: true, sheet: canEditSheets, slides: canEditSlides, code: canEditCode, webpage: canEditWebsites,
    image: canEditImages };
  const canEditFormat = writable[draft.format];
  const preparedSheet = editingSheet ? serializeSpreadsheet(sheet) : undefined;
  const sheetPayload = preparedSheet?.sheet;
  const invalid = !title || [...title].length > 120 || (!artifact && !reply && !draft.projectId)
    || !canEditFormat || (editingSheet && !sheetPayload) || !!deckError || !!codeError || !!websiteError || !!imageError
    || (textual && bytes > byteLimit) || (typedReply && (!typedFromReply || !confirmSource));
  const locked = busy || offline;
  const currentPayload = sheetPayload ? { sheet: sheetPayload } : editingSlides ? { presentation }
    : editingCode ? { code } : editingWebsite ? { website } : editingImage ? { image } : { content: draft.content };
  const retained = artifact ?? retired;

  function matchesHead(head: Version) {
    if (editingSheet) return JSON.stringify(sheetPayload) === JSON.stringify(versionSheet(head));
    if (editingSlides) return JSON.stringify(presentation) === JSON.stringify(versionPresentation(head));
    if (editingCode) return JSON.stringify(code) === JSON.stringify(versionCode(head));
    if (editingWebsite) return JSON.stringify(website) === JSON.stringify(versionWebsite(head));
    if (editingImage) return JSON.stringify(image) === JSON.stringify(imageAssetDraft(versionImage(head)));
    return draft.content === versionText(head);
  }

  const unchanged = !!artifact && title === artifact.head.title && matchesHead(artifact.head);

  function createInput(): Schemas["ArtifactCreate"] {
    const location = { title, projectId: draft.projectId };
    const typedLocation = reply
      ? { title, projectId: draft.projectId || undefined, sourceMessageId: reply.id, confirmSource: true as const }
      : location;
    if (sheetPayload) return { ...typedLocation, format: "sheet", sheet: sheetPayload };
    if (editingSlides) return { ...typedLocation, format: "slides", presentation };
    if (editingCode) return { ...typedLocation, format: "code", code };
    if (editingWebsite) {
      return reply ? { title, format: "webpage", sourceMessageId: reply.id } : { ...location, format: "webpage", website };
    }
    if (editingImage) return { ...typedLocation, format: "image", image };
    return { title, content: draft.content, format: draft.format === "text" ? "text" : "markdown",
      projectId: reply ? undefined : draft.projectId || undefined, sourceMessageId: reply?.id };
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (invalid || unchanged) return;
    void work(async (signal) => {
      let written: Artifact;
      if (artifact) {
        written = await client.createArtifactVersion(artifact.id, { baseVersionId: artifact.head.id, title, ...currentPayload }, signal);
      } else if (retired) {
        written = await client.createArtifactVersion(retired.id, { baseVersionId: retired.headVersionId, title, image }, signal);
      } else {
        const input = createInput();
        const signature = JSON.stringify(input);
        const saved = retry.current;
        const key = saved?.signature === signature ? saved.key : idempotencyKey();
        retry.current = { signature, key };
        written = await client.createArtifact(input, key, signal);
        retry.current = undefined;
      }
      await Promise.all([review(written, signal), loadList(signal)]);
      if (!signal.aborted) setNotice(`已保存版本 ${written.head.number}。`);
    }, "暂时无法保存文稿。");
  }

  function download(target: Version) {
    if (!artifact) return;
    void work(async (signal) => {
      const blob = await client.downloadArtifactVersion(artifact.id, target.id, artifact.format, signal);
      const savedCode = versionCode(target);
      const filename = savedCode ? codeDownloadName(savedCode, target.number)
        : artifact.format === "sheet" ? `artifact-${target.number}.xlsx`
        : artifact.format === "slides" ? `artifact-${target.number}.pptx`
        : artifact.format === "webpage" ? `artifact-${target.number}.html`
        : artifact.format === "image" ? "image.png"
        : artifact.format === "markdown" ? "artifact.md" : "artifact.txt";
      if (!signal.aborted) downloadBlob(filename, blob);
    }, "暂时无法下载此版本。");
  }

  function previewWebsite(target: Version) {
    if (!artifact || artifact.format !== "webpage") return;
    setWebPreview(undefined);
    void work(async (signal) => {
      const result = await client.previewWebpageArtifact(artifact.id, target.id, signal);
      const html = await result.text();
      if (!signal.aborted) setWebPreview({ version: target.number, html });
    }, "暂时无法加载版式预览，可阅读文字或重试。");
  }

  function previewImage(target: Version, forPublication = false) {
    const source = versionImage(target);
    if (!artifact || !source) return;
    setImagePreview(undefined);
    setPublishing(undefined);
    void work(async (signal) => {
      const blob = await client.downloadArtifactVersion(artifact.id, target.id, "image", signal);
      if (!signal.aborted) {
        setImagePreview({ versionId: target.id, version: target.number, url: URL.createObjectURL(blob), alt: source.altText });
        if (forPublication) setPublishing(target);
      }
    }, "暂时无法预览图片版本，请核对来源授权。");
  }

  function loadRetired(record: Schemas["ArtifactSummary"]) {
    reset();
    setRetired(record);
    setDraft({ title: "", content: "", format: "image", projectId: record.projectId ?? "" });
  }

  function copyWebpage(target: Version) {
    const snapshot = versionWebsite(target);
    const projectId = artifact?.projectId;
    if (!snapshot || !projectId || artifact?.sourceMessageId || !canEditWebsites) return;
    reset();
    setDraft({ title: "", content: "", format: "webpage", projectId });
    setWebsite(snapshot);
    setNotice("已载入选定版本。输入文稿标题后可保存为独立草案。");
  }

  function renderEditContent() {
    if (!canEditFormat) return artifact && <VersionContent version={artifact.head} />;
    if (generateWebsite) return <p className="list-notice">用此回复的文字生成静态网页草案。生成后可编辑内容与预览版式。</p>;
    if (editingSheet) return <SpreadsheetEditor key={artifact?.head.id ?? "draft"} value={sheet} onChange={setSheet} disabled={locked} />;
    if (editingSlides) return <PresentationEditor key={artifact?.head.id ?? "draft"} deck={presentation}
      onChange={setPresentation} disabled={locked} />;
    if (editingCode) return <CodeDraftEditor code={code} onChange={setCode} disabled={locked} />;
    if (editingWebsite) return <WebsiteDraftEditor website={website} onChange={setWebsite} disabled={locked} />;
    if (editingImage) return <ImageAssetEditor key={draft.projectId} client={client} projectId={draft.projectId} image={image}
      offline={offline} disabled={locked} onChange={setImage} describeError={describeError} />;
    return <label className="dialog-field">文稿正文<textarea rows={9} value={draft.content} readOnly={locked}
      onChange={(event) => setDraft({ ...draft, content: event.target.value })} /></label>;
  }

  return <Modal label="文稿" className="action-dialog resource-dialog" close={close} returnFocus={opener}>
    <h2>文稿</h2>
    {offline && <p role="status">恢复网络后可读取或保存文稿。</p>}
    {error && <p role="alert" className="error-box">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <div className="dialog-actions">
      <button type="button" className="button secondary" disabled={locked} onClick={() => void work(async (signal) => {
        await loadList(signal);
        if (artifact && !signal.aborted) await review(await client.getArtifact(artifact.id, signal), signal);
      }, "暂时无法刷新文稿。")}>刷新文稿</button>
      {(retained || reply) && <button type="button" className="button secondary" disabled={busy} onClick={reset}>新建文稿</button>}
    </div>
    {!!listing.items.length && <section className="account-data-section" aria-label="已有文稿">
      <ul className="private-record-list">{listing.items.map((item) => <li key={item.id}>
        <button type="button" className="button secondary" disabled={locked} aria-pressed={retained?.id === item.id}
          onClick={() => {
            if (item.headAvailable === false) loadRetired(item);
            else void work(async (signal) => review(await client.getArtifact(item.id, signal), signal), "暂时无法读取文稿。");
          }}>{item.title} · 版本 {item.headVersionNumber}</button>
      </li>)}</ul>
      {listing.nextCursor && <button type="button" className="button secondary" disabled={locked} onClick={() => void work(async (signal) => {
        const next = await client.listArtifacts({ limit: 20, cursor: listing.nextCursor ?? undefined,
          projectId: currentProject ?? undefined }, signal);
        if (!signal.aborted) setListing((prior) => ({ items: [...prior.items, ...next.items], nextCursor: next.nextCursor }));
      }, "暂时无法读取更多文稿。")}>更多文稿</button>}
    </section>}
    <form className="account-data-section" onSubmit={save}>
      {retired && <p role="status">原图已撤回。{canEditImages ? "可选择新图保存为新版本，或删除这份图片资产。" : "可删除这份图片资产。"}</p>}
      <label className="dialog-field">文稿标题<input value={draft.title} readOnly={locked || !canEditFormat} required
        onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
      {reply && <p>从此回复创建文稿。删除原会话时，关联文稿也会撤回。</p>}
      {typedReply && reply && <details>
        <summary>查看来源回复</summary>
        <pre className="resource-text">{reply.content}</pre>
      </details>}
      {!reply && !retained && <label className="dialog-field">所属项目 <select value={draft.projectId} disabled={locked}
        onChange={(event) => { setImage(imageAssetDraft()); setDraft({ ...draft, projectId: event.target.value }); }}>
        <option value="">选择项目</option>
        {draft.projectId && !projects.items.some(({ id }) => id === draft.projectId) && <option value={draft.projectId}>当前项目</option>}
        {projects.items.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
      </select></label>}
      {!reply && !retained && projects.nextCursor && <button type="button" className="button secondary" disabled={locked}
        onClick={() => void work(async (signal) => {
          const next = await client.listProjects({ limit: 20, cursor: projects.nextCursor ?? undefined }, signal);
          if (!signal.aborted) setProjects((prior) => ({ items: [...prior.items, ...next.items], nextCursor: next.nextCursor }));
        }, "暂时无法读取更多项目。")}>更多项目</button>}
      {!retained && <label className="dialog-field">文件格式 <select value={draft.format} disabled={locked}
        onChange={(event) => {
          const format = event.target.value;
          if (Object.hasOwn(writable, format)) {
            setConfirmSource(false);
            setDraft({ ...draft, format: format as Schemas["ArtifactFormat"] });
          }
        }}>
        <option value="markdown">Markdown</option><option value="text">纯文本</option>
        {canEditSheets && (!reply || typedFromReply) && <option value="sheet">电子表格（XLSX）</option>}
        {canEditSlides && (!reply || typedFromReply) && <option value="slides">幻灯片（PPTX）</option>}
        {canEditCode && (!reply || typedFromReply) && <option value="code">源代码</option>}
        {canEditWebsites && <option value="webpage">网页草案</option>}
        {canEditImages && (!reply || (typedFromReply && !!draft.projectId)) && <option value="image">图片资产（PNG）</option>}
      </select></label>}
      {renderEditContent()}
      {typedReply && <label className="dialog-field">
        <input type="checkbox" checked={confirmSource} disabled={locked}
          onChange={(event) => setConfirmSource(event.target.checked)} />
        确认保存以上内容并关联这条回复
      </label>}
      {editingSheet && canEditSheets && preparedSheet?.error && <p role="alert">{preparedSheet.error}</p>}
      {editingSlides && canEditSlides && deckError && <p role="alert">{deckError}</p>}
      {editingCode && canEditCode && codeError && <p role="alert">{codeError}</p>}
      {editingWebsite && canEditWebsites && websiteError && <p role="alert">{websiteError}</p>}
      {editingImage && canEditImages && imageError && image.attachmentId && <p role="alert">{imageError}</p>}
      {textual && bytes > byteLimit && <p role="alert">正文最多使用 32 KiB UTF-8 文本。</p>}
      {title && [...title].length > 120 && <p role="alert">标题最多 120 个字符。</p>}
      <div className="dialog-actions">
        {canEditFormat && <button type="submit" className="button primary" disabled={locked || invalid || unchanged}>
          {retained ? "保存新版本" : generateWebsite ? "从回复生成网页" : createLabels[draft.format]}
        </button>}
        {artifact && <button className="button secondary" type="button" disabled={locked}
          onClick={() => download(artifact.head)}>下载当前版本</button>}
        {artifact && editingWebsite && webPreviewSupported && <button type="button" className="button secondary"
          disabled={locked} onClick={() => previewWebsite(artifact.head)}>预览已保存网页</button>}
        {artifact && editingImage && <button type="button" className="button secondary"
          disabled={locked} onClick={() => previewImage(artifact.head)}>预览当前图片版本</button>}
      </div>
    </form>
    {webPreview && !offline && <section className="account-data-section" aria-label="网页预览">
      <h3>网页预览 · 版本 {webPreview.version}</h3>
      <WebsiteSandbox title="已保存网页" html={webPreview.html} />
      <button type="button" className="button secondary" onClick={() => setWebPreview(undefined)}>关闭网页预览</button>
    </section>}
    {imagePreview && !offline && !publishing && <figure className="attachment-preview" aria-label={`图片版本 ${imagePreview.version}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a protected local object URL */}
      <img src={imagePreview.url} alt={imagePreview.alt || "图片资产版本预览"} />
      <button type="button" className="button secondary" onClick={() => setImagePreview(undefined)}>关闭图片版本预览</button>
    </figure>}
    {artifact && <section className="account-data-section" aria-label="文稿版本历史">
      <h3>版本历史</h3>
      <ul className="private-record-list">{versions.items.map((item) => <li key={item.id}>
        <button type="button" className="button secondary" disabled={locked} aria-pressed={historical?.id === item.id}
          onClick={() => void work(async (signal) => {
            const target = await client.getArtifactVersion(artifact.id, item.id, signal);
            if (!signal.aborted) { setHistorical(target); setRestore(false); setPublishing(undefined); }
          }, "暂时无法打开此版本。")}>版本 {item.number}{item.id === artifact.head.id ? "（当前）" : ""}</button>
      </li>)}</ul>
      {versions.nextCursor && <button type="button" className="button secondary" disabled={locked}
        onClick={() => void work(async (signal) => {
          const next = await client.listArtifactVersions(artifact.id, { limit: 20, cursor: versions.nextCursor ?? undefined }, signal);
          if (!signal.aborted) setVersions((prior) => ({ items: [...prior.items, ...next.items], nextCursor: next.nextCursor }));
        }, "暂时无法读取更多版本。")}>更多版本</button>}
      {historical && <>
        <p>{historical.title}</p>
        <VersionContent version={historical} />
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={locked} onClick={() => download(historical)}>下载所选版本</button>
          {editingWebsite && webPreviewSupported && <button type="button" className="button secondary" disabled={locked}
            onClick={() => previewWebsite(historical)}>预览所选网页版本</button>}
          {editingImage && <button type="button" className="button secondary" disabled={locked}
            onClick={() => previewImage(historical)}>预览所选图片版本</button>}
          {editingWebsite && canEditWebsites && artifact.projectId && !artifact.sourceMessageId && <button type="button" className="button secondary" disabled={locked}
            onClick={() => copyWebpage(historical)}>复制为独立网页草案</button>}
          {historical.id !== artifact.head.id && canEditFormat && (restore ? <>
            <button type="button" className="button secondary" disabled={busy} onClick={() => setRestore(false)}>取消还原</button>
            <button type="button" className="button primary" disabled={locked} onClick={() => void work(async (signal) => {
              const head = await client.rollbackArtifact(artifact.id, { baseVersionId: artifact.head.id, versionId: historical.id }, signal);
              await Promise.all([review(head, signal), loadList(signal)]);
              if (!signal.aborted) setNotice(`已从版本 ${historical.number} 创建版本 ${head.head.number}。`);
            }, "暂时无法还原文稿。")}>确认还原</button>
          </> : <button type="button" className="button secondary" disabled={locked} onClick={() => setRestore(true)}>还原为新版本</button>)}
        </div>
      </>}
    </section>}
    {canHostWebpages && artifact && editingWebsite && publicationProject && !offline && <HostedSite key={artifact.id}
      client={client} projectId={publicationProject} artifactId={artifact.id} versionId={(historical ?? artifact.head).id}
      versionNumber={(historical ?? artifact.head).number} canPreview={webPreviewSupported} disabled={locked} describeError={describeError} />}
    {canPublish && artifact && (textual || (editingWebsite && canPublishWebpages) || (editingImage && canPublishImages)
      || (editingSheet && typedPublications.sheet) || (editingSlides && typedPublications.slides) || (editingCode && typedPublications.code)) && publicationProject &&
      <section className="account-data-section" aria-label="发布文稿版本">
      {publishing ? <>
        <h3>待发布版本 {publishing.number}</h3>
        <p>已接受邀请的项目成员可以读取并下载以下已保存内容。</p>
        <h4>{publishing.title}</h4>
        <VersionContent version={publishing} />
        {editingImage && imagePreview?.versionId === publishing.id && !offline && <figure className="attachment-preview">
          {/* eslint-disable-next-line @next/next/no-img-element -- a protected local object URL */}
          <img src={imagePreview.url} alt={imagePreview.alt || "待发布图片版本"} />
        </figure>}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={() => {
            setPublishing(undefined);
            if (editingImage) setImagePreview(undefined);
          }}>取消发布</button>
          <button type="button" className="button primary" disabled={locked || (editingImage && imagePreview?.versionId !== publishing.id)} onClick={() => void work(async (signal) => {
            await client.publishProjectArtifact(publicationProject, {
              artifactId: artifact.id, versionId: publishing.id, confirm: true,
            }, signal);
            if (!signal.aborted) {
              setPublishing(undefined);
              if (editingImage) setImagePreview(undefined);
              setNotice(`版本 ${publishing.number} 已发布到项目协作。`);
            }
          }, "暂时无法发布此版本。")}>确认发布此版本</button>
        </div>
      </> : <button type="button" className="button secondary" disabled={locked}
        onClick={() => {
          const selected = historical ?? artifact.head;
          if (editingImage) previewImage(selected, true);
          else setPublishing(selected);
        }}>
        预览发布{historical ? `版本 ${historical.number}` : "当前版本"}
      </button>}
    </section>}
    <div className="dialog-actions">
      {retained && (deleting ? <>
        <button type="button" className="button secondary" disabled={busy} onClick={() => setDeleting(false)}>取消删除</button>
        <button className="button secondary danger-text" type="button" disabled={locked} onClick={() => void work(async (signal) => {
          await client.deleteArtifact(retained.id, signal);
          if (!signal.aborted) {
            reset();
            await loadList(signal);
          }
        }, "暂时无法删除文稿。")}>确认删除文稿和版本</button>
      </> : <button className="button secondary danger-text" type="button" disabled={locked}
        onClick={() => setDeleting(true)}>删除文稿</button>)}
      <button type="button" className="button secondary" onClick={close}>关闭</button>
    </div>
  </Modal>;
}
