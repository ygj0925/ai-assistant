import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Keyboard, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AssistantApiError, type AssistantClient, type components } from '../../../packages/contracts/dist/index.js';
import { displayTime, ReminderField, timePattern, validZone } from './reminder-field';
import { Action, styles } from './ui';

type Data = components['schemas'];
type Preferences = Data['ProactivePreferences'];
type Input = Data['ProactivePreferencesWrite'];
type Suggestion = Data['ProactiveSuggestions']['items'][number];
type Panel = 'settings' | 'suggestions';

const roles = { reminder_review: '核对提醒', schedule_planner: '规划日程' } satisfies Record<Input['role'], string>;
const notifications = { in_app: '站内通知', silent: '静音' } satisfies Record<Input['notification'], string>;
const suggestionLabels = {
  review_reminders: { title: '检查未读提醒', action: '查看送达记录', target: 'history' },
  review_upcoming: { title: '核对近期提醒', action: '查看提醒计划', target: 'plans' },
} as const satisfies Record<Suggestion['kind'], { title: string; action: string; target: 'history' | 'plans' }>;

function draftOf({ enabled, role, notification, timeZone, quietHours }: Preferences): Input {
  return { enabled, role, notification, timeZone, ...(quietHours && { quietHours }) };
}

function policyMatches(left: Preferences, right: Preferences) {
  return left.updatedAt === right.updatedAt && left.enabled === right.enabled && left.role === right.role
    && left.notification === right.notification && left.timeZone === right.timeZone
    && left.quietHours?.start === right.quietHours?.start && left.quietHours?.end === right.quietHours?.end;
}

