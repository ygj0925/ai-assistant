"use client";

import { Camera, Monitor, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type Source = "camera" | "screen";
type Phase = "requesting" | "live" | "encoding";
type Capture = { source: Source; phase: Phase };
export const ProjectPngLimit = 1024 * 1024;

function makePng(video: HTMLVideoElement, limit: number) {
  const canvas = document.createElement("canvas");
  const scale = Math.min(1, limit / Math.max(video.videoWidth, video.videoHeight));
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const painter = canvas.getContext("2d", { alpha: false });
  if (!painter) return undefined;
  painter.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob | null>((resolve) => canvas.toBlob((blob) => {
    canvas.width = 0;
    canvas.height = 0;
    resolve(blob);
  }, "image/png"));
}

function failureMessage(failure: unknown) {
  if (failure instanceof DOMException) {
    if (failure.name === "NotAllowedError" || failure.name === "AbortError") {
      return "未获授权或已取消。可以改用 PNG 文件或继续文字聊天。";
    }
    if (failure.name === "NotFoundError" || failure.name === "NotReadableError") {
      return "当前无法读取摄像头或屏幕。可以改用 PNG 文件或继续文字聊天。";
    }
  }
  return "暂时无法开启预览。可以改用 PNG 文件或继续文字聊天。";
}

export function ProjectImageCapture({ disabled, onCapture, onAudioFallback }: {
  disabled: boolean;
  onCapture: (file: File) => void;
  onAudioFallback?: () => void;
}) {
  const [support, setSupport] = useState<{ camera: boolean; screen: boolean }>();
  const [capture, setCapture] = useState<Capture>();
  const [frameReady, setFrameReady] = useState(false);
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const working = useRef(false);
  const stream = useRef<MediaStream | null>(null);
  const observation = useRef<AbortController | null>(null);
  const video = useRef<HTMLVideoElement>(null);

  const releaseTracks = useCallback(() => {
    observation.current?.abort();
    observation.current = null;
    const active = stream.current;
    stream.current = null;
    for (const track of active?.getTracks() ?? []) track.stop();
    if (video.current) video.current.srcObject = null;
  }, []);

  const stop = useCallback((message: string) => {
    generation.current++;
    working.current = false;
    releaseTracks();
    setCapture(undefined);
    setFrameReady(false);
    setNotice(message);
  }, [releaseTracks]);

  useEffect(() => {
    const devices = navigator.mediaDevices;
    const permissionPolicy = (document as Document & { featurePolicy?: { allowsFeature: (feature: string) => boolean } }).featurePolicy;
    setSupport({
      camera: typeof devices?.getUserMedia === "function" && (permissionPolicy?.allowsFeature("camera") ?? true),
      screen: typeof devices?.getDisplayMedia === "function" && (permissionPolicy?.allowsFeature("display-capture") ?? true),
    });
    const stopIfActive = () => {
      if (working.current) stop("预览已停止。可以重新选择图像来源。");
    };
    const onVisibility = () => { if (document.hidden) stopIfActive(); };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", stopIfActive);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", stopIfActive);
      generation.current++;
      working.current = false;
      releaseTracks();
    };
  }, [releaseTracks, stop]);

  async function start(source: Source) {
    if (working.current || disabled || document.hidden) return;
    const id = ++generation.current;
    working.current = true;
    setNotice("");
    setCapture({ source, phase: "requesting" });
    try {
      const devices = navigator.mediaDevices;
      const displayOptions: DisplayMediaStreamOptions & { selfBrowserSurface: "exclude" } = {
        video: { frameRate: { ideal: 10 } }, audio: false, selfBrowserSurface: "exclude",
      };
      const incoming = await (source === "camera"
        ? devices.getUserMedia({ video: { width: { ideal: 1024 }, height: { ideal: 768 } }, audio: false })
        : devices.getDisplayMedia(displayOptions));
      if (generation.current !== id || document.hidden || !video.current) {
        incoming.getTracks().forEach((track) => track.stop());
        if (generation.current === id) stop("预览已停止。可以重新选择图像来源。");
        return;
      }
      const [track] = incoming.getVideoTracks();
      stream.current = incoming;
      if (!track || track.readyState !== "live" || incoming.getAudioTracks().length) {
        stop("无法取得可用图像。可以改用 PNG 文件或继续文字聊天。");
        return;
      }
      const observer = new AbortController();
      observation.current = observer;
      const lost = () => stop("浏览器已停止访问。可以改用 PNG 文件或继续文字聊天。");
      track.addEventListener("ended", lost, { once: true, signal: observer.signal });
      if (source === "camera") {
        void navigator.permissions?.query({ name: "camera" as PermissionName }).then((permission) => {
          if (observer.signal.aborted) return;
          if (permission.state === "denied") lost();
          else permission.addEventListener("change", () => { if (permission.state !== "granted") lost(); }, { signal: observer.signal });
        }).catch(() => { /* Active capture still observes the video track on these browsers. */ });
      }
      video.current.srcObject = incoming;
      setCapture({ source, phase: "live" });
      await video.current.play();
    } catch (failure) {
      if (generation.current === id) stop(failureMessage(failure));
    }
  }

  async function selectFrame() {
    const element = video.current;
    const active = stream.current?.getVideoTracks()[0];
    if (!capture || capture.phase !== "live" || !active || active.readyState !== "live" || active.muted ||
        !element || !element.videoWidth || !element.videoHeight || element.readyState < 2) return;
    const id = ++generation.current;
    setCapture({ source: capture.source, phase: "encoding" });
    let pending: Array<Promise<Blob | null> | undefined>;
    try {
      // Copy only the selected frame, then release the track before PNG encoding finishes.
      pending = [makePng(element, 1024), makePng(element, 640)];
    } catch {
      stop("无法生成图像。可以改用 PNG 文件或继续文字聊天。");
      return;
    }
    releaseTracks();
    const frames = await Promise.all(pending);
    if (generation.current !== id) return;
    const file = frames.find((blob) => blob?.size && blob.size <= ProjectPngLimit);
    if (file) {
      onCapture(new File([file], capture.source === "camera" ? "camera.png" : "screen.png", { type: "image/png" }));
      stop("已选取一帧。确认后可上传到当前项目。");
    } else {
      stop("此画面无法转换为 1 MiB 以内的 PNG。可以改用文件或继续文字聊天。");
    }
  }

  if (!support) return null;
  return <section className="account-data-section project-capture" aria-label="本机图像采集">
    <h3>本机图像采集</h3>
    {(support.camera || support.screen) && <p className="list-notice">预览仅留在此页面。选取一帧后，可确认上传到项目。</p>}
    {(!support.camera || !support.screen) && <p className="list-notice">
      {support.camera ? "当前浏览器不支持屏幕采集。" : support.screen ? "当前浏览器不支持摄像头。" : "当前浏览器不支持本机图像采集。"}
      可以改用 PNG 文件或继续文字聊天。
    </p>}
    <div className="dialog-actions">
      {support.camera && <button type="button" className="button secondary" disabled={disabled || !!capture}
        onClick={() => void start("camera")}><Camera size={16} aria-hidden="true" /> 打开摄像头</button>}
      {support.screen && <button type="button" className="button secondary" disabled={disabled || !!capture}
        onClick={() => void start("screen")}><Monitor size={16} aria-hidden="true" /> 选择共享画面</button>}
      {capture && <button type="button" className="button secondary" onClick={() => stop("已停止预览。")}>
        <Square size={16} aria-hidden="true" /> 停止预览
      </button>}
      {onAudioFallback && <button type="button" className="button secondary" disabled={disabled}
        onClick={onAudioFallback}>改用项目音频</button>}
    </div>
    <video ref={video} aria-label="本机图像预览" autoPlay muted playsInline hidden={!capture}
      onLoadedData={() => setFrameReady(true)} />
    {capture?.phase === "requesting" && <p role="status">请在浏览器中确认权限或选择画面。</p>}
    {capture?.phase === "live" && <div>
      <p role="status">{capture.source === "camera" ? "摄像头开启中" : "共享画面采集中"} · 本机预览</p>
      <button type="button" className="button secondary" disabled={!frameReady || disabled}
        onClick={() => void selectFrame()}>选取当前帧</button>
    </div>}
    {capture?.phase === "encoding" && <p role="status">正在准备一张 PNG…</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
