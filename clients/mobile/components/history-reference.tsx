import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Modal, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AssistantApiError, type AssistantClient, type components } from '../../../packages/contracts/dist/index.js';
import { type Conversation } from '../lib/assistant';
import { Action, styles } from './ui';

type Data = components['schemas'];
export type Reference = Data['HistoryReferenceSelection'];
export type SourceTarget = { kind: 'history' | 'project'; conversationId: string; messageId: string };
type Reply = { id: string; excerpt: string };
type Receipt = { kind: 'history'; value: Data['HistoryReferenceReceipt'] }
  | { kind: 'project'; value: Data['ProjectMemorySources'] };

function useSourceRequest(onAccessDenied: (failure: AssistantApiError) => void) {
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => () => {
    pending.current?.abort();
    pending.current = null;
  }, []);

  const run = useCallback(async (work: (signal: AbortSignal) => Promise<void>, fallback: string) => {
    if (pending.current || AppState.currentState !== 'active') return;
    const request = new AbortController();
    pending.current = request;
    const { signal } = request;
    setBusy(true);
    setError('');
    const timer = setTimeout(() => {
      if (pending.current !== request) return;
      pending.current = null;
      request.abort();
      setBusy(false);
      setError(fallback);
    }, 8_000);
    try { await work(signal); }
    catch (failure) {
      if (signal.aborted || pending.current !== request) return;
      if (failure instanceof AssistantApiError && [401, 403, 404, 423].includes(failure.status)) onAccessDenied(failure);
      setError(fallback);
    } finally {
      clearTimeout(timer);
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }, [onAccessDenied]);

  return { run, busy, error };
}

function usesHistory(settings: Data['PersonalMemorySettings'] | Data['ProjectMemorySettings']) {
  return 'referenceHistory' in settings && settings.referenceHistory === true;
}