export function Proactive({ client, close, openReminders, onSessionExpired }: {
  client: AssistantClient; close: () => void; openReminders: (target: 'plans' | 'history') => void;
  onSessionExpired: (failure: AssistantApiError) => void;
}) {
  const [panel, setPanel] = useState<Panel>('settings');
  const [saved, setSaved] = useState<Preferences>();
  const [draft, setDraft] = useState<Input>();
  const [items, setItems] = useState<Suggestion[]>([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const lastSaved = useRef<Preferences | undefined>(undefined);
  const pending = useRef<AbortController | null>(null);
  const checking = useRef(false);
  const active = useRef(false);
  const quietHours = draft?.quietHours;

  const clear = useCallback(() => {
    lastSaved.current = undefined;
    setSaved(undefined);
    setDraft(undefined);
    setItems([]);
    setNotice('');
  }, []);

  const abort = useCallback(() => {
    pending.current?.abort();
    pending.current = null;
    checking.current = false;
  }, []);

  const operate = useCallback(async (label: string, fallback: string, work: (signal: AbortSignal) => Promise<void>, quiet = false) => {
    if (!active.current || (pending.current && (quiet || !checking.current))) return;
    if (pending.current) abort();
    const request = new AbortController();
    pending.current = request;
    checking.current = quiet;
    const { signal } = request;
    if (!quiet) { setBusy(label); setError(''); }
    const timer = setTimeout(() => {
      if (pending.current !== request) return;
      abort();
      clear();
      setBusy('');
      setError('暂时无法核对当前设置。请联网后刷新。');
    }, 5000);
    try { await work(signal); }
    catch (failure) {
      if (signal.aborted) return;
      clear();
      if (failure instanceof AssistantApiError && failure.status === 401) onSessionExpired(failure);
      else if (failure instanceof AssistantApiError && [403, 404, 409].includes(failure.status)) {
        setError('当前工作空间的主动助手不可访问。');
      } else setError(fallback);
    } finally {
      clearTimeout(timer);
      if (pending.current === request) { pending.current = null; checking.current = false; setBusy(''); }
    }
  }, [abort, clear, onSessionExpired]);

  const refresh = useCallback((quiet = false) => operate('正在核对设置…', '暂时无法核对当前设置。请联网后刷新。', async (signal) => {
    const next = await client.getProactivePreferences(signal);
    const candidates = next.enabled && next.notification === 'in_app' ? (await client.listProactiveSuggestions(signal)).items : [];
    if (signal.aborted) return;
    const previous = lastSaved.current;
    lastSaved.current = next;
    setSaved(next);
    if (!previous || !policyMatches(previous, next)) setDraft(draftOf(next));
    setItems(candidates);
  }, quiet), [client, operate]);

  useEffect(() => {
    function update(state: string) {
      active.current = state === 'active';
      if (active.current) { void refresh(); return; }
      abort();
      clear();
      setBusy('');
      setError('');
    }
    const subscription = AppState.addEventListener('change', update);
    update(AppState.currentState);
    const timer = setInterval(() => { if (lastSaved.current) void refresh(true); }, 8000);
    return () => { active.current = false; subscription.remove(); clearInterval(timer); abort(); };
  }, [abort, clear, refresh]);

  function edit<Key extends keyof Input>(key: Key, value: Input[Key]) {
    setError('');
    setNotice('');
    setDraft((previous) => previous && { ...previous, [key]: value });
  }

  function save() {
    if (!draft || !saved || !lastSaved.current || !policyMatches(lastSaved.current, saved)) return;
    const timeZone = draft.timeZone.trim();
    const quietHours = draft.quietHours;
    const invalidTimeZone = !validZone(timeZone);
    const invalidQuiet = quietHours && (!timePattern.test(quietHours.start) || !timePattern.test(quietHours.end)
      || quietHours.start === quietHours.end);
    const preserveExisting = saved.enabled && !draft.enabled && (invalidTimeZone || invalidQuiet);
    if (!preserveExisting && invalidTimeZone) { setError('请输入有效的 IANA 时区，例如 Asia/Shanghai 或 UTC。'); return; }
    if (!preserveExisting && invalidQuiet) { setError('静默开始和结束需使用不同的 24 小时时间，格式为 HH:mm。'); return; }
    const input = preserveExisting ? { ...draftOf(saved), enabled: false } : { ...draft, timeZone };
    Keyboard.dismiss();
    void operate('正在保存设置…', '尚未确认保存结果。请刷新查看。', async (signal) => {
      const next = await client.updateProactivePreferences(input, signal);
      if (signal.aborted) return;
      lastSaved.current = next;
      setSaved(next);
      setDraft(draftOf(next));
      setItems([]);
      setNotice(preserveExisting ? '已关闭主动助手，并保留上次保存的时区和静默时段。' : '主动助手设置已保存。');
    });
  }

  function dismiss(item: Suggestion) {
    void operate('正在移除建议…', '尚未确认移除结果。请刷新查看。', async (signal) => {
      await client.dismissProactiveSuggestion(item.id, signal);
      if (!signal.aborted) {
        setItems((current) => current.filter(({ id }) => id !== item.id));
        setNotice('已忽略这条建议。');
      }
    });
  }

  function selectPanel(next: Panel) {
    if (next === panel) return;
    Keyboard.dismiss();
    setPanel(next);
    if (next === 'suggestions') { setItems([]); void refresh(); }
  }

  function closePanel() { abort(); Keyboard.dismiss(); close(); }

  return <Modal visible onRequestClose={closePanel}>
    <SafeAreaView style={styles.safe} accessibilityViewIsModal>
      <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.toolbar}>
          <Text accessibilityRole="header" style={[styles.heading, styles.flexibleHeading]}>主动助手</Text>
          <Action title="关闭主动助手页面" onPress={closePanel} />
        </View>
        <ScrollView contentContainerStyle={styles.thread} keyboardShouldPersistTaps="handled">
          <View style={styles.actions}>
            <Action title="主动助手设置" primary={panel === 'settings'} selected={panel === 'settings'} disabled={!!busy}
              onPress={() => selectPanel('settings')} />
            <Action title="查看建议" primary={panel === 'suggestions'} selected={panel === 'suggestions'} disabled={!!busy}
              onPress={() => selectPanel('suggestions')} />
            <Action title="刷新主动助手" disabled={!!busy} onPress={() => void refresh()} />
          </View>
          {!!busy && <Text accessibilityLiveRegion="polite" style={styles.muted}>{busy}</Text>}
          {!!error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
          {!!notice && <Text accessibilityLiveRegion="polite" style={styles.muted}>{notice}</Text>}
          {saved && <Text style={styles.label}>{saved.enabled ? '主动助手已启用' : '主动助手已关闭'}</Text>}
          {panel === 'settings' && draft && <View style={styles.message}>
            <View style={toggleStyles.row}>
              <Text style={styles.body}>启用主动助手</Text>
              <Switch accessibilityLabel="启用主动助手" disabled={!!busy} value={draft.enabled} onValueChange={(value) => edit('enabled', value)} />
            </View>
            <Text style={styles.label}>角色</Text>
            <View style={styles.actions}>
              {(Object.keys(roles) as Input['role'][]).map((role) => <Action key={role} title={roles[role]}
                primary={draft.role === role} selected={draft.role === role} disabled={!!busy} onPress={() => edit('role', role)} />)}
            </View>
            <Text style={styles.label}>通知方式</Text>
            <View style={styles.actions}>
              {(Object.keys(notifications) as Input['notification'][]).map((notification) => <Action key={notification} title={notifications[notification]}
                primary={draft.notification === notification} selected={draft.notification === notification} disabled={!!busy}
                onPress={() => edit('notification', notification)} />)}
            </View>
            <ReminderField label="IANA 时区" placeholder="Asia/Shanghai" value={draft.timeZone} onChange={(value) => edit('timeZone', value)}
              limit={64} editable={!busy} />
            <View style={toggleStyles.row}>
              <Text style={styles.body}>设置静默时段</Text>
              <Switch accessibilityLabel="设置静默时段" disabled={!!busy} value={!!draft.quietHours}
                onValueChange={(value) => edit('quietHours', value ? { start: '22:00', end: '07:00' } : undefined)} />
            </View>
            {quietHours && <>
              <ReminderField label="静默开始" placeholder="HH:mm" value={quietHours.start} limit={5} editable={!busy}
                onChange={(start) => edit('quietHours', { ...quietHours, start })} />
              <ReminderField label="静默结束" placeholder="HH:mm" value={quietHours.end} limit={5} editable={!busy}
                onChange={(end) => edit('quietHours', { ...quietHours, end })} />
            </>}
            <Action title="保存主动助手设置" primary disabled={!!busy} onPress={save} />
          </View>}
          {panel === 'suggestions' && saved && <>
            <Text style={styles.muted}>建议来自当前工作空间的提醒，打开后由你决定如何处理。</Text>
            {!items.length && <Text style={styles.muted}>暂无可显示的建议。</Text>}
            {items.map((item) => {
              const label = suggestionLabels[item.kind];
              if (!label) return null;
              return <View key={item.id} style={styles.message}>
                <Text style={styles.label}>{label.title}</Text>
                <Text style={styles.muted}>{displayTime(item.createdAt, saved.timeZone)}</Text>
                <View style={styles.actions}>
                  <Action title={label.action} disabled={!!busy} onPress={() => { abort(); openReminders(label.target); }} />
                  <Action title="忽略建议" accessibilityLabel={`忽略 ${label.title}`} disabled={!!busy} onPress={() => dismiss(item)} />
                </View>
              </View>;
            })}
          </>}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

const toggleStyles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', minHeight: 48, gap: 8 },
});
