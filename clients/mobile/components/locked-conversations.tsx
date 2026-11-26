import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Keyboard, Modal, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AssistantApiError, type AssistantClient } from '../../../packages/contracts/dist/index.js';
import { Action, palette, styles } from './ui';

export function LockedConversations({ client, close, onRestored, onSessionExpired }: {
  client: AssistantClient;
  close: () => void;
  onRestored: (id: string) => Promise<void>;
  onSessionExpired: (failure: AssistantApiError) => void;
}) {
  const active = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const passwordInput = useRef<TextInput>(null);
  const passwordValue = useRef('');
  const [hasPassword, setHasPassword] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const clearPassword = useCallback(() => {
    passwordValue.current = '';
    passwordInput.current?.clear();
    setHasPassword(false);
  }, []);

  const abort = useCallback(() => {
    pending.current?.abort();
    pending.current = null;
  }, []);

  const perform = useCallback(async (operation: (signal: AbortSignal) => Promise<void>, fallback: string) => {
    if (!active.current || pending.current) return;
    const request = new AbortController();
    const { signal } = request;
    pending.current = request;
    setBusy(true);
    setError('');
    const timeout = setTimeout(() => {
      if (pending.current !== request) return;
      abort();
      setBusy(false);
      setError('服务暂未确认操作。请刷新列表核对状态。');
    }, 8_000);
    try { await operation(signal); }
    catch (failure) {
      if (signal.aborted) return;
      if (failure instanceof AssistantApiError && failure.code === 'INVALID_CURRENT_PASSWORD') {
        setError('当前账号密码不正确。请重新输入。');
      } else if (failure instanceof AssistantApiError && failure.status === 401) onSessionExpired(failure);
      else if (failure instanceof AssistantApiError && failure.status === 429) setError('尝试过于频繁，请稍后再试。');
      else setError(fallback);
    } finally {
      clearTimeout(timeout);
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }, [abort, onSessionExpired]);

  const load = useCallback((after?: string) => {
    void perform(async (signal) => {
      const page = await client.listLockedConversations({ limit: 20, cursor: after }, signal);
      if (signal.aborted) return;
      const next = page.items.map(({ id }) => id);
      setIds((previous) => after ? [...new Set([...previous, ...next])] : next);
      setCursor(page.nextCursor);
    }, '暂时无法读取加锁对话。请重新读取。');
  }, [client, perform]);

  useEffect(() => {
    function update(state: string) {
      active.current = state === 'active';
      if (active.current) load();
      else {
        abort();
        clearPassword();
        setChosen(undefined);
        setIds([]);
        setCursor(null);
        setBusy(false);
        setError('');
      }
    }
    const subscription = AppState.addEventListener('change', update);
    update(AppState.currentState);
    return () => {
      subscription.remove();
      active.current = false;
      passwordValue.current = '';
      abort();
    };
  }, [abort, clearPassword, load]);

  function cancel() {
    abort();
    clearPassword();
    Keyboard.dismiss();
    setError('');
    setBusy(false);
    if (chosen) { setChosen(undefined); load(); }
    else close();
  }

  function submit() {
    if (!chosen || pending.current || !active.current) return;
    const password = passwordValue.current;
    clearPassword();
    Keyboard.dismiss();
    if (!password || new TextEncoder().encode(password).byteLength > 72) {
      setError('请输入当前账号密码。');
      return;
    }
    const id = chosen;
    void perform(async (signal) => {
      await client.unlockConversationReading(id, password, signal);
      if (signal.aborted) return;
      setChosen(undefined);
      setIds((current) => current.filter((item) => item !== id));
      await onRestored(id);
    }, '暂时无法解锁。请刷新列表核对状态。');
  }

  return <Modal visible onRequestClose={cancel}>
    <SafeAreaView style={styles.safe} accessibilityViewIsModal>
      <View style={styles.toolbar}>
        <Text accessibilityRole="header" style={[styles.heading, styles.flexibleHeading]}>加锁对话</Text>
        <Action title={chosen ? '返回编号列表' : '关闭加锁对话'} onPress={cancel} />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.thread}>
        {busy && <Text accessibilityLiveRegion="polite" style={styles.muted}>正在核对…</Text>}
        {!!error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
        {chosen ? <>
          <Text style={styles.label}>{`对话 ${chosen.slice(0, 8)}`}</Text>
          <TextInput key={chosen} ref={passwordInput} accessibilityLabel="当前账号密码" placeholder="当前账号密码"
            style={styles.input} placeholderTextColor={palette.muted} autoComplete="off" importantForAutofill="no"
            textContentType="none" autoCapitalize="none" autoCorrect={false} secureTextEntry contextMenuHidden
            maxLength={72} editable={!busy} onChangeText={(value) => { passwordValue.current = value; setHasPassword(!!value); }}
            onSubmitEditing={submit} />
          <Action title="确认解锁" primary disabled={busy || !hasPassword} onPress={submit} />
        </> : <>
          <Action title="刷新加锁对话" disabled={busy} onPress={() => load()} />
          {!ids.length && !busy && !error && <Text style={styles.muted}>暂无加锁对话。</Text>}
          {ids.map((id) => <Action key={id} title={`解锁对话 ${id.slice(0, 8)}`} disabled={busy}
            onPress={() => { setError(''); setChosen(id); }} />)}
          {cursor && <Action title="加载更多加锁对话" disabled={busy} onPress={() => load(cursor)} />}
        </>}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}
