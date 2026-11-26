"use client";

import { Flag } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { AssistantApiError, type components } from "@ai-assistant/contracts";
import { Modal } from "./modal";

type Reason = components["schemas"]["ReportReason"];
const reasons: ReadonlyArray<{ value: Reason; label: string }> = [
  { value: "safety", label: "有害或不安全的内容" },
  { value: "privacy", label: "泄露隐私" },
  { value: "spam", label: "垃圾内容" },
  { value: "other", label: "其他" },
];

export function ContentReport({ title, triggerLabel, disabled = false, submit, describeError }: {
  title: string;
  triggerLabel?: string;
  disabled?: boolean;
  submit: (reason: Reason, signal: AbortSignal) => Promise<unknown>;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [reported, setReported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => () => pending.current?.abort(), []);

  function close() {
    setOpen(false);
    setError("");
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const selected = new FormData(event.currentTarget).get("reason");
    const reason = reasons.find(({ value }) => value === selected)?.value;
    if (pending.current || disabled || !reason) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    try {
      await submit(reason, request.signal);
      if (!request.signal.aborted) {
        setReported(true);
        close();
      }
    } catch (failure) {
      if (!request.signal.aborted) {
        setError(failure instanceof AssistantApiError && failure.code === "CONFLICT" ? "这项内容已有你的举报。" :
          describeError(failure, "暂时无法提交举报，请稍后重试。"));
      }
    } finally {
      pending.current = null;
      if (!request.signal.aborted) setBusy(false);
    }
  }

  return <>
    <button ref={trigger} type="button" className="button compact-button" aria-haspopup="dialog" aria-label={triggerLabel}
      disabled={disabled && !reported} aria-disabled={reported || undefined} onClick={() => {
        if (!reported) setOpen(true);
      }}><Flag size={16} aria-hidden="true" /> 举报</button>
    <span className="reply-report-status" role="status">{reported ? "举报已提交。" : ""}</span>
    {open && <Modal label={title} className="action-dialog" returnFocus={trigger}
      close={() => { if (!pending.current) close(); }}>
      <form onSubmit={send}>
        <h2>{title}</h2>
        <label className="dialog-field">举报原因
          <select name="reason" defaultValue="" required autoFocus disabled={busy}>
            <option value="" disabled>选择举报原因</option>
            {reasons.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        {error && <p className="error-box" role="alert">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="button secondary" disabled={busy} onClick={close}>取消</button>
          <button type="submit" className="button primary" disabled={busy || disabled}>
            {busy ? "正在提交…" : "提交举报"}
          </button>
        </div>
      </form>
    </Modal>}
  </>;
}
