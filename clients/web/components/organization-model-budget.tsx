"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AssistantClient, components } from "@ai-assistant/contracts";

type Budget = components["schemas"]["OrganizationModelBudget"];
type Change = components["schemas"]["OrganizationModelBudgetWrite"];
const formatUnits = new Intl.NumberFormat("zh-CN");

export function OrganizationModelBudget({ client, disabled, describeError, onSaved }: {
  client: AssistantClient;
  disabled: boolean;
  describeError: (error: unknown, fallback: string) => string;
  onSaved: () => void;
}) {
  const [budget, setBudget] = useState<Budget>();
  const [limit, setLimit] = useState<string | null>(null);
  const [review, setReview] = useState<Change>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef<AbortController>(null);

  useEffect(() => {
    function onVisibility() {
      if (!document.hidden) return;
      active.current?.abort();
      active.current = null;
      setBudget(undefined);
      setLimit(null);
      setReview(undefined);
      setBusy(false);
      setError("");
      setNotice("");
    }
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active.current?.abort();
      active.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [client]);

  async function load(change?: Change) {
    if (disabled || active.current || document.hidden) return;
    const request = new AbortController();
    active.current = request;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = change ? await client.updateOrganizationModelBudget(change, request.signal)
        : await client.getOrganizationModelBudget(request.signal);
      if (request.signal.aborted) return;
      setBudget(result);
      setLimit(result.monthlyLimitUnits === null ? null : String(result.monthlyLimitUnits));
      setReview(undefined);
      if (change) {
        setNotice("组织模型用量上限已更新。");
        onSaved();
      }
    } catch (failure) {
      if (request.signal.aborted) return;
      setBudget(undefined);
      setLimit(null);
      setReview(undefined);
      setError(describeError(failure, "暂时无法核对组织模型用量上限。"));
    } finally {
      if (active.current === request) {
        active.current = null;
        setBusy(false);
      }
    }
  }

  function prepare(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!budget || busy || disabled) return;
    if (limit !== null && (!/^\d{1,10}$/.test(limit) || Number(limit) > 1_000_000_000)) {
      setError("请输入 0 到 1,000,000,000 之间的整数。");
      return;
    }
    setError("");
    setNotice("");
    setReview({ baseRevision: budget.revision, monthlyLimitUnits: limit === null ? null : Number(limit), confirm: true });
  }

  const locked = disabled || busy;
  return <section className="account-data-section" aria-label="组织模型用量上限">
    <h3>组织模型用量上限</h3>
    {error && <p className="error-box" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {budget && <>
      <p className="list-notice">UTC 月度 {budget.monthStart.slice(0, 7)} · 按模型输出的 Unicode 码点计量</p>
      <dl className="account-usage">
        <div><dt>月度上限</dt><dd>{budget.monthlyLimitUnits === null ? "未设置" : formatUnits.format(budget.monthlyLimitUnits)}</dd></div>
        <div><dt>已结算</dt><dd>{formatUnits.format(budget.settledUnits)}</dd></div>
        <div><dt>预留中</dt><dd>{formatUnits.format(budget.reservedUnits)}</dd></div>
        <div><dt>剩余用量</dt><dd>{budget.availableUnits === null ? "未设组织上限" : formatUnits.format(budget.availableUnits)}</dd></div>
      </dl>
    </>}
    {budget && !review && <form onSubmit={prepare}>
      <label className="dialog-field">用量控制<select value={limit === null ? "off" : "on"} disabled={locked}
        onChange={(event) => setLimit(event.target.value === "on" ? "" : null)}>
        <option value="off">不设组织上限</option><option value="on">设置月度上限</option>
      </select></label>
      {limit !== null && <label className="dialog-field">每月输出上限<input type="text" inputMode="numeric" value={limit}
        maxLength={10} disabled={locked} onChange={(event) => setLimit(event.target.value)} /></label>}
      <button className="button secondary" type="submit" disabled={locked}>审核用量上限变更</button>
    </form>}
    {review && <div aria-label="用量上限变更预览">
      <p>{review.monthlyLimitUnits === null ? "将移除组织用量上限。" : review.monthlyLimitUnits === 0
        ? "保存后将暂停此组织的新模型运行。"
        : `将月度上限设为 ${formatUnits.format(review.monthlyLimitUnits)}。设限期间仅可运行本地合成模型。`}</p>
      <div className="dialog-actions">
        <button className="button secondary" type="button" disabled={locked} onClick={() => setReview(undefined)}>取消用量上限变更</button>
        <button className="button primary" type="button" disabled={locked} onClick={() => void load(review)}>确认用量上限变更</button>
      </div>
    </div>}
    {!review && <button className="button secondary" type="button" disabled={locked} onClick={() => void load()}>
      {busy ? "正在核对上限…" : budget ? "刷新用量上限" : "读取用量上限"}
    </button>}
  </section>;
}
