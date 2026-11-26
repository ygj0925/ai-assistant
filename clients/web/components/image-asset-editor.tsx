"use client";

import { useEffect, useState } from "react";
import type { AssistantClient, components } from "@ai-assistant/contracts";

type Input = components["schemas"]["ImageArtifactInput"];
type Image = components["schemas"]["ImageArtifactSource"];
type Attachment = components["schemas"]["ProjectAttachment"];
const date = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });

export function imageAssetDraft(image?: Image): Input {
  return { attachmentId: image?.attachmentId ?? "", altText: image?.altText ?? "" };
}

export function imageAssetError(image: Input) {
  if (!image.attachmentId) return "请选择项目内一张已通过扫描的 PNG。";
  if (image.altText.length > 160 || /[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(image.altText)) {
    return "替代文字需要 160 个字符以内的单行文本。";
  }
}

export function ImageAssetEditor({ client, projectId, image, offline, disabled, onChange, describeError }: {
  client: AssistantClient;
  projectId: string;
  image: Input;
  offline: boolean;
  disabled: boolean;
  onChange: (image: Input) => void;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [files, setFiles] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState("");

  useEffect(() => {
    setFiles([]);
    setError("");
    setLoading(!!projectId && !offline);
    if (!projectId || offline) return;
    const request = new AbortController();
    void client.listProjectAttachments(projectId, request.signal).then(({ items }) => {
      if (!request.signal.aborted) setFiles(items.filter(({ state }) => state === "approved"));
    }).catch((failure) => {
      if (!request.signal.aborted) setError(describeError(failure, "暂时无法读取本项目的图片。"));
    }).finally(() => { if (!request.signal.aborted) setLoading(false); });
    return () => request.abort();
  }, [attempt, client, describeError, offline, projectId]);

  useEffect(() => {
    if (!visible || !projectId || !image.attachmentId || offline) return;
    const request = new AbortController();
    let objectUrl: string | undefined;
    setPreviewError("");
    setUrl(undefined);
    void client.downloadProjectAttachment(projectId, image.attachmentId, request.signal).then((blob) => {
      if (!request.signal.aborted) {
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      }
    }).catch((failure) => {
      if (!request.signal.aborted) setPreviewError(describeError(failure, "无法预览这张图片，请核对来源。"));
    });
    return () => {
      request.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [client, describeError, image.attachmentId, offline, projectId, visible]);

  return <section className="account-data-section" aria-label="图片来源和说明">
    <label className="dialog-field">图片来源<select value={image.attachmentId} disabled={disabled || loading || !projectId}
      onChange={(event) => { setVisible(false); onChange({ ...image, attachmentId: event.target.value }); }}>
      <option value="">选择已通过检查的 PNG</option>
      {image.attachmentId && !files.some(({ id }) => id === image.attachmentId) && <option value={image.attachmentId}>
        当前版本的图片来源
      </option>}
      {files.map((file) => <option key={file.id} value={file.id}>
        {file.width} × {file.height} · {date.format(new Date(file.createdAt))} · {file.id.slice(0, 8)}
      </option>)}
    </select></label>
    <label className="dialog-field">替代文字<input value={image.altText} maxLength={160} readOnly={disabled}
      onChange={(event) => onChange({ ...image, altText: event.target.value })} /></label>
    {loading && <p role="status">正在读取本项目的图片…</p>}
    {!!projectId && !loading && !offline && !files.length && !error && <p>可在「项目图像」上传 PNG，检查通过后选择。</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button type="button" className="button secondary" disabled={disabled || loading || !projectId}
        onClick={() => setAttempt((value) => value + 1)}>刷新图片来源</button>
      {image.attachmentId && <button type="button" className="button secondary" disabled={disabled || !projectId}
        onClick={() => { setUrl(undefined); setPreviewError(""); setVisible((current) => !current); }}>
        {visible ? "关闭图片预览" : "查看所选图片"}
      </button>}
    </div>
    {visible && !offline && previewError && <p className="error-box" role="alert">{previewError}</p>}
    {visible && !offline && url && <figure className="attachment-preview">
      {/* eslint-disable-next-line @next/next/no-img-element -- a protected local object URL */}
      <img src={url} alt={image.altText || "所选图片预览"} />
    </figure>}
  </section>;
}

export function ImageAssetView({ image }: { image: Pick<Image, "altText" | "size" | "width" | "height"> }) {
  return <div>
    {image.altText && <p>{image.altText}</p>}
    <p className="list-notice">PNG · {image.width} × {image.height} · {Math.ceil(image.size / 1024)} KiB</p>
  </div>;
}
