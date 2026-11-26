"use client";

import { Download, ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import { downloadBlob, idempotencyKey, safeSourceUrl } from "@/lib/assistant";
import { Modal } from "./modal";

type ResearchTask = components["schemas"]["ResearchTask"];
type ResearchSource = components["schemas"]["ResearchSource"];
type ResearchPlan = components["schemas"]["ResearchPlan"];
const EMPTY_PLAN: ResearchPlan = { question: "", sourceIds: [] };
const labels = {
  awaiting_approval: "待确认", queued: "已排队", running: "正在整理", completed: "已完成", cancelled: "已取消", failed: "未完成",
} satisfies Record<ResearchTask["state"], string>;
const sourceDate = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short" });

function samePlan(left: ResearchPlan, right: ResearchPlan) {
  return left.question.trim() === right.question && left.sourceIds.length === right.sourceIds.length &&
    left.sourceIds.every((id) => right.sourceIds.includes(id));
}

export function ResearchPanel({ client, offline, close, returnFocus, describeError }: {
  client: AssistantClient;
  offline: boolean;
  close: () => void;
  returnFocus: RefObject<HTMLElement | null>;
  describeError: (error: unknown, fallback: string) => string;
}) {
  const [tasks, setTasks] = useState<ResearchTask[]>([]);
  const [sources, setSources] = useState<ResearchSource[]>([]);
  const [taskCursor, setTaskCursor] = useState<string | null>(null);
  const [sourceCursor, setSourceCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<ResearchTask>();
  const [plan, setPlan] = useState<ResearchPlan>(EMPTY_PLAN);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef<AbortController | null>(null);
  const createAttempt = useRef<{ plan: ResearchPlan; key: string }>(undefined);

  useEffect(() => {
    if (offline) {
      setBusy(false);
      return;
    }
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    Promise.all([client.listResearchTasks({ limit: 12 }, request.signal), client.listResearchSources({ limit: 20 }, request.signal)])
      .then(([taskPage, sourcePage]) => {
        if (request.signal.aborted) return;
        setTasks(taskPage.items);
        setTaskCursor(taskPage.nextCursor);
        setSources(sourcePage.items);
        setSourceCursor(sourcePage.nextCursor);
      }).catch((failure) => {
        if (!request.signal.aborted) setError(describeError(failure, "暂时无法读取研究任务。"));
      }).finally(() => {
        if (pending.current === request) {
          pending.current = null;
          setBusy(false);
        }
      });
    return () => {
      request.abort();
      pending.current?.abort();
      pending.current = null;
    };
  }, [client, describeError, offline]);

  async function act(operation: (signal: AbortSignal) => Promise<void>, fallback: string) {
    if (pending.current || offline) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation(request.signal);
    } catch (failure) {
      if (request.signal.aborted) return;
      setError(failure instanceof AssistantApiError && failure.status === 409
        ? "任务版本或来源已变化，请刷新后重试。" : describeError(failure, fallback));
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  function show(task: ResearchTask) {
    setSelected(task);
    setPlan({ question: task.question, sourceIds: task.sourceIds });
  }

  function keep(task: ResearchTask) {
    show(task);
    setTasks((known) => [task, ...known.filter(({ id }) => id !== task.id)]);
  }

  function refresh() {
    void act(async (signal) => {
      const [taskPage, sourcePage] = await Promise.all([
        client.listResearchTasks({ limit: 12 }, signal),
        client.listResearchSources({ limit: 20 }, signal),
      ]);
      if (signal.aborted) return;
      setTasks(taskPage.items);
      setTaskCursor(taskPage.nextCursor);
      setSources(sourcePage.items);
      setSourceCursor(sourcePage.nextCursor);
      if (selected && samePlan(plan, selected)) {
        const latest = taskPage.items.find(({ id }) => id === selected.id) ?? await client.getResearchTask(selected.id, signal);
        if (!signal.aborted) show(latest);
      }
    }, "暂时无法刷新任务和来源。");
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = plan.question.trim();
    if (!question || [...question].length > 256 || plan.sourceIds.length < 1 || plan.sourceIds.length > 6) return;
    if (selected && samePlan(plan, selected)) return;
    const input: ResearchPlan = { question, sourceIds: plan.sourceIds };
    void act(async (signal) => {
      let result: ResearchTask;
      if (selected) {
        result = await client.reviseResearchTask(selected.id, { ...input, expectedRevision: selected.revision }, signal);
      } else {
        const prior = createAttempt.current;
        const key = prior && samePlan(input, prior.plan) ? prior.key : idempotencyKey();
        createAttempt.current = { plan: input, key };
        result = await client.createResearchTask(input, key, signal);
        if (!signal.aborted) createAttempt.current = undefined;
      }
      if (!signal.aborted) {
        keep(result);
        setNotice("已保存计划。确认当前版本后开始研究。");
      }
    }, "暂时无法保存研究计划。");
  }

  function change(action: "approve" | "cancel") {
    if (!selected || (action === "approve" && !samePlan(plan, selected))) return;
    const { id, revision } = selected;
    void act(async (signal) => {
      const task = action === "approve" ? await client.approveResearchTask(id, revision, signal)
        : await client.cancelResearchTask(id, revision, signal);
      if (!signal.aborted) keep(task);
    }, action === "approve" ? "暂时无法确认计划。" : "暂时无法取消任务。");
  }

  function download() {
    if (!selected?.reportAvailable) return;
    void act(async (signal) => {
      const report = await client.downloadResearchReport(selected.id, selected.revision, signal);
      if (!signal.aborted) downloadBlob("research-report.txt", report);
    }, "报告当前无法下载，请刷新检查来源。");
  }

  const length = [...plan.question].length;
  const working = selected?.state === "queued" || selected?.state === "running";
  const changed = selected ? !samePlan(plan, selected) : true;
  const status = selected && labels[selected.state];
  const knownIds = new Set(sources.map(({ id }) => id));
  const unknown = plan.sourceIds.filter((id) => !knownIds.has(id));
  return <Modal label="研究任务" className="action-dialog resource-dialog" close={close} returnFocus={returnFocus}>
    <h2>研究任务</h2>
    <p>从已收录的资料选择来源，确认计划后在后台生成有引用的报告。</p>
    {offline && <p role="status">联网后可刷新任务状态。</p>}
    {busy && <p role="status">正在同步…</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button type="button" className="button secondary" disabled={!!busy || offline} onClick={refresh}>
        <RefreshCw size={16} aria-hidden="true" /> 刷新状态与来源
      </button>
      <button type="button" className="button secondary" disabled={!!busy} onClick={() => {
        setSelected(undefined);
        setPlan(EMPTY_PLAN);
        setError("");
        setNotice("");
      }}>新建研究</button>
    </div>
    {tasks.length > 0 && <section className="account-data-section" aria-label="已保存研究">
      <ul className="private-record-list">
        {tasks.map((task) => <li key={task.id}><button type="button" className="button secondary"
          aria-pressed={selected?.id === task.id} disabled={busy} onClick={() => show(task)}>
          {task.question} · {labels[task.state]}
        </button></li>)}
      </ul>
      {taskCursor && <button type="button" className="button secondary" disabled={offline || busy}
        onClick={() => void act(async (signal) => {
          const page = await client.listResearchTasks({ limit: 12, cursor: taskCursor }, signal);
          if (!signal.aborted) {
            setTasks((known) => [...known, ...page.items.filter(({ id }) => !known.some((task) => task.id === id))]);
            setTaskCursor(page.nextCursor);
          }
        }, "暂时无法读取更多任务。")}>加载更多任务</button>}
    </section>}
    {selected && <section className="account-data-section" aria-label="当前任务状态">
      <p>版本 {selected.revision} · {status}{working && ` · ${selected.progress}%`}</p>
      {!!selected.reusedSourceCount && <p>已保留 {selected.reusedSourceCount} 项来源核验结果。</p>}
      {selected.state === "failed" && <p>请刷新来源，更新计划后再确认。</p>}
      <div className="dialog-actions">
        {selected.state === "awaiting_approval" && <button type="button" className="button primary"
          disabled={changed || busy || offline} onClick={() => change("approve")}>确认此版本</button>}
        {(working || selected.state === "awaiting_approval") && <button type="button" className="button secondary"
          disabled={busy || offline} onClick={() => change("cancel")}>取消任务</button>}
        {selected.reportAvailable && <button type="button" className="button secondary"
          disabled={busy || offline} onClick={download}><Download size={16} aria-hidden="true" /> 下载本版本报告</button>}
      </div>
    </section>}
    <form className="account-data-section" onSubmit={submit}>
      <label className="dialog-field">研究问题
        <textarea rows={3} value={plan.question} readOnly={busy || offline}
          onChange={(event) => setPlan({ ...plan, question: event.target.value })} />
      </label>
      {length > 256 && <p role="status">研究问题最多 256 个字符。</p>}
      <fieldset className="research-source-options">
        <legend>选用资料（最多 6 项）</legend>
        {!sources.length && !busy && <p>暂无可用资料。</p>}
        {sources.map((source) => {
          const included = plan.sourceIds.includes(source.id);
          const address = safeSourceUrl(source.url);
          return <div className="research-source-row" key={source.id}>
            <label className="memory-toggle">
              <input type="checkbox" checked={included} disabled={offline || busy || (!included && plan.sourceIds.length >= 6)}
                onChange={() => setPlan({ ...plan, sourceIds: included ? plan.sourceIds.filter((id) => id !== source.id)
                  : [...plan.sourceIds, source.id] })} />
              <span>{source.title} <small><time dateTime={source.accessedAt}>{sourceDate.format(new Date(source.accessedAt))}</time></small></span>
            </label>
            {address && <a className="button link-button" href={address} target="_blank" rel="noopener noreferrer"
              aria-label={`打开来源 ${source.title}`}><ExternalLink size={14} aria-hidden="true" /> 查看</a>}
          </div>;
        })}
        {unknown.length > 0 && <p>当前选择中有 {unknown.length} 项未出现在此页。加载更多资料可核对。</p>}
        {unknown.length > 0 && !sourceCursor && <button type="button" className="button secondary" disabled={busy || offline}
          onClick={() => setPlan({ ...plan, sourceIds: plan.sourceIds.filter((id) => knownIds.has(id)) })}>清除不可用资料</button>}
        {sourceCursor && <button type="button" className="button secondary" disabled={busy || offline}
          onClick={() => void act(async (signal) => {
            const page = await client.listResearchSources({ limit: 20, cursor: sourceCursor }, signal);
            if (!signal.aborted) {
              setSources((known) => [...known, ...page.items.filter(({ id }) => !known.some((source) => source.id === id))]);
              setSourceCursor(page.nextCursor);
            }
          }, "暂时无法读取更多资料。")}>加载更多资料</button>}
      </fieldset>
      <div className="dialog-actions">
        <button type="button" className="button secondary" onClick={close}>关闭</button>
        <button type="submit" className="button primary" disabled={!plan.question.trim() || length > 256 ||
          !plan.sourceIds.length || !changed || offline || busy}>{selected ? "保存新版本" : "保存计划"}</button>
      </div>
    </form>
  </Modal>;
}
