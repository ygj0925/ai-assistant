"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { AssistantApiError, type AssistantClient, type components } from "@ai-assistant/contracts";
import { downloadBlob, idempotencyKey } from "@/lib/assistant";
import { Modal } from "./modal";

type Job = components["schemas"]["Job"];
type ExportSource = { conversationId: string; messageId: string; title: string };
const statusLabels: Record<Job["status"], string> = {
  queued: "排队中", running: "处理中", completed: "已完成", cancelled: "已取消", failed: "失败",
};
const timestamp = new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" });

function active(job: Job) {
  return job.status === "queued" || job.status === "running";
}

export function BackgroundJobs({ client, offline, source, close, describeError, returnFocus }: {
  client: AssistantClient;
  offline: boolean;
  source?: ExportSource;
  close: () => void;
  describeError: (error: unknown, fallback: string) => string;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listVersion, setListVersion] = useState(0);
  const [started, setStarted] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const action = useRef(false);
  const key = useRef<string | undefined>(undefined);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const activeIds = jobs.filter(active).map(({ id }) => id).join(",");

  useEffect(() => {
    if (offline) return;
    let current = true;
    client.listJobs({ limit: 15 }).then((page) => {
      if (!current) return;
      setJobs(page.items);
      setCursor(page.nextCursor);
    }).catch((failure) => {
      if (current) setError(describeError(failure, "暂时无法读取后台任务。"));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [client, describeError, listVersion, offline]);

  useEffect(() => {
    if (!activeIds || offline) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    const ids = activeIds.split(",");
    async function poll() {
      try {
        const states = await Promise.all(ids.map(async (id) => {
          try {
            return await client.getJob(id);
          } catch (failure) {
            if (failure instanceof AssistantApiError && failure.status === 404) return null;
            throw failure;
          }
        }));
        if (!current) return;
        const updates = new Map(ids.map((id, index) => [id, states[index]]));
        setJobs((previous) => previous.flatMap((job) => {
          if (!updates.has(job.id)) return [job];
          const updated = updates.get(job.id);
          if (!updated) return [];
          if (updated.updatedAt < job.updatedAt || !active(job) && active(updated)) return [job];
          return [updated];
        }));
        setPollError("");
      } catch (failure) {
        if (current) setPollError(describeError(failure, "任务状态暂时无法刷新。"));
      } finally {
        if (current) timer = setTimeout(poll, 1_500);
      }
    }
    timer = setTimeout(poll, 1_500);
    return () => { current = false; clearTimeout(timer); };
  }, [activeIds, client, describeError, offline]);

  async function perform(id: string, run: () => Promise<void>, fallback: string) {
    if (offline || action.current) return;
    action.current = true;
    setPending(id);
    setError("");
    try {
      await run();
    } catch (failure) {
      setError(describeError(failure, fallback));
    } finally {
      setPending(null);
      action.current = false;
    }
  }

  function queue() {
    if (!source) return;
    void perform("start", async () => {
      key.current ??= idempotencyKey();
      const job = await client.queueConversationExport(source.conversationId, source.messageId, key.current);
      setStarted(true);
      setJobs((current) => [job, ...current.filter((known) => known.id !== job.id)]);
    }, "暂时无法提交导出任务。请重试。");
  }

  function cancel(job: Job) {
    void perform(job.id, async () => {
      const updated = await client.cancelJob(job.id);
      setJobs((current) => current.map((known) => known.id === job.id ? updated : known));
    }, "暂时无法取消任务。");
  }

  function download(job: Job) {
    void perform(job.id, async () => {
      const blob = await client.downloadJobArtifact(job.id);
      downloadBlob(`对话导出-${job.id.slice(0, 8)}.md`, blob);
    }, "暂时无法下载导出文件。");
  }

  return <Modal label="后台任务" className="action-dialog jobs-dialog" returnFocus={returnFocus} close={() => {
    if (!action.current) close();
  }}>
    <div className="job-toolbar">
      <h2>后台任务</h2>
      <button type="button" className="button secondary" disabled={pending !== null} onClick={close} autoFocus>关闭</button>
    </div>
    {source && <div className="job-export">
      <p>将「{source.title}」当前分支导出为 Markdown。关闭窗口后任务仍会继续。</p>
      <button type="button" className="button primary" disabled={offline || loading || pending !== null || started} onClick={queue}>
        {started ? "已提交" : pending === "start" ? "正在提交…" : "开始导出"}
      </button>
    </div>}
    {offline && <p role="status">网络已断开，联网后可继续查看任务。</p>}
    {error && <p className="error-box" role="alert">{error}</p>}
    {pollError && <p role="status">{pollError}</p>}
    <div className="job-toolbar">
      <h3>导出记录</h3>
      <button type="button" className="button" disabled={offline || loading || pending !== null} onClick={() => {
        setLoading(true);
        setError("");
        setListVersion((version) => version + 1);
      }}>刷新</button>
    </div>
    {loading && !offline && <p role="status">正在读取任务…</p>}
    {!loading && !jobs.length && !error && <p>暂无任务。</p>}
    <ul className="job-list" aria-label="导出任务">
      {jobs.map((job) => <li key={job.id} className="job-row">
        <div>
          <strong>对话导出</strong>
          <div><time dateTime={job.createdAt}>{timestamp.format(new Date(job.createdAt))}</time></div>
          <span role="status">{statusLabels[job.status]}{active(job) && ` ${job.progress}%`}</span>
          {job.errorCode === "EXPORT_TOO_LARGE" && <div>当前分支超过导出大小限制。</div>}
        </div>
        {active(job) && <button type="button" className="button secondary" disabled={offline || pending !== null} onClick={() => cancel(job)}>取消任务</button>}
        {job.status === "completed" && <button type="button" className="button secondary" disabled={offline || pending !== null} onClick={() => download(job)}>下载 Markdown</button>}
      </li>)}
    </ul>
    {cursor && <button type="button" className="button" disabled={offline || loading || pending !== null} onClick={() => {
      void perform("more", async () => {
        const page = await client.listJobs({ cursor, limit: 15 });
        setJobs((current) => [...current, ...page.items.filter((job) => !current.some(({ id }) => id === job.id))]);
        setCursor(page.nextCursor);
      }, "暂时无法读取更多任务。");
    }}>加载更多</button>}
  </Modal>;
}