export function HistoryReferencePicker({ client, targetId, close, select, onSessionExpired }: {
  client: AssistantClient; targetId: string | null; close: () => void;
  select: (value: Reference) => void; onSessionExpired: (failure: AssistantApiError) => void;
}) {
  const [allowed, setAllowed] = useState<boolean>();
  const [list, setList] = useState<Data['ConversationPage']>();
  const [source, setSource] = useState<Conversation>();
  const [replies, setReplies] = useState<Reply[]>([]);
  const deny = useCallback((failure: AssistantApiError) => {
    setSource(undefined);
    setReplies([]);
    if (failure.status === 401) onSessionExpired(failure);
  }, [onSessionExpired]);
  const { run, busy, error } = useSourceRequest(deny);

  const browse = useCallback(async (signal: AbortSignal, after?: string) => {
    const page = await client.listConversations({ unfiled: true, limit: 20, cursor: after }, signal);
    if (signal.aborted) return;
    const items = page.items.filter(({ id, projectId }) => id !== targetId && !projectId);
    setList((current) => ({ ...page, items: after && current
      ? [...current.items, ...items.filter(({ id }) => !current.items.some((item) => item.id === id))] : items }));
  }, [client, targetId]);

  const refresh = useCallback(() => {
    void run(async (signal) => {
      setAllowed(undefined);
      setList(undefined);
      setSource(undefined);
      setReplies([]);
      const enabled = usesHistory(await client.getMemorySettings(undefined, signal));
      if (signal.aborted) return;
      setAllowed(enabled);
      if (enabled) await browse(signal);
    }, '暂时无法核对历史引用设置。');
  }, [browse, client, run]);

  useEffect(refresh, [refresh]);

  function choose(id: string) {
    void run(async (signal) => {
      const [settings, target] = await Promise.all([client.getMemorySettings(undefined, signal), client.getConversation(id, signal)]);
      if (signal.aborted) return;
      if (!usesHistory(settings)) { setAllowed(false); setList(undefined); return; }
      if (target.projectId || target.id === targetId) throw new Error('Source scope changed');
      const chosen: Reply[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listMessages(id, { limit: 100, cursor });
        if (signal.aborted) return;
        for (const item of page.items) {
          if (item.role !== 'assistant' || !item.generation) continue;
          chosen.push({ id: item.id, excerpt: [...item.content].slice(0, 160).join('') });
          if (chosen.length > 20) chosen.shift();
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      setSource(target);
      setReplies(chosen.reverse());
    }, '暂时无法读取这条对话的已完成回复。');
  }

  return <Modal visible onRequestClose={close}>
    <SafeAreaView style={styles.safe} accessibilityViewIsModal>
      <View style={styles.toolbar}>
        <Text accessibilityRole="header" style={[styles.heading, styles.flexibleHeading]}>引用历史回复</Text>
        <Action title="关闭历史引用" onPress={close} />
      </View>
      <ScrollView contentContainerStyle={styles.thread}>
        {allowed === false ? <Text style={styles.body}>请先在网页版「个人记忆」中开启聊天历史引用。</Text>
          : <Text style={styles.muted}>所选回复只会作为本次发送的附加上下文。</Text>}
        {busy && <Text accessibilityLiveRegion="polite" style={styles.muted}>正在核对来源…</Text>}
        {!!error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
        {!source && list && <>
          {!list.items.length && <Text style={styles.muted}>暂无可选的其他普通对话。</Text>}
          {list.items.map((item) => <Action key={item.id} title={item.title} disabled={busy}
            accessibilityLabel={`选择来源对话 ${item.title}`} onPress={() => choose(item.id)} />)}
          {list.nextCursor && <Action title="加载更多来源对话" disabled={busy}
            onPress={() => void run((signal) => browse(signal, list.nextCursor ?? undefined), '暂时无法读取更多对话。')} />}
        </>}
        {source && <>
          <Text accessibilityRole="header" style={styles.label}>{source.title}</Text>
          {!replies.length && <Text style={styles.muted}>此对话暂无已完成的助手回复。</Text>}
          {replies.map(({ id, excerpt }, index) => <View key={id} style={styles.message}>
            <Text style={styles.body}>{excerpt || '空回复'}</Text>
            <Action title="引用这条回复" accessibilityLabel={`引用第 ${index + 1} 条回复`} disabled={busy}
              onPress={() => select({ sourceConversationId: source.id, sourceMessageId: id })} />
          </View>)}
          <Action title="返回来源对话列表" disabled={busy} onPress={() => { setSource(undefined); setReplies([]); }} />
        </>}
        {(error || allowed === false) && <Action title="重新核对历史引用设置" disabled={busy} onPress={refresh} />}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

export function MessageSources({ client, target, close, openConversation, onAccessDenied }: {
  client: AssistantClient; target: SourceTarget; close: () => void;
  openConversation: (id: string) => Promise<void>; onAccessDenied: (failure: AssistantApiError) => void;
}) {
  const [receipt, setReceipt] = useState<Receipt>();
  const { run, busy, error } = useSourceRequest(onAccessDenied);
  const refresh = useCallback((open = false) => {
    void run(async (signal) => {
      setReceipt(undefined);
      if (target.kind === 'history') {
        const value = await client.getMessageHistoryReference(target.conversationId, target.messageId, signal);
        if (signal.aborted) return;
        setReceipt({ kind: 'history', value });
        if (open && value.status === 'available') await openConversation(value.sourceConversationId);
      } else {
        const value = await client.getMessageProjectMemorySources(target.conversationId, target.messageId, signal);
        if (!signal.aborted) setReceipt({ kind: 'project', value });
      }
    }, '暂时无法核对这条回复的来源。');
  }, [client, openConversation, run, target]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return <Modal visible onRequestClose={close}>
    <SafeAreaView style={styles.safe} accessibilityViewIsModal>
      <View style={styles.toolbar}>
        <Text accessibilityRole="header" style={[styles.heading, styles.flexibleHeading]}>
          {target.kind === 'history' ? '历史回复来源' : '项目记忆来源'}
        </Text>
        <Action title="关闭来源" onPress={close} />
      </View>
      <ScrollView contentContainerStyle={styles.thread}>
        <Action title="重新核对来源" disabled={busy} onPress={() => refresh()} />
        {busy && <Text accessibilityLiveRegion="polite" style={styles.muted}>正在核对来源…</Text>}
        {!!error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
        {receipt?.kind === 'history' && (receipt.value.status === 'available' ? <>
          <Text accessibilityLiveRegion="polite" style={styles.body}>{`来源回复 ${receipt.value.sourceMessageId.slice(0, 8)}`}</Text>
          <Action title="打开来源对话" disabled={busy} onPress={() => refresh(true)} />
        </> : <Text accessibilityLiveRegion="polite" style={styles.muted}>此回复曾使用历史来源。当前无法再次访问。</Text>)}
        {receipt?.kind === 'project' && receipt.value.items.map((item, index) => <View style={styles.message} key={index}>
          {item.status === 'available' ? <>
            <Text style={styles.label}>{`项目记忆 ${item.entryId.slice(0, 8)}`}</Text>
            <Text style={styles.body}>{item.excerpt}</Text>
          </> : <Text accessibilityLiveRegion="polite" style={styles.muted}>此项项目记忆当前不可访问。</Text>}
        </View>)}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}
