"use client";

import { Download } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import type { AssistantClient, components } from "@ai-assistant/contracts";
import { downloadBlob } from "@/lib/assistant";
import { Modal } from "./modal";

type Summary = components["schemas"]["AnalysisSummary"];

export function AnalysisPanel({ client, offline, projectId, resourceId, name, close, returnFocus, describeError }: {
  client: AssistantClient;
  offline: boolean;
  projectId: string;
  resourceId: string;
  name: string;
  close: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  describeError: (failure: unknown, fallback: string) => string;
}) {
  const [column, setColumn] = useState("");
  const [summary, setSummary] = useState<Summary>();
  const [pending, setPending] = useState<"analyze" | "download">();
  const [error, setError] = useState("");
  const busy = useRef(false);
  const active = useRef(false);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  async function run(action: "analyze" | "download", work: () => Promise<void>, fallback: string) {
    if (offline || busy.current) return;
    busy.current = true;
    setPending(action);
    setError("");
    try { await work(); }
    catch (failure) { if (active.current) setError(describeError(failure, fallback)); }
    finally {
      busy.current = false;
      if (active.current) setPending(undefined);
    }
  }

  function analyze(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const valueColumn = column.trim();
    if (!valueColumn) return;
    void run("analyze", async () => {
      setSummary(undefined);
      const result = await client.analyzeProjectResource(projectId, resourceId, { valueColumn });
      if (active.current) setSummary(result);
    }, "暂时无法分析。请检查 CSV 格式、列名和数值。");
  }

  function download() {
    if (!summary) return;
    void run("download", async () => {
      const artifact = await client.downloadAnalysis(summary.id);
      if (active.current) downloadBlob("analysis.csv", artifact);
    }, "暂时无法下载分析产物。");
  }

  const scale = Math.max(0, ...(summary?.series.map(({ value }) => Math.abs(Number(value))) ?? [])) || 1;
  return <Modal label="分析 CSV" className="action-dialog resource-dialog" close={close} returnFocus={returnFocus}>
    <h2>分析 CSV</h2>
    <p>{name}</p>
    <form onSubmit={analyze}>
      <label className="dialog-field">数值列名称<input autoFocus value={column} onChange={(event) => setColumn(event.target.value)} required /></label>
      <div className="dialog-actions">
        <button className="button secondary" type="button" onClick={close}>关闭</button>
        <button className="button primary" type="submit" disabled={!column.trim() || !!pending || offline}>开始分析</button>
      </div>
    </form>
    {pending === "analyze" && <p role="status">正在计算…</p>}
    {offline && <p role="status">联网后可运行分析和下载。</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    {summary && <section className="resource-detail" aria-label="分析结果">
      <h3>{summary.column}</h3>
      <dl className="account-usage analysis-metrics">
        <div><dt>数据行</dt><dd>{summary.rowCount}</dd></div>
        <div><dt>数值数</dt><dd>{summary.valueCount}</dd></div>
        <div><dt>最小值</dt><dd>{summary.min}</dd></div>
        <div><dt>最大值</dt><dd>{summary.max}</dd></div>
        <div><dt>总和</dt><dd>{summary.sum}</dd></div>
        <div><dt>平均值</dt><dd>{summary.mean}</dd></div>
      </dl>
      <p className="list-notice">计算用时 {summary.durationMillis} 毫秒 · 跳过空白 {summary.logSummary.blankValuesSkipped} 行 · {summary.algorithmVersion}</p>
      <h3>数值分布{summary.logSummary.chartTruncated ? `（前 ${summary.series.length} 个）` : ""}</h3>
      <ol className="analysis-plot" aria-label="逐行数值">
        {summary.series.map(({ row, value }) => {
          const numeric = Number(value);
          const width = Math.abs(numeric) / scale * 50;
          return <li key={row}>
            <span>第 {row} 行</span>
            <span className="analysis-track" aria-hidden="true"><span className="analysis-bar" style={{
              inlineSize: `${width}%`, insetInlineStart: `${numeric < 0 ? 50 - width : 50}%`,
            }} /></span>
            <span className="analysis-value">{value}</span>
          </li>;
        })}
      </ol>
      <button type="button" className="button secondary" disabled={!!pending || offline} onClick={download}>
        <Download size={17} aria-hidden="true" /> {pending === "download" ? "正在下载…" : "下载分析 CSV"}
      </button>
    </section>}
  </Modal>;
}
