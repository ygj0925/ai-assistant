"use client";

import { Mic, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

const sampleRate = 16_000;
const maxSeconds = 30;
const maxEncodedBytes = 1024 * 1024;
const fallback = "可以选择 WAV 文件或继续文字聊天。";
type Phase = "permission" | "recording" | "encoding";
type Recording = { controller: AbortController; stop?: () => void };

async function encodeWave(recording: Blob) {
  const decoder = new OfflineAudioContext(1, 1, sampleRate);
  const pcm = await decoder.decodeAudioData(await recording.arrayBuffer());
  const frames = Math.min(pcm.length, sampleRate * maxSeconds);
  if (!frames || pcm.sampleRate !== sampleRate || pcm.numberOfChannels < 1 || pcm.numberOfChannels > 2) {
    throw new Error("Unsupported recording format");
  }
  const bytes = new ArrayBuffer(44 + frames * 2);
  const header = new DataView(bytes);
  header.setUint32(0, 0x52494646); // RIFF
  header.setUint32(4, bytes.byteLength - 8, true);
  header.setUint32(8, 0x57415645); // WAVE
  header.setUint32(12, 0x666d7420); // fmt 
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // Linear PCM
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  header.setUint32(36, 0x64617461); // data
  header.setUint32(40, frames * 2, true);
  const left = pcm.getChannelData(0);
  const right = pcm.numberOfChannels === 2 ? pcm.getChannelData(1) : left;
  for (let frame = 0; frame < frames; frame++) {
    const sample = Math.max(-1, Math.min(1, (left[frame] + right[frame]) / 2));
    header.setInt16(44 + frame * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  }
  return new File([bytes], "recording.wav", { type: "audio/wav" });
}

export function ProjectAudioRecording({ disabled, offline, hasDraft, onActivity, onDraft, onDiscard }: {
  disabled: boolean;
  offline: boolean;
  hasDraft: boolean;
  onActivity: (active: boolean) => void;
  onDraft: (file: File, signal: AbortSignal) => void;
  onDiscard: () => void;
}) {
  const [supported, setSupported] = useState<boolean>();
  const [phase, setPhase] = useState<Phase>();
  const [notice, setNotice] = useState("");
  const current = useRef<Recording | null>(null);

  const discard = useCallback((message: string) => {
    current.current?.controller.abort();
    current.current = null;
    onActivity(false);
    onDiscard();
    setPhase(undefined);
    setNotice(message);
  }, [onActivity, onDiscard]);

  useEffect(() => {
    setSupported(typeof navigator.mediaDevices?.getUserMedia === "function" &&
      typeof MediaRecorder === "function" && typeof OfflineAudioContext === "function");
    function suspend() {
      if (current.current) discard("页面已离开前台，录音已清除。");
    }
    function checkVisibility() {
      if (document.hidden) suspend();
    }
    document.addEventListener("visibilitychange", checkVisibility);
    window.addEventListener("pagehide", suspend);
    return () => {
      document.removeEventListener("visibilitychange", checkVisibility);
      window.removeEventListener("pagehide", suspend);
      current.current?.controller.abort();
      current.current = null;
    };
  }, [discard]);

  useEffect(() => {
    if (!current.current) return;
    if (offline) {
      discard("网络已断开，录音已清除。");
    } else if (!phase && !hasDraft) {
      current.current.controller.abort();
      current.current = null;
    }
  }, [discard, hasDraft, offline, phase]);

  async function start() {
    if (phase || (current.current && !hasDraft) || disabled || offline || document.hidden) return;
    discard("");
    onActivity(true);
    setPhase("permission");
    const recording: Recording = { controller: new AbortController() };
    current.current = recording;
    const { signal } = recording.controller;
    const lost = () => discard(`麦克风访问已停止，录音已清除。${fallback}`);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: { ideal: 1 } }, video: false });
      const release = () => stream.getTracks().forEach((track) => track.stop());
      if (signal.aborted) { release(); return; }
      signal.addEventListener("abort", release, { once: true });
      if (document.hidden) { lost(); return; }
      const [track] = stream.getAudioTracks();
      if (!track || track.readyState !== "live") { lost(); return; }
      track.addEventListener("ended", lost, { once: true, signal });
      void navigator.permissions?.query({ name: "microphone" as PermissionName }).then((permission) => {
        if (signal.aborted) return;
        if (permission.state === "denied") lost();
        else permission.addEventListener("change", () => { if (permission.state !== "granted") lost(); }, { signal });
      }).catch(() => { /* Track lifecycle still covers active capture on these browsers. */ });

      const mimeType = ["audio/webm;codecs=opus", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
      const parts: Blob[] = [];
      const deadline = Date.now() + (maxSeconds + 2) * 1000;
      let size = 0;
      const timer = window.setTimeout(() => recording.stop?.(), maxSeconds * 1000);
      signal.addEventListener("abort", () => {
        window.clearTimeout(timer);
        parts.length = 0;
      }, { once: true });
      recording.stop = () => {
        if (signal.aborted || recorder.state !== "recording") return;
        window.clearTimeout(timer);
        track.removeEventListener("ended", lost);
        recorder.stop();
        release();
        setPhase("encoding");
      };
      recorder.addEventListener("dataavailable", ({ data }) => {
        if (signal.aborted || !data.size) return;
        size += data.size;
        if (Date.now() > deadline || size > maxEncodedBytes) discard(`这段录音超出限制。${fallback}`);
        else parts.push(data);
      }, { signal });
      recorder.addEventListener("error", () => discard(`录音中断。${fallback}`), { signal });
      recorder.addEventListener("stop", async () => {
        if (signal.aborted) return;
        if (!parts.length) { discard("录音太短，请重新录制。"); return; }
        const encoded = new Blob(parts, { type: recorder.mimeType });
        parts.length = 0;
        try {
          const file = await encodeWave(encoded);
          if (signal.aborted) return;
          if (document.hidden) { lost(); return; }
          onDraft(file, signal);
          onActivity(false);
          setPhase(undefined);
        } catch {
          if (!signal.aborted) discard(`无法转换录音。${fallback}`);
        }
      }, { once: true, signal });
      recorder.start(250);
      setPhase("recording");
    } catch (error) {
      if (signal.aborted) return;
      const denied = error instanceof DOMException && error.name === "NotAllowedError";
      discard(`${denied ? "未获麦克风授权。" : "当前无法开启麦克风。"}${fallback}`);
    }
  }

  if (supported === undefined) return null;
  return <section className="account-data-section" aria-label="本机录音">
    <h3>本机录音</h3>
    {supported ? <p className="list-notice">最长 30 秒。试听后可确认上传到当前项目。</p>
      : <p className="list-notice">当前浏览器不支持本机录音。{fallback}</p>}
    <div className="dialog-actions">
      {supported && !phase && <button type="button" className="button secondary" disabled={disabled || offline}
        onClick={() => void start()}><Mic size={16} aria-hidden="true" /> 开始录音</button>}
      {phase === "recording" && <button type="button" className="button secondary" onClick={() => current.current?.stop?.()}>
        <Square size={16} aria-hidden="true" /> 停止录音</button>}
      {phase && <button type="button" className="button secondary" onClick={() => discard("录音已取消。")}>取消录音</button>}
    </div>
    {phase === "permission" && <p role="status">请在浏览器中确认麦克风权限。</p>}
    {phase === "recording" && <p role="status">麦克风开启中 · 本机录音</p>}
    {phase === "encoding" && <p role="status">正在准备 WAV…</p>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
