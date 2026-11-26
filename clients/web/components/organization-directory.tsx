"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AssistantClient, components } from "@ai-assistant/contracts";

type Member = components["schemas"]["OrganizationMember"];
type Receipt = components["schemas"]["OrganizationDirectoryBinding"];
const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

export function OrganizationDirectory({ client, members, disabled, describeError, onSaved }: {
  client: AssistantClient;
  members: Member[];
  disabled: boolean;
  describeError: (error: unknown, fallback: string) => string;
  onSaved: () => void;
}) {
  const [accountId, setAccountId] = useState("");
  const [externalId, setExternalId] = useState("");
  const [review, setReview] = useState<{ member: Member; externalId: string }>();
  const [receipt, setReceipt] = useState<Receipt>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const eligible = members.filter(({ role }) => role === "member");

  useEffect(() => {
    function clearHidden() {
      if (!document.hidden) return;
      pending.current?.abort();
      pending.current = null;
      setReview(undefined);
      setReceipt(undefined);
      setExternalId("");
      setAccountId("");
      setError("");
      setBusy(false);
    }
    document.addEventListener("visibilitychange", clearHidden);
    return () => {
      document.removeEventListener("visibilitychange", clearHidden);
      pending.current?.abort();
      pending.current = null;
    };
  }, [client]);

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setReceipt(undefined);
    const member = eligible.find((current) => current.accountId === accountId);
    const external = externalId.trim().toLowerCase();
    if (!member || !uuid.test(external)) {
      setError("请选择当前普通成员，并填写完整的目录用户 UUID。");
      return;
    }
    setReview({ member, externalId: external });
  }

  async function confirm() {
    if (!review || disabled || pending.current || document.hidden) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    try {
      const result = await client.bindOrganizationDirectoryMember({ accountId: review.member.accountId,
        membershipRevision: review.member.membershipRevision, externalId: review.externalId, confirm: true }, request.signal);
      if (!request.signal.aborted) {
        setReview(undefined);
        setReceipt(result);
        setExternalId("");
        setAccountId("");
        onSaved();
      }
    } catch (failure) {
      if (!request.signal.aborted) {
        setReview(undefined);
        setError(describeError(failure, "暂时无法绑定。请刷新组织成员状态后重新审核。"));
      }
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  const locked = busy || disabled;
  return <section className="account-data-section" aria-label="组织目录绑定">
    <h3>组织目录绑定</h3>
    {error && <p className="error-box" role="alert">{error}</p>}
    {receipt && <p role="status">绑定已保存。绑定标识 {receipt.id}</p>}
    {eligible.length === 0 && <p>此页没有可绑定的普通成员。</p>}
    {!!eligible.length && !review && <form onSubmit={prepare}>
      <label className="dialog-field">普通成员<select required value={accountId} disabled={locked}
        onChange={(event) => setAccountId(event.target.value)}>
        <option value="">选择成员</option>
        {eligible.map(({ accountId: id, username }) => <option key={id} value={id}>{username}</option>)}
      </select></label>
      <label className="dialog-field">目录用户 UUID<input type="text" required maxLength={36} value={externalId}
        disabled={locked} onChange={(event) => setExternalId(event.target.value)} /></label>
      <button type="submit" className="button secondary" disabled={locked}>审核目录绑定</button>
    </form>}
    {review && <div role="group" aria-label="目录绑定预览">
      <p>{review.member.username} · {review.externalId}</p>
      <p>目录中的停用操作会撤回该成员当前的工作空间资格。</p>
      <div className="dialog-actions">
        <button type="button" className="button secondary" disabled={locked} onClick={() => setReview(undefined)}>取消目录绑定</button>
        <button type="button" className="button primary" disabled={locked} onClick={() => void confirm()}>
          {busy ? "正在保存绑定…" : "确认目录绑定"}
        </button>
      </div>
    </div>}
  </section>;
}
