"use client";

import { Download, Eye, RefreshCw, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import { downloadBlob, idempotencyKey } from "@/lib/assistant";
import { Modal } from "./modal";
import { ProjectAudioRecording } from "./project-audio-recording";
import { ProjectImageCapture, ProjectPngLimit } from "./project-image-capture";
import { ProjectPngEditor } from "./project-png-editor";

type Attachment = components["schemas"]["ProjectAttachment"] | components["schemas"]["ProjectAudioAttachment"]
  | components["schemas"]["ProjectPdfAttachment"];
type Preview = { id: string; url: string } | { id: string; text: string; approximate: boolean };
const ocrPrefix = "扫描件 OCR 文本，可能有误，请对照原件。\n"
  + "Scanned OCR text may contain errors. Check the original.\n\n";

function isApproximate(item: Attachment) {
  return "approximateText" in item && item.approximateText === true;
}
type EditSource = { id: string; width: number; height: number };
const statusText = { quarantined: "待扫描", approved: "扫描通过", rejected: "未通过检查" };
const timestamp = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });
const formats = {
  png: { label: "图像", format: "PNG", accept: "image/png,.png", filename: "image.png", limit: ProjectPngLimit,
    hint: "最大 1 MiB。", matches: (file: File) => file.type === "image/png" || !file.type && /\.png$/i.test(file.name) },
  wav: { label: "音频", format: "WAV", accept: "audio/wav,audio/x-wav,.wav", filename: "audio.wav", limit: ProjectPngLimit,
    hint: "支持 16 位 PCM，最长 30 秒，最大 1 MiB。",
    matches: (file: File) => /\.wav$/i.test(file.name) || ["audio/wav", "audio/wave", "audio/x-wav"].includes(file.type) },
  pdf: { label: "PDF", format: "PDF", accept: "application/pdf,.pdf", filename: "extracted.txt", limit: 32 * 1024,
    hint: "支持 32 KiB 以内、单页无压缩的基础英文文本 PDF。扫描通过后可读取并下载提取文本。",
    matches: (file: File) => file.type === "application/pdf" || !file.type && /\.pdf$/i.test(file.name) },
};
export type ProjectAttachmentFormat = keyof typeof formats;

