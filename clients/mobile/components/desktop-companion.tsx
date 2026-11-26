import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Keyboard, KeyboardAvoidingView, Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AssistantApiError, type AssistantClient, type components } from '../../../packages/contracts/dist/index.js';
import { displayTime } from './reminder-field';
import { Action, palette, styles } from './ui';

type Data = components['schemas'];
type Pair = Data['DesktopCompanionPair'];
type Task = Data['DesktopCompanionTask'];
type Snapshot = { pair?: Pair; task?: Task };
const codePattern = /^[0-9A-HJKMNP-TV-Z]{12}$/;
const taskStates = { pending: '待确认', approved: '已批准', declined: '已拒绝', consumed: '桌面已领取批准' } satisfies Record<Task['status'], string>;

function mobileState(value: Data['DesktopCompanionState']): Snapshot {
  const pair = value.pair;
  if (!pair || pair.role !== 'mobile' || Date.parse(pair.expiresAt) <= Date.now()) return {};
  const task = pair.state === 'active' && value.task && Date.parse(value.task.expiresAt) > Date.now() ? value.task : undefined;
  return { pair, task };
}

export function DesktopCompanion({ client, close, onSessionExpired }: {
  client: AssistantClient; close: () => void; onSessionExpired: (error: AssistantApiError) => void;
}) {
  const [code, setCode] = useState('');
  const [view, setView] = useState<Snapshot>();
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const quietRead = useRef(false);
  const active = useRef(false);

  const abort = useCallback(() => {
    pending.current?.abort();
    pending.current = null;
    quietRead.current = false;
  }, []);

  const operate = useCallback(async (label: string, fallback: string, work: (signal: AbortSignal) => Promise<void>, quiet = false) => {
    if (!active.current || pending.current && (quiet || !quietRead.current)) return;
    if (pending.current) abort();
    const request = new AbortController();
    pending.current = request;
    quietRead.current = quiet;
    const { signal } = request;
    if (!quiet) { setBusy(label); setError(''); setNotice(''); }
    const timer = setTimeout(() => {
      if (pending.current !== request) return;
      abort();
      setCode('');
      setView(undefined);
      setBusy('');
      setNotice('');
      setError('无法核对桌面授权。请联网后刷新。');
    }, 4500);
    try { await work(signal); }
    catch (failure) {
      if (signal.aborted) return;
      setView(undefined);
      setCode('');
      if (failure instanceof AssistantApiError && failure.status === 401) onSessionExpired(failure);
      else if (failure instanceof AssistantApiError && failure.status === 429) setError('尝试次数过多，请稍后再试。');
      else setError(fallback);
    } finally {
      clearTimeout(timer);
      if (pending.current === request) {
        pending.current = null;
        quietRead.current = false;
        setBusy('');
      }
    }
  }, [abort, onSessionExpired]);

  const refresh = useCallback((quiet = false) => operate('正在核对桌面授权…', '无法核对桌面授权。请联网后刷新。', async (signal) => {
    const result = mobileState(await client.getDesktopCompanionState(signal));
    if (!signal.aborted) { setView(result); setError(''); }
  }, quiet), [client, operate]);

  useEffect(() => {
    function update(state: string) {
      active.current = state === 'active';
      if (active.current) { void refresh(); return; }
      abort();
      setCode('');
      setView(undefined);
      setError('');
      setBusy('');
      setNotice('');
    }
    const subscription = AppState.addEventListener('change', update);
    const timer = setInterval(() => void refresh(true), 4000);
    update(AppState.currentState);
    return () => { active.current = false; subscription.remove(); clearInterval(timer); abort(); };
  }, [abort, refresh]);

  function claim() {
    if (!codePattern.test(code)) return;
    Keyboard.dismiss();
    void operate('正在请求配对…', '配对码已失效或账号范围不匹配，请向桌面重新核对。', async (signal) => {
      const next = mobileState(await client.claimDesktopCompanionOffer({ code }, signal));
      if (!signal.aborted) { setCode(''); setView(next); }
    });
  }

  function decide(pair: Pair, task: Task, decision: 'approve' | 'decline') {
    void operate('正在提交决定…', '当前修订或设备授权已变化。请刷新核对。', async (signal) => {
      const { scopeId, revision, sourceSha256 } = task;
      const next = mobileState(await client.decideDesktopCompanionTask(pair.id, task.id, { scopeId, revision, sourceSha256, decision }, signal));
      if (!signal.aborted) {
        setView(next);
        setNotice(decision === 'approve' ? '已批准所核对的修订。' : '已拒绝所核对的修订。');
      }
    });
  }

  function revoke(pair: Pair) {
    void operate('正在解除配对…', '尚未确认解除配对结果。请刷新核对。', async (signal) => {
      await client.revokeDesktopCompanionPair(pair.id, signal);
      if (!signal.aborted) { setView({}); setCode(''); setNotice('已解除桌面配对。'); }
    });
  }

  const pair = view?.pair;
  const task = view?.task;
  const exit = () => { abort(); Keyboard.dismiss(); close(); };
  return <Modal visible onRequestClose={exit}>
    <SafeAreaView style={styles.safe} accessibilityViewIsModal>
      <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.toolbar}>
          <Text accessibilityRole="header" style={[styles.heading, styles.flexibleHeading]}>桌面接续</Text>
          <Action title="关闭桌面接续" onPress={exit} />
        </View>
        <ScrollView contentContainerStyle={styles.thread} keyboardShouldPersistTaps="handled">
          <Action title="刷新桌面接续" disabled={!!busy} onPress={() => void refresh()} />
          {!!busy && <Text accessibilityLiveRegion="polite" style={styles.muted}>{busy}</Text>}
          {!!notice && <Text accessibilityLiveRegion="polite" style={styles.muted}>{notice}</Text>}
          {!!error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
          {view && !pair && <View style={styles.message}>
            <Text style={styles.body}>在同一账号的桌面工作台生成配对码，然后在此输入。</Text>
            <Text style={styles.label}>桌面配对码</Text>
            <TextInput accessibilityLabel="桌面配对码" autoCapitalize="characters" autoCorrect={false}
              maxLength={12} value={code} onChangeText={(value) => setCode(value.toUpperCase())}
              placeholder="12 位配对码" placeholderTextColor={palette.muted} editable={!busy} style={styles.input} />
            <Action title="请求桌面配对" primary disabled={!!busy || !codePattern.test(code)} onPress={claim} />
          </View>}
          {pair && <View style={styles.message}>
            <Text style={styles.body}>{pair.state === 'active' ? '已配对桌面' : '等待桌面确认配对'}</Text>
            <Text style={styles.muted}>桌面设备 {pair.peerDevice} · 到期 {displayTime(pair.expiresAt)}</Text>
            <Action title="解除桌面配对" disabled={!!busy} onPress={() => revoke(pair)} />
          </View>}
          {pair?.state === 'active' && !task && <Text style={styles.muted}>暂无可核对的桌面修订。</Text>}
          {pair && task && <View style={styles.message}>
            <Text accessibilityRole="header" style={styles.label}>JavaScript 语法验证</Text>
            <Text style={styles.body}>第 {task.revision} 版 · {taskStates[task.status]}</Text>
            <Text style={styles.muted}>核对桌面显示的目录授权标识和源码摘要。</Text>
            <Text style={styles.muted}>目录授权 {task.scopeId.slice(0, 8)}</Text>
            <Text style={styles.label}>源码 SHA-256</Text>
            <Text style={[styles.body, companionStyles.digest]}>{task.sourceSha256}</Text>
            <Text style={styles.muted}>任务到期 {displayTime(task.expiresAt)}</Text>
            {task.status === 'pending' && <View style={styles.actions}>
              <Action title="批准此修订的语法验证" primary disabled={!!busy} onPress={() => decide(pair, task, 'approve')} />
              <Action title="拒绝此修订" disabled={!!busy} onPress={() => decide(pair, task, 'decline')} />
            </View>}
          </View>}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

const companionStyles = StyleSheet.create({
  digest: { fontFamily: Platform.select({ android: 'monospace', ios: 'Menlo' }) },
});
