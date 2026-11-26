"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";

type Policy = components["schemas"]["OrganizationPolicy"];
type Change = components["schemas"]["OrganizationPolicyWrite"];
const modelPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function OrganizationPolicy({ client, disabled, describeError, onSaved }: {
  client: AssistantClient;
  disabled: boolean;
  describeError: (error: unknown, fallback: string) => string;
  onSaved: () => void;
}) {
  const [policy, setPolicy] = useState<Policy>();
  const [ids, setIds] = useState("");
  const [connector, setConnector] = useState(false);
  const [review, setReview] = useState<Change>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef<AbortController>(null);

  useEffect(() => {
    function discard() {
      if (!document.hidden) return;
      active.current?.abort();
      active.current = null;
      setPolicy(undefined);
      setIds("");
      setConnector(false);
      setReview(undefined);
      setBusy(false);
    }
    document.addEventListener("visibilitychange", discard);
    return () => {
      active.current?.abort();
      active.current = null;
      document.removeEventListener("visibilitychange", discard);
    };
  }, []);

  function accept(value: Policy) {
    setPolicy(value);
    setIds(value.allowedModelIds?.join("\n") ?? "");
    setConnector(value.sandboxConnectorAllowed);
    setReview(undefined);
  }

  async function run(operation: (signal: AbortSignal) => Promise<void>) {
    if (disabled || active.current || document.hidden) return;
    const request = new AbortController();
    active.current = request;
    setBusy(true);
    setError("");
    setNotice("");
    try { await operation(request.signal); }
    catch (failure) {
      if (!request.signal.aborted) {
        setReview(undefined);
        setPolicy(undefined);
        setIds("");
        setConnector(false);
        setError(failure instanceof AssistantApiError && failure.status === 409
          ? "组织策略已变化，请重新读取后确认。" : describeError(failure, "暂时无法核对组织策略。"));
      }
    } finally {
      if (active.current === request) {
        active.current = null;
        setBusy(false);
      }
    }
  }

  function prepare(event: FormEvent) {
    event.preventDefault();
    if (!policy) return;
    const allowedModelIds = ids.split("\n").map((line) => line.trim()).filter(Boolean);
    if (allowedModelIds.length > 16 || new Set(allowedModelIds).size !== allowedModelIds.length
      || allowedModelIds.some((id) => !modelPattern.test(id))) {
      setError("请输入最多 16 个有效且不同的模型标识，每行一个。");
      return;
    }
    setError("");
    setNotice("");
    setReview({ baseRevision: policy.revision, allowedModelIds, sandboxConnectorAllowed: connector, confirm: true });
  }

  const locked = disabled || busy;
  return <section className="account-data-section" aria-label="组织模型与连接器策略">
    <h3>组织模型与连接器策略</h3>
    {error && <p className="error-box" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {policy?.reviewRequired && <p role="status">恢复的策略需要重新确认。当前模型和连接器调用已暂停。</p>}
    {policy?.allowedModelIds === null && <p>尚未配置组织模型列表，使用部署允许的模型。</p>}
    {policy && !review && <form onSubmit={prepare}>
      <label className="dialog-field">允许的模型标识
        <textarea value={ids} maxLength={2064} rows={3} readOnly={locked}
          aria-describedby="organization-model-policy-help" onChange={(event) => setIds(event.target.value)} />
      </label>
      <p id="organization-model-policy-help">每行填写一个模型标识。保存空列表会停止此组织的模型调用。</p>
      <label className="dialog-field"><input type="checkbox" checked={connector} disabled={locked}
        onChange={(event) => setConnector(event.target.checked)} />允许沙箱连接器</label>
      <button className="button secondary" type="submit" disabled={locked}>审核策略变更</button>
    </form>}
    {review && <div aria-label="策略变更预览">
      {review.allowedModelIds.length ? <ul>{review.allowedModelIds.map((id) => <li key={id}>{id}</li>)}</ul>
        : <p>所有模型调用将被拒绝。</p>}
      <p>{review.sandboxConnectorAllowed ? "允许沙箱连接器。" : "停止新的沙箱连接器操作。"}</p>
      <div className="dialog-actions">
        <button className="button secondary" type="button" disabled={locked} onClick={() => setReview(undefined)}>取消策略变更</button>
        <button className="button primary" type="button" disabled={locked} onClick={() => void run(async (signal) => {
          const updated = await client.updateOrganizationPolicy(review, signal);
          if (!signal.aborted) {
            accept(updated);
            setNotice("组织策略已更新。");
            onSaved();
          }
        })}>确认策略变更</button>
      </div>
    </div>}
    {!review && <button className="button secondary" type="button" disabled={locked} onClick={() => void run(async (signal) => {
      const current = await client.getOrganizationPolicy(signal);
      if (!signal.aborted) accept(current);
    })}>{policy ? "重新读取组织策略" : "读取组织策略"}</button>}
  </section>;
}
