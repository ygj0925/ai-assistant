import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { FlatList, Keyboard, KeyboardAvoidingView, Modal, Platform, ScrollView, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AssistantApiError, type AssistantClient, type components } from '../../../packages/contracts/dist/index.js';
import { displayTime, ReminderField, timePattern, validZone } from './reminder-field';
import { Action, styles } from './ui';

type Reminder = components['schemas']['Reminder'];
type ReminderInput = components['schemas']['ReminderInput'];
type Occurrence = components['schemas']['ReminderOccurrence'];
const cadenceLabels = { once: '一次', daily: '每日', weekly: '每周' } satisfies Record<ReminderInput['cadence'], string>;
const stateLabels = { active: '已启用', paused: '已暂停', completed: '已完成', expired: '已过期' } satisfies Record<Reminder['state'], string>;
const defaultZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

function validLocalDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || Number(value.slice(0, 4)) < 1900) return false;
  const calendar = new Date(`${value}Z`);
  return Number.isFinite(calendar.valueOf()) && calendar.toISOString().slice(0, 16) === value;
}

export function Reminders({ client, initialView = 'plans', close, onSessionExpired }: {
  client: AssistantClient;
  initialView?: 'plans' | 'history';
  close: () => void;
  onSessionExpired: (failure: AssistantApiError) => void;
}) {
  const [planRows, setPlanRows] = useState<Reminder[]>([]);
  const [deliveries, setDeliveries] = useState<Occurrence[]>([]);
  const [deliveryCursor, setDeliveryCursor] = useState<string | null>(null);
  const [view, setView] = useState<'plans' | 'history' | 'create'>(initialView);
  const [title, setTitle] = useState('');
  const [local, setLocal] = useState('');
  const [timeZone, setTimeZone] = useState(defaultZone);
  const [cadence, setCadence] = useState<ReminderInput['cadence']>('once');
  const [quiet, setQuiet] = useState(false);
  const [quietStart, setQuietStart] = useState('22:00');
  const [quietEnd, setQuietEnd] = useState('07:00');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef<AbortController | null>(null);
  const active = useRef(false);
  const createAttempt = useRef<{ signature: string; key: string } | undefined>(undefined);

  const abort = useCallback(() => {
    const request = pending.current;
    pending.current = null;
    request?.abort();
  }, []);

  const operate = useCallback(async (label: string, fallback: string, work: (signal: AbortSignal) => Promise<void>) => {
    if (pending.current || !active.current) return;
    const request = new AbortController();
    pending.current = request;
    setError('');
    setNotice('');
    setBusy(label);
    try { await work(request.signal); }
    catch (failure) {
      if (request.signal.aborted) return;
      if (failure instanceof AssistantApiError && failure.status === 401) onSessionExpired(failure);
      else if (failure instanceof AssistantApiError && failure.status === 400) setError('请核对提醒的内容、时区和时间。一次提醒需要选择未来时间。');
      else if (failure instanceof AssistantApiError && [403, 404].includes(failure.status)) setError('当前工作空间无法访问该提醒。');
      else setError(fallback);
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy('');
      }
    }
  }, [onSessionExpired]);

  const refresh = useCallback(() => operate('正在读取提醒…', '暂时无法刷新提醒。', async (signal) => {
    const [plans, history] = await Promise.all([
      client.listReminders({ limit: 50 }, signal),
      client.listReminderOccurrences({ limit: 20 }, signal),
    ]);
    if (signal.aborted) return;
    setPlanRows(plans.items);
    setDeliveries(history.items);
    setDeliveryCursor(history.nextCursor);
  }), [client, operate]);

  useEffect(() => {
    active.current = true;
    void refresh();
    return () => { active.current = false; abort(); };
  }, [abort, refresh]);

  function goBack() {
    abort();
    if (view !== 'create') { close(); return; }
    Keyboard.dismiss();
    setView('plans');
    setBusy('');
    setError('');
    setNotice('');
  }

  function create() {
    if (pending.current) return;
    const cleanedTitle = title.trim();
    const region = timeZone.trim();
    const startsAtLocal = local.trim().replace(' ', 'T');
    if (!cleanedTitle || [...cleanedTitle].length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(cleanedTitle)) {
      setError('请输入 1 至 200 个字符的提醒内容。'); return;
    }
    if (!validLocalDate(startsAtLocal)) { setError('请输入有效的本地日期和时间，例如 2026-11-30 09:30。'); return; }
    if (!validZone(region)) { setError('请输入有效的 IANA 时区，例如 Asia/Shanghai 或 UTC。'); return; }
    if (quiet && (!timePattern.test(quietStart) || !timePattern.test(quietEnd) || quietStart === quietEnd)) {
      setError('静默开始和结束需使用不同的 24 小时时间，格式为 HH:mm。'); return;
    }
    const input: ReminderInput = { title: cleanedTitle, startsAtLocal, timeZone: region, cadence,
      ...(quiet ? { quietHours: { start: quietStart, end: quietEnd } } : {}) };
    const signature = JSON.stringify(input);
    const key = createAttempt.current?.signature === signature ? createAttempt.current.key : randomUUID();
    createAttempt.current = { signature, key };
    Keyboard.dismiss();
    void operate('正在保存提醒…', '暂时无法保存提醒。', async (signal) => {
      const saved = await client.createReminder(input, key, signal);
      if (signal.aborted) return;
      createAttempt.current = undefined;
      setPlanRows((current) => [saved, ...current.filter(({ id }) => id !== saved.id)]);
      setTitle('');
      setLocal('');
      setTimeZone(defaultZone);
      setCadence('once');
      setQuiet(false);
      setQuietStart('22:00');
      setQuietEnd('07:00');
      setView('plans');
      setNotice('提醒已保存。');
    });
  }

  function toggle(row: Reminder) {
    const resume = row.state === 'paused';
    void operate('正在更新提醒…', '暂时无法更新提醒，请刷新后重试。', async (signal) => {
      const changed = await client.updateReminderState(row.id, resume, signal);
      if (signal.aborted) return;
      setPlanRows((current) => current.map((item) => item.id === changed.id ? changed : item));
      setNotice(resume ? '提醒已恢复。' : '提醒已暂停。');
    });
  }

  function markRead(row: Occurrence) {
    void operate('正在标记已读…', '暂时无法标记为已读。', async (signal) => {
      const changed = await client.markReminderOccurrenceRead(row.id, signal);
      if (!signal.aborted) setDeliveries((current) => current.map((item) => item.id === changed.id ? changed : item));
    });
  }

  function loadMore() {
    if (!deliveryCursor) return;
    void operate('正在读取记录…', '暂时无法读取更多送达记录。', async (signal) => {
      const page = await client.listReminderOccurrences({ limit: 20, cursor: deliveryCursor }, signal);
      if (signal.aborted) return;
      setDeliveries((current) => [...current, ...page.items.filter(({ id }) => !current.some((row) => row.id === id))]);
      setDeliveryCursor(page.nextCursor);
    });
  }

  return <Modal visible onRequestClose={goBack}>
    <SafeAreaView style={styles.safe} accessibilityViewIsModal>
      <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.toolbar}>
          <Text accessibilityRole="header" style={[styles.heading, styles.flexibleHeading]}>{view === 'create' ? '新建提醒' : '定时提醒'}</Text>
          <Action title={view === 'create' ? '返回提醒' : '关闭提醒'} onPress={goBack} />
        </View>
        {view !== 'create' && <View style={[styles.historyTools, styles.actions]}>
          <Action title="提醒计划" primary={view === 'plans'} selected={view === 'plans'} disabled={!!busy} onPress={() => setView('plans')} />
          <Action title="送达记录" primary={view === 'history'} selected={view === 'history'} disabled={!!busy} onPress={() => setView('history')} />
          <Action title="刷新提醒" disabled={!!busy} onPress={() => void refresh()} />
          {view === 'plans' && <Action title="新建提醒" disabled={!!busy} onPress={() => { setError(''); setNotice(''); setView('create'); }} />}
        </View>}
        {(busy || notice || error) && <View style={styles.jobControls}>
          {busy ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{busy}</Text> : null}
          {notice ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{notice}</Text> : null}
          {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
        </View>}
        {view === 'create' ? <ScrollView contentContainerStyle={styles.thread} keyboardShouldPersistTaps="handled">
          <ReminderField label="提醒内容" value={title} onChange={setTitle} limit={400} editable={!busy} />
          <ReminderField label="首次提醒时间" placeholder="YYYY-MM-DD HH:mm" value={local} onChange={setLocal} limit={16} editable={!busy} />
          <ReminderField label="IANA 时区" placeholder="Asia/Shanghai" value={timeZone} onChange={setTimeZone} limit={64} editable={!busy} />
          <Text style={styles.label}>重复规则</Text>
          <View style={styles.actions}>
            {(Object.keys(cadenceLabels) as ReminderInput['cadence'][]).map((repeat) =>
              <Action key={repeat} title={cadenceLabels[repeat]} primary={cadence === repeat} selected={cadence === repeat}
                disabled={!!busy} onPress={() => setCadence(repeat)} />)}
          </View>
          <View style={styles.actions}>
            <Text style={styles.body}>设置静默时段</Text>
            <Switch accessibilityLabel="设置静默时段" value={quiet} disabled={!!busy} onValueChange={setQuiet} />
          </View>
          {quiet && <>
            <ReminderField label="静默开始" placeholder="HH:mm" value={quietStart} onChange={setQuietStart} limit={5} editable={!busy} />
            <ReminderField label="静默结束" placeholder="HH:mm" value={quietEnd} onChange={setQuietEnd} limit={5} editable={!busy} />
            <Text style={styles.muted}>静默按所选时区计算。时段结束后送达。</Text>
          </>}
          <Action title="创建提醒" primary disabled={!!busy || !title.trim() || !local.trim()} onPress={create} />
        </ScrollView> : view === 'plans' ? <FlatList key="plans" data={planRows} keyExtractor={(row) => row.id}
          contentContainerStyle={styles.thread} ListEmptyComponent={busy ? null : <Text style={styles.muted}>暂无提醒。</Text>}
          renderItem={({ item }) => <View style={styles.message}>
            <Text style={styles.body}>{item.title}</Text>
            <Text style={styles.label}>{cadenceLabels[item.cadence]} · {stateLabels[item.state]}</Text>
            <Text style={styles.muted}>首次 {item.startsAtLocal.replace('T', ' ')}（{item.timeZone}）</Text>
            {item.quietHours && <Text style={styles.muted}>静默 {item.quietHours.start}–{item.quietHours.end}</Text>}
            {item.nextDeliveryAt && <Text style={styles.muted}>下次送达 {displayTime(item.nextDeliveryAt, item.timeZone)}</Text>}
            {(item.state === 'active' || item.state === 'paused') && <View style={styles.actions}>
              <Action title={item.state === 'active' ? '暂停' : '恢复'}
                accessibilityLabel={`${item.state === 'active' ? '暂停' : '恢复'} ${item.title}`} disabled={!!busy} onPress={() => toggle(item)} />
            </View>}
          </View>} /> : <FlatList key="history" data={deliveries} keyExtractor={(row) => row.id}
          contentContainerStyle={styles.thread} ListEmptyComponent={busy ? null : <Text style={styles.muted}>暂无送达记录。</Text>}
          ListFooterComponent={deliveryCursor ? <Action title="加载更多记录" disabled={!!busy} onPress={loadMore} /> : null}
          renderItem={({ item }) => <View style={styles.message}>
            <Text style={styles.body}>{item.title}</Text>
            <Text style={styles.label}>{item.outcome === 'expired' ? '已过期' : item.readAt ? '已送达 · 已读' : '已送达 · 未读'}</Text>
            <Text style={styles.muted}>{displayTime(item.occurredAt)}</Text>
            {item.outcome === 'delivered' && !item.readAt && <View style={styles.actions}>
              <Action title="标为已读" accessibilityLabel={`标为已读 ${item.title}`} disabled={!!busy} onPress={() => markRead(item)} />
            </View>}
          </View>} />}
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}
