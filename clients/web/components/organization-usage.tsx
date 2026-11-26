"use client";

import { useEffect, useRef, useState } from "react";
import type { AssistantClient, components } from "@ai-assistant/contracts";

type Usage = components["schemas"]["OrganizationUsage"];
const number = new Intl.NumberFormat("zh-CN");

export function OrganizationUsage({ client, disabled, describeError }: {
  client: AssistantClient;
  disabled: boolean;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [days, setDays] = useState<Usage["periodDays"]>(7);
  const [usage, setUsage] = useState<Usage>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active = useRef<AbortController>(null);

  useEffect(() => {
    function clearOnHide() {
      if (!document.hidden) return;
      active.current?.abort();
      active.current = null;
      setUsage(undefined);
      setBusy(false);
    }
    document.addEventListener("visibilitychange", clearOnHide);
    return () => {
      active.current?.abort();
      active.current = null;
      document.removeEventListener("visibilitychange", clearOnHide);
    };
  }, [client]);

  async function load() {
    if (disabled || document.hidden || active.current) return;
    const request = new AbortController();
    active.current = request;
    setBusy(true);
    setError("");
    try {
      const result = await client.getOrganizationUsage(days, request.signal);
      if (!request.signal.aborted) setUsage(result);
    } catch (failure) {
      if (!request.signal.aborted) {
        setUsage(undefined);
        setError(describeError(failure, "暂时无法读取组织用量。"));
      }
    } finally {
      if (active.current === request) {
        active.current = null;
        setBusy(false);
      }
    }
  }

  return <section className="account-data-section" aria-label="组织用量">
    <h3>组织用量</h3>
    <label className="dialog-field">统计范围<select value={days} disabled={disabled || busy} onChange={(event) => {
      setDays(event.target.value === "30" ? 30 : 7);
      setUsage(undefined);
    }}><option value="7">最近 7 天</option><option value="30">最近 30 天</option></select></label>
    <button type="button" className="button secondary" disabled={disabled || busy}
      onClick={() => void load()}>{busy ? "正在读取用量…" : "查看组织用量"}</button>
    {error && <p className="error-box" role="alert">{error}</p>}
    {usage && (usage.items.every((item) => item.submittedRuns === 0) ? <p>此时段没有运行记录。</p>
      : <div className="table-scroll" tabIndex={0} aria-label="按日期查看用量记录">
        <table>
          <caption>按运行提交日期归集 · UTC · 账本单位</caption>
          <thead><tr>
            <th scope="col">日期</th><th scope="col">提交</th><th scope="col">完成</th>
            <th scope="col">已结算</th><th scope="col">预留中</th>
          </tr></thead>
          <tbody>{usage.items.map((item) => <tr key={item.date}>
            <th scope="row">{item.date}</th><td>{number.format(item.submittedRuns)}</td>
            <td>{number.format(item.completedRuns)}</td><td>{number.format(item.settledUnits)}</td>
            <td>{number.format(item.reservedUnits)}</td>
          </tr>)}</tbody>
        </table>
      </div>)}
  </section>;
}
