import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { AssistantApiError, type AssistantClient, type components } from '../../../packages/contracts/dist/index.js';

export type ExportJob = components['schemas']['Job'];
export type ExportSource = { conversationId: string; messageId: string; title: string };

const pageSize = 15;

export function activeExport(job: ExportJob) {
  return job.status === 'queued' || job.status === 'running';
}

function latest(current: ExportJob, incoming: ExportJob) {
  return Date.parse(incoming.updatedAt) < Date.parse(current.updatedAt) || !activeExport(current) && activeExport(incoming)
    ? current : incoming;
}

export function useExportJobs(client: AssistantClient, describeError: (failure: unknown, fallback: string) => string) {
  const [jobs, setJobs] = useState<ExportJob[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [pending, setPending] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const mounted = useRef(false);
  const action = useRef(false);
  const activeIds = jobs.filter(activeExport).map(({ id }) => id).join(',');

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let current = true;
    client.listJobs({ limit: pageSize }).then((page) => {
      if (!current) return;
      setJobs((previous) => page.items.map((item) => {
        const known = previous.find(({ id }) => id === item.id);
        return known ? latest(known, item) : item;
      }));
      setCursor(page.nextCursor);
    }).catch((failure) => {
      if (current) setError(describeError(failure, '暂时无法读取后台任务。'));
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [client, describeError, revision]);

  useEffect(() => {
    if (!activeIds) return;
    const ids = activeIds.split(',');
    let current = true;
    let polling = false;
    async function poll() {
      if (!current || polling || AppState.currentState !== 'active') return;
      polling = true;
      try {
        const changes = await Promise.all(ids.map(async (id) => {
          try { return await client.getJob(id); }
          catch (failure) {
            if (failure instanceof AssistantApiError && failure.status === 404) return null;
            throw failure;
          }
        }));
        if (!current) return;
        const updates = new Map(ids.map((id, index) => [id, changes[index]]));
        setJobs((known) => known.flatMap((job) => {
          const next = updates.get(job.id);
          return next === undefined ? [job] : next ? [latest(job, next)] : [];
        }));
        setPollError('');
      } catch (failure) {
        if (current) setPollError(describeError(failure, '任务状态暂时无法刷新。'));
      } finally {
        polling = false;
      }
    }
    const timer = setInterval(() => void poll(), 1_500);
    return () => { current = false; clearInterval(timer); };
  }, [activeIds, client, describeError]);

  async function perform(id: string, request: () => Promise<void>, fallback: string) {
    if (action.current) return;
    action.current = true;
    setPending(id);
    setError('');
    try { await request(); }
    catch (failure) { if (mounted.current) setError(describeError(failure, fallback)); }
    finally {
      action.current = false;
      if (mounted.current) setPending(null);
    }
  }

  function refresh() {
    if (action.current || loading) return;
    setLoading(true);
    setError('');
    setRevision((value) => value + 1);
  }

  function queue(request: () => Promise<ExportJob>) {
    if (loading || submitted) return;
    void perform('queue', async () => {
      const job = await request();
      if (!mounted.current) return;
      setSubmitted(true);
      setJobs((previous) => [job, ...previous.filter(({ id }) => id !== job.id)]);
    }, '暂时无法提交导出，请重试。');
  }

  function cancel(job: ExportJob) {
    void perform(job.id, async () => {
      const result = await client.cancelJob(job.id);
      if (mounted.current) setJobs((previous) => previous.map((item) => item.id === result.id ? latest(item, result) : item));
    }, '暂时无法取消任务。');
  }

  function more() {
    if (!cursor || loading) return;
    void perform('more', async () => {
      const page = await client.listJobs({ limit: pageSize, cursor });
      if (!mounted.current) return;
      setJobs((previous) => [...previous, ...page.items.filter(({ id }) => !previous.some((item) => item.id === id))]);
      setCursor(page.nextCursor);
    }, '暂时无法读取更多任务。');
  }

  return { jobs, cursor, pending, loading, submitted, error, pollError: activeIds ? pollError : '', refresh, queue, cancel, more };
}