export function ProjectAttachments({ client, project, offline, kind, uploadsAllowed = true, canEditPng = false, generalPdf = false,
  pdfOcr = false, openAudio, close, returnFocus, describeError }: {
  client: AssistantClient;
  project: { id: string; name: string };
  offline: boolean;
  kind: ProjectAttachmentFormat;
  uploadsAllowed?: boolean;
  canEditPng?: boolean;
  generalPdf?: boolean;
  pdfOcr?: boolean;
  openAudio?: () => void;
  close: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState<"refresh" | "upload" | "download" | "preview" | "delete" | "edit">();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [selection, setSelection] = useState<{ file: File; key: string; previewUrl?: string; recording?: AbortSignal }>();
  const [recordingActive, setRecordingActive] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [editing, setEditing] = useState<EditSource>();
  const [removing, setRemoving] = useState<Attachment>();
  const [reviewing, setReviewing] = useState<Attachment>();
  const running = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const { label, format, accept, hint, matches, filename, limit } = formats[kind];
  const routes = {
    png: [client.listProjectAttachments, client.uploadProjectAttachment, client.downloadProjectAttachment, client.deleteProjectAttachment],
    wav: [client.listProjectAudioAttachments, client.uploadProjectAudioAttachment, client.downloadProjectAudioAttachment, client.deleteProjectAudioAttachment],
    pdf: [client.listProjectPdfAttachments, client.uploadProjectPdfAttachment, client.downloadProjectPdfAttachment, client.deleteProjectPdfAttachment],
  } as const;
  const [list, upload, download, remove] = routes[kind];

  useEffect(() => () => { if (preview && "url" in preview) URL.revokeObjectURL(preview.url); }, [preview]);
  useEffect(() => () => { if (selection?.previewUrl) URL.revokeObjectURL(selection.previewUrl); }, [selection]);
  const discardRecording = useCallback(() => {
    setSelection((current) => current?.recording ? undefined : current);
  }, []);
  useEffect(() => {
    if (!uploadsAllowed) {
      setRecordingActive(false);
      discardRecording();
    }
  }, [uploadsAllowed, discardRecording]);

  useEffect(() => {
    const request = new AbortController();
    running.current = request;
    if (!offline) {
      setBusy("refresh");
      list.call(client, project.id, request.signal).then(({ items }) => {
        if (!request.signal.aborted) setItems(items);
      }).catch((failure) => {
        if (!request.signal.aborted) setError(describeError(failure, `暂时无法读取${label}附件。`));
      }).finally(() => {
        if (!request.signal.aborted) {
          running.current = null;
          setBusy(undefined);
        }
      });
    } else {
      running.current = null;
      setBusy(undefined);
      setPreview(undefined);
      setEditing(undefined);
      setReviewing(undefined);
    }
    return () => {
      request.abort();
      running.current?.abort();
      running.current = null;
    };
  }, [client, describeError, label, list, offline, project.id]);

  useEffect(() => {
    if (!preview || (kind === "png" && !editing)) return;
    const request = new AbortController();
    const id = preview.id;
    function hide() {
      if (document.hidden) { setPreview(undefined); setEditing(undefined); }
    }
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      const currentText = kind === "pdf" ? client.getProjectPdfAttachmentText(project.id, id, request.signal) : undefined;
      void Promise.all([list.call(client, project.id, request.signal), currentText]).then(([{ items }, text]) => {
        if (request.signal.aborted) return;
        setItems(items);
        const item = items.find((candidate) => candidate.id === id && candidate.state === "approved");
        if (!item || ("text" in preview && (isApproximate(item) !== preview.approximate
          || !text || text.id !== id || text.text !== preview.text
          || (text.approximateText === true) !== preview.approximate))) {
          setPreview(undefined);
          setEditing(undefined);
        }
      }).catch(() => { if (!request.signal.aborted) { setPreview(undefined); setEditing(undefined); } });
    }, 8_000);
    document.addEventListener("visibilitychange", hide);
    return () => {
      request.abort();
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", hide);
    };
  }, [kind, list, client, editing, preview, project.id]);

  useEffect(() => {
    if (!reviewing) return;
    function hideReview() {
      if (document.hidden) setReviewing(undefined);
    }
    document.addEventListener("visibilitychange", hideReview);
    return () => document.removeEventListener("visibilitychange", hideReview);
  }, [reviewing]);

  async function refresh(signal: AbortSignal) {
    const page = await list.call(client, project.id, signal);
    if (signal.aborted) return;
    setItems(page.items);
    setPreview((current) => current && page.items.some(({ id, state }) => id === current.id && state === "approved")
      ? current : undefined);
    setEditing((current) => current && page.items.some(({ id, state }) => id === current.id && state === "approved")
      ? current : undefined);
  }

  async function operate(action: NonNullable<typeof busy>, fn: (signal: AbortSignal) => Promise<void>, fallback: string) {
    if (running.current || offline) return;
    const request = new AbortController();
    running.current = request;
    setBusy(action);
    setError("");
    setNotice("");
    try {
      await fn(request.signal);
    } catch (failure) {
      if (!request.signal.aborted) {
        if (failure instanceof AssistantApiError && [403, 404, 409].includes(failure.status)) {
          setPreview(undefined);
          setEditing(undefined);
        }
        setError(describeError(failure, fallback));
      }
    } finally {
      if (running.current === request) {
        running.current = null;
        setBusy(undefined);
      }
    }
  }

  function changeFile(file?: File, capture?: "image" | AbortSignal) {
    setSelection(undefined);
    setError("");
    setNotice("");
    if (!file) return;
    if (!matches(file) || file.size < 1 || file.size > limit) {
      setError(`请选择 ${kind === "pdf" ? "32 KiB" : "1 MiB"} 以内的 ${format} 文件。`);
      return;
    }
    setSelection({ file, key: idempotencyKey(), previewUrl: capture ? URL.createObjectURL(file) : undefined,
      recording: capture === "image" ? undefined : capture });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!selection || !uploadsAllowed || recordingActive || (selection.recording && (selection.recording.aborted || document.hidden))) return;
    void operate("upload", async (signal) => {
      const item = await upload.call(client, project.id, selection.file, selection.key, signal);
      if (signal.aborted) return;
      setItems((current) => [item, ...current.filter(({ id }) => id !== item.id)]);
      setSelection(undefined);
      if (fileInput.current) fileInput.current.value = "";
      setNotice(`已接收${label}。可刷新查看检查结果。`);
    }, "暂时无法上传。可以用同一文件重试。");
  }

  function stopWaiting() {
    running.current?.abort();
    running.current = null;
    setBusy(undefined);
    setNotice("已停止等待。可刷新核对服务器是否已接收，或重试同一文件。");
  }

  function read(item: Attachment, action: "preview" | "download", reviewed = false) {
    const approximate = kind === "pdf" && isApproximate(item);
    if (approximate && action === "download" && !reviewed) {
      setReviewing(item);
      return;
    }
    setReviewing(undefined);
    void operate(action, async (signal) => {
      if (kind === "pdf" && (action === "preview" || approximate)) {
        const result = await client.getProjectPdfAttachmentText(project.id, item.id, signal);
        if (signal.aborted) return;
        if (result.id !== item.id || result.approximateText !== (approximate ? true : undefined)
          || (approximate && !result.text.startsWith(ocrPrefix))) {
          throw new Error("PDF transcript does not match the approved attachment.");
        }
        if (action === "preview") {
          setPreview({ id: result.id, text: result.text, approximate });
          return;
        }
        const blob = await client.downloadProjectPdfAttachment(project.id, item.id, signal, true);
        if (blob.size > 4 * 1024 || new TextDecoder("utf-8", { fatal: true }).decode(await blob.arrayBuffer()) !== result.text) {
          throw new Error("Downloaded OCR text does not match the reviewed transcript.");
        }
        if (!signal.aborted) downloadBlob(filename, blob);
        return;
      }
      const blob = await download.call(client, project.id, item.id, signal);
      if (signal.aborted) return;
      if (action === "preview") {
        setEditing(undefined);
        setPreview({ id: item.id, url: URL.createObjectURL(blob) });
      }
      else downloadBlob(filename, blob);
    }, `无法读取${label}。请刷新检查它的访问状态。`);
  }

  function editable(item: Attachment): EditSource | undefined {
    if (kind !== "png" || !canEditPng || item.state !== "approved" || ("localEdit" in item && item.localEdit)
      || !("width" in item) || !("height" in item) || !item.width || !item.height || item.width > 480 || item.height > 480) return;
    return { id: item.id, width: item.width, height: item.height };
  }

  function edit(source: EditSource) {
    void operate("preview", async (signal) => {
      const blob = await client.downloadProjectAttachment(project.id, source.id, signal);
      if (!signal.aborted && !document.hidden) {
        setEditing(source);
        setPreview({ id: source.id, url: URL.createObjectURL(blob) });
      }
    }, "请重新核对原图的访问权限。");
  }

  function confirmImageEdit(command: components["schemas"]["LocalImageEditWrite"], key: string) {
    if (!editing || !canEditPng) return;
    void operate("edit", async (signal) => {
      const item = await client.editProjectPng(project.id, editing.id, command, key, signal);
      if (!signal.aborted) {
        setItems((current) => [item, ...current.filter(({ id }) => id !== item.id)]);
        setEditing(undefined);
        setPreview(undefined);
        setNotice("编辑副本已提交，可刷新查看扫描结果。");
      }
    }, "暂时无法生成编辑副本。请检查原图及裁剪范围后重试。");
  }

  return <Modal label={`项目${label}`} className="action-dialog resource-dialog" close={close} returnFocus={returnFocus}>
    <h2>项目{label}</h2>
    <p>{project.name}</p>
    {uploadsAllowed && <form className="account-data-section" onSubmit={submit}>
      <label className="dialog-field">选择 {format} 文件
        <input type="file" ref={fileInput} accept={accept} disabled={offline || !!busy || recordingActive}
          onChange={(event) => changeFile(event.target.files?.[0])} />
      </label>
      <p className="list-notice">{kind === "pdf" && generalPdf
        ? "支持 32 KiB 以内、最多 8 页的文本 PDF。扫描通过后可读取并下载提取文本。"
        : hint}{kind !== "pdf" && "检查通过后可以预览或下载。"}</p>
      {kind === "pdf" && pdfOcr && <p className="list-notice">支持合格的单页扫描件识别。识别结果可能有误，请对照原件。</p>}
      {kind === "png" && <ProjectImageCapture disabled={!!busy} onAudioFallback={openAudio} onCapture={(file) => {
        if (fileInput.current) fileInput.current.value = "";
        changeFile(file, "image");
      }} />}
      {kind === "wav" && <ProjectAudioRecording disabled={!!busy} offline={offline} hasDraft={!!selection?.recording}
        onActivity={setRecordingActive} onDiscard={discardRecording} onDraft={(file, signal) => {
          if (fileInput.current) fileInput.current.value = "";
          changeFile(file, signal);
        }} />}
      {selection?.previewUrl && <figure className="attachment-preview">
        {selection.recording ? <audio controls preload="metadata" src={selection.previewUrl} aria-label="待上传的本机录音" />
          // eslint-disable-next-line @next/next/no-img-element -- rendered from a local object URL
          : <img src={selection.previewUrl} alt="待上传的本机图像" />}
        <button type="button" className="button secondary" disabled={!!busy || recordingActive} onClick={() => changeFile()}>
          {selection.recording ? "丢弃录音" : "丢弃当前帧"}
        </button>
      </figure>}
      {busy === "upload" && <progress aria-label={`正在上传${label}`} />}
      <div className="dialog-actions">
        {busy === "upload" && <button type="button" className="button secondary" onClick={stopWaiting}>取消等待</button>}
        <button type="submit" className="button primary" disabled={!selection || offline || !!busy || recordingActive}>
          <Upload size={16} aria-hidden="true" /> 上传 {format}
        </button>
      </div>
    </form>}
    {offline && <p role="status">联网后可以核对{label}状态。</p>}
    {busy === "refresh" && <p role="status">正在读取{label}状态…</p>}
    {busy === "edit" && <p role="status">正在提交图像编辑…</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    <section className="account-data-section" aria-label="附件状态">
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={offline || !!busy}
          onClick={() => void operate("refresh", refresh, `暂时无法刷新${label}状态。`)}>
          <RefreshCw size={16} aria-hidden="true" /> 刷新状态
        </button>
      </div>
      {!items.length && !busy && <p>暂无{label}附件。</p>}
      <ul className="private-record-list">
        {items.map((item) => {
          const source = editable(item);
          return <li key={item.id}>
          <p><strong>{statusText[item.state]}</strong> · {timestamp.format(new Date(item.createdAt))} · {Math.ceil(item.size / 1024)} KiB</p>
          {isApproximate(item) && <p>扫描件 OCR 文本 · 可能有误，请对照原件。</p>}
          {"audio" in item && item.audio && <p>{item.audio.durationMillis / 1000} 秒 · {item.audio.sampleRate / 1000} kHz ·
            {item.audio.channels === 1 ? "单声道" : "双声道"}</p>}
          {kind === "pdf" && item.errorCode === "INVALID_PDF" && <p>{generalPdf
            ? "无法在当前限制内提取此 PDF 的文本。请检查页数、加密和正文。" : "此 PDF 不符合基础文本提取格式。"}</p>}
          {kind === "pdf" && item.errorCode === "PDF_EXTRACTOR_UNAVAILABLE" && <p>隔离文本提取服务暂不可用。</p>}
          {"localEdit" in item && item.localEdit && <p>本地编辑副本 · 顺时针旋转 {item.localEdit.rotation}°</p>}
          <div className="dialog-actions">
            {item.state === "approved" && (kind !== "pdf" || uploadsAllowed) && <>
              <button type="button" className="button secondary" disabled={offline || !!busy}
                onClick={() => read(item, "preview")}><Eye size={16} aria-hidden="true" /> {kind === "pdf" ? "预览提取文本" : "预览"}</button>
              <button type="button" className="button secondary" disabled={offline || !!busy}
                onClick={() => read(item, "download")}><Download size={16} aria-hidden="true" /> 下载 {kind === "pdf" ? "提取文本" : format}</button>
              {source && <button type="button" className="button secondary" disabled={offline || !!busy}
                onClick={() => edit(source)}>裁剪或旋转</button>}
            </>}
            <button type="button" className="button secondary" disabled={offline || !!busy || !!removing}
              onClick={() => setRemoving(item)}>删除{label}</button>
          </div>
          {!offline && uploadsAllowed && reviewing?.id === item.id && item.state === "approved" && <div>
            <p>下载的 OCR 文本可能有误，请对照原件核查。</p>
            <div className="dialog-actions">
              <button type="button" className="button secondary" onClick={() => setReviewing(undefined)}>取消</button>
              <button type="button" className="button primary" disabled={!!busy}
                onClick={() => read(item, "download", true)}>确认并下载 OCR 文本</button>
            </div>
          </div>}
          {!offline && preview?.id === item.id && (kind !== "pdf" || uploadsAllowed) && (editing?.id === item.id
            && source && "url" in preview ? <ProjectPngEditor key={item.id} source={source} previewUrl={preview.url}
              disabled={!!busy} close={() => { setPreview(undefined); setEditing(undefined); }} onConfirm={confirmImageEdit} />
            : <figure className="attachment-preview">
            {"text" in preview ? <pre className="resource-text">{preview.text}</pre>
              : kind === "wav" ? <audio controls preload="metadata" src={preview.url} aria-label="项目上传的音频预览" />
              // eslint-disable-next-line @next/next/no-img-element -- rendered from a private object URL
              : <img src={preview.url} width={"width" in item ? item.width : undefined}
                height={"height" in item ? item.height : undefined} alt="项目上传的图像预览" />}
            <button className="button secondary" type="button" onClick={() => setPreview(undefined)}>关闭预览</button>
          </figure>)}
        </li>; })}
      </ul>
      {removing && <div>
        <p>删除此{label}并撤回它的访问授权？</p>
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={!!busy} onClick={() => setRemoving(undefined)}>取消</button>
          <button type="button" className="button secondary danger-text" disabled={offline || !!busy}
            onClick={() => void operate("delete", async (signal) => {
              await remove.call(client, project.id, removing.id, signal);
              if (signal.aborted) return;
              if (preview?.id === removing.id) setPreview(undefined);
              if (editing?.id === removing.id) setEditing(undefined);
              setItems((current) => current.filter(({ id }) => id !== removing.id));
              setRemoving(undefined);
              setNotice(`${label}已删除。`);
            }, `暂时无法删除${label}。`)}>确认删除</button>
        </div>
      </div>}
    </section>
    <div className="dialog-actions"><button type="button" className="button secondary" onClick={close}>关闭</button></div>
  </Modal>;
}
