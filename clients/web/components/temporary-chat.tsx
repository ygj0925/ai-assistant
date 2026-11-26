"use client";

import { Send } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from "react";
import type { AssistantClient } from "@ai-assistant/contracts";
import { Modal } from "./modal";

const MAX_PROMPT = 512;

export function TemporaryChat({ client, offline, close, returnFocus, describeError }: {
  client: AssistantClient;
  offline: boolean;
  close: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [prompt, setPrompt] = useState("");
  const [result, setResult] = useState<{ prompt: string; reply: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fieldId = useId();
  const policyId = useId();
  const pending = useRef<AbortController | null>(null);
  const remaining = MAX_PROMPT - [...prompt].length;

  useEffect(() => {
    function clear() {
      pending.current?.abort();
      pending.current = null;
      setPrompt("");
      setResult(undefined);
      setError("");
      setBusy(false);
    }
    function onPageShow(event: PageTransitionEvent) {
      if (event.persisted) clear();
    }
    window.addEventListener("pagehide", clear);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", clear);
      window.removeEventListener("pageshow", onPageShow);
      pending.current?.abort();
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending.current || offline || remaining < 0 || !prompt.trim()) return;
    const request = new AbortController();
    pending.current = request;
    setError("");
    setBusy(true);
    try {
      const reply = await client.replyToTemporaryChat(prompt, request.signal);
      if (request.signal.aborted) return;
      setResult({ prompt, reply: reply.content });
      setPrompt("");
    } catch (failure) {
      if (!request.signal.aborted) setError(describeError(failure, "暂时无法回复，请重试。"));
    } finally {
      if (!request.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  return <Modal label="临时对话" className="action-dialog temporary-dialog" close={close} returnFocus={returnFocus}>
    <h2>临时对话</h2>
    <p id={policyId}>当前使用本地模拟模型，每次只处理当前消息。内容不会写入历史或记忆，关闭窗口或刷新页面后清除。</p>
    {result && <section className="temporary-result" role="status" aria-label="最近一轮临时对话">
      <p><strong>你</strong><span>{result.prompt}</span></p>
      <p><strong>本地模拟回复</strong><span>{result.reply}</span></p>
    </section>}
    <form onSubmit={(event) => void submit(event)}>
      <label className="dialog-field" htmlFor={fieldId}>临时消息
        <textarea id={fieldId} rows={3} autoFocus autoComplete="off" spellCheck={false} aria-describedby={policyId}
          disabled={busy} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
      </label>
      {remaining < 0 && <p role="status">消息最多 512 个字符，请删减 {-remaining} 个字符。</p>}
      {offline && <p role="status">联网后可以发送临时消息。</p>}
      {busy && <p role="status">正在生成…</p>}
      {error && <p className="error-box" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button type="button" className="button secondary" onClick={close}>关闭</button>
        <button className="button primary" type="submit" disabled={offline || busy || remaining < 0 || !prompt.trim()}>
          <Send size={17} aria-hidden="true" /> 发送临时消息
        </button>
      </div>
    </form>
  </Modal>;
}
