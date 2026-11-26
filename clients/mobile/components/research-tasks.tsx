import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Modal, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AssistantApiError, type AssistantClient, type components } from '../../../packages/contracts/dist/index.js';
import { saveDownload } from '../lib/save-download';
import { Action, styles } from './ui';

type ResearchTask = components['schemas']['ResearchTask'];
type ResearchSource = components['schemas']['ResearchSource'];
const stateLabels: Record<ResearchTask['state'], string> = {
  awaiting_approval: '待确认', queued: '已排队', running: '正在整理',
  completed: '已完成', cancelled: '已取消', failed: '未完成',
};

async function sourcesForTask(client: AssistantClient, task: ResearchTask, signal: AbortSignal) {
  const missing = new Set(task.sourceIds);
  const sources = new Map<string, ResearchSource>();
  let cursor: string | null = null;
  do {
    const page = await client.listResearchSources({ limit: 50, cursor: cursor ?? undefined }, signal);
    for (const source of page.items) {
      if (missing.delete(source.id)) sources.set(source.id, source);
    }
    cursor = page.nextCursor;
  } while (cursor && missing.size && !signal.aborted);
  return task.sourceIds.map((id) => sources.get(id)).filter((source) => source !== undefined);
}

export function ResearchTasks({ client, close, onSessionExpired }: {
  client: AssistantClient;
  close: () => void;
  onSessionExpired: (failure: AssistantApiError) => void;
}) {
  const [items, setItems] = useState<ResearchTask[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<ResearchTask>();
  const [sources, setSources] = useState<ResearchSource[]>([]);
  const [busy, setBusy] = useState('');
  const [refreshNeeded, setRefreshNeeded] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const active = useRef(false);
  const pending = useRef<AbortController | null>(null);

  const abort = useCallback(() => {
    const request = pending.current;
    pending.current = null;
    request?.abort();
  }, []);

  const operate = useCallback(async (label: string, fallback: string, work: (signal: AbortSignal) => Promise<void>) => {
    if (!active.current || pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(label);
    setNotice('');
    setError('');
    try {
      await work(request.signal);
    } catch (failure) {
      if (request.signal.aborted) return;
      if (failure instanceof AssistantApiError && failure.status === 401) onSessionExpired(failure);
      else if (failure instanceof AssistantApiError && failure.status === 409) {
        setRefreshNeeded(true);
        setError('任务版本、状态或来源已变化，请刷新后重新检查。');
      } else if (failure instanceof AssistantApiError && [403, 404].includes(failure.status)) {
        setRefreshNeeded(true);
        setError('此研究任务或报告当前无法访问。');
      } else setError(fallback);
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy('');
      }
    }
  }, [onSessionExpired]);

  const loadTasks = useCallback((after?: string) => operate('正在读取任务…', '暂时无法读取研究任务。', async (signal) => {
    const page = await client.listResearchTasks({ limit: 25, cursor: after }, signal);
    if (signal.aborted) return;
    setItems((previous) => after ? [...previous, ...page.items.filter(({ id }) => !previous.some((item) => item.id === id))] : page.items);
    setCursor(page.nextCursor);
  }), [client, operate]);

  useEffect(() => {
    active.current = true;
    void loadTasks();
    return () => { active.current = false; abort(); };
  }, [abort, loadTasks]);

  function show(task: ResearchTask) {
    setSelected(task);
    setItems((previous) => previous.map((item) => item.id === task.id ? task : item));
    setRefreshNeeded(false);
  }

  function openTask(id: string) {
    void operate('正在读取当前计划…', '无法读取当前计划，请重试。', async (signal) => {
      const task = await client.getResearchTask(id, signal);
      const current = await sourcesForTask(client, task, signal);
      if (signal.aborted) return;
      show(task);
      setSources(current);
    });
  }

  function goBack() {
    abort();
    if (!selected) { close(); return; }
    setSelected(undefined);
    setSources([]);
    setBusy('');
    setRefreshNeeded(false);
    setNotice('');
    setError('');
  }

  function updateTask(task: ResearchTask, action: 'approve' | 'cancel') {
    const approving = action === 'approve';
    void operate(approving ? '正在确认计划…' : '正在取消任务…', approving ? '暂时无法确认计划。' : '暂时无法取消任务。', async (signal) => {
      const result = approving ? await client.approveResearchTask(task.id, task.revision, signal)
        : await client.cancelResearchTask(task.id, task.revision, signal);
      if (signal.aborted) return;
      show(result);
      setNotice(approving ? `已确认版本 ${task.revision}。` : '已取消研究任务。');
    });
  }

  function confirmTask(task: ResearchTask, action: 'approve' | 'cancel') {
    if (busy || refreshNeeded) return;
    if (action === 'approve') {
      Alert.alert(`确认版本 ${task.revision}`, `确认后将使用此版本的 ${task.sourceIds.length} 项收录资料生成报告。`, [
        { text: '取消', style: 'cancel' },
        { text: '确认', onPress: () => updateTask(task, 'approve') },
      ]);
    } else {
      Alert.alert('取消研究任务', `确认取消版本 ${task.revision} 的研究任务？`, [
        { text: '继续保留', style: 'cancel' },
        { text: '确认取消', style: 'destructive', onPress: () => updateTask(task, 'cancel') },
      ]);
    }
  }

  function saveReport(task: ResearchTask) {
    void operate('正在保存报告…', '无法保存报告，请刷新状态后重试。', async (signal) => {
      const name = await saveDownload(() => client.downloadResearchReport(task.id, task.revision, signal), {
        filename: `research-v${task.revision}-${randomUUID()}.txt`,
        contentType: 'text/plain', maxBytes: 1024 * 1024, signal,
      });
      if (name && !signal.aborted) setNotice(`已保存 ${name}。`);
    });
  }

  const awaiting = selected?.state === 'awaiting_approval';
  const working = selected?.state === 'queued' || selected?.state === 'running';
  const unavailableSources = selected ? selected.sourceIds.length - sources.length : 0;
  const actionsDisabled = !!busy || refreshNeeded;
  return <Modal visible onRequestClose={goBack}>
    <SafeAreaView style={styles.safe} accessibilityViewIsModal>
      <View style={styles.toolbar}>
        <Text accessibilityRole="header" style={[styles.heading, styles.flexibleHeading]}>研究任务</Text>
        <Action title={selected ? '返回任务' : '关闭研究'} onPress={goBack} />
      </View>
      <ScrollView contentContainerStyle={styles.thread} keyboardShouldPersistTaps="handled">
        {busy ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{busy}</Text> : null}
        {notice ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{notice}</Text> : null}
        {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
        {selected ? <>
          <Text accessibilityRole="header" style={styles.body}>{selected.question}</Text>
          <Text accessibilityLiveRegion="polite" style={styles.label}>版本 {selected.revision} · {stateLabels[selected.state]}</Text>
          {working && <Text accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: selected.progress }}
            style={styles.muted}>研究进度 {selected.progress}%</Text>}
          <Text style={styles.label}>计划来源</Text>
          {sources.map((source) => <Text key={source.id} style={styles.body}>{source.title}</Text>)}
          {unavailableSources > 0 && <Text style={styles.muted}>{unavailableSources} 项来源当前不可访问。</Text>}
          {selected.state === 'failed' && <Text style={styles.muted}>可在网页版检查来源并更新计划。</Text>}
          <View style={styles.actions}>
            <Action title="刷新状态" disabled={!!busy} onPress={() => openTask(selected.id)} />
            {awaiting && <Action title="确认此版本" primary disabled={actionsDisabled} onPress={() => confirmTask(selected, 'approve')} />}
            {(awaiting || working) && <Action title="取消任务" disabled={actionsDisabled} onPress={() => confirmTask(selected, 'cancel')} />}
            {selected.reportAvailable && <Action title="保存本版本报告" primary disabled={actionsDisabled} onPress={() => saveReport(selected)} />}
          </View>
        </> : <>
          <View style={styles.actions}>
            <Action title="刷新任务" disabled={!!busy} onPress={() => void loadTasks()} />
          </View>
          {!items.length && !busy && <Text style={styles.muted}>暂无研究任务。可在网页版新建计划。</Text>}
          {items.map((task) => <View key={task.id} style={styles.message}>
            <Text style={styles.muted}>版本 {task.revision} · {stateLabels[task.state]}</Text>
            <Action title={task.question} disabled={!!busy} onPress={() => openTask(task.id)} />
          </View>)}
          {cursor && <Action title="加载更多任务" disabled={!!busy} onPress={() => void loadTasks(cursor)} />}
        </>}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}
