import { randomUUID } from 'expo-crypto';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, AppState, FlatList, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable,
  ScrollView, StatusBar, Text, TextInput, View, type AppStateStatus, type ListRenderItemInfo, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { AssistantApiError, type AssistantClient } from '../../packages/contracts/dist/index.js';
import {
  clearBookmark, clearLocalSession, createClient, isActive, listMessages, messageText,
  readBookmark, readSession, saveBookmark, saveSession,
  type Conversation, type Message, type Model, type RunRequest, type Session,
} from './lib/assistant';
import { Action, palette, styles } from './components/ui';
import { Learning } from './components/learning';
import { HistoryReferencePicker, MessageSources, type Reference, type SourceTarget } from './components/history-reference';
import { LockedConversations } from './components/locked-conversations';
import { PrivateArtifacts } from './components/private-artifacts';
import { ProjectMedia, type MediaKind } from './components/project-media';
import { ProjectImages } from './components/project-images';
import { ProjectText } from './components/project-text';
import { Proactive } from './components/proactive';
import { DesktopCompanion } from './components/desktop-companion';
import { ResearchTasks } from './components/research-tasks';
import { Reminders } from './components/reminders';
import { SharedDrafts } from './components/shared-drafts';
import { useRun } from './lib/use-run';
import { readAloudViewability, useReadAloud } from './lib/use-read-aloud';
import { useLocalDictation } from './lib/use-local-dictation';
import { activeExport, useExportJobs, type ExportJob, type ExportSource } from './lib/use-export-jobs';

const client = createClient();
const itemKey = ({ id }: { id: string }) => id;
type ReadState = 'ready' | 'checking' | 'unavailable';
const lockedMessage = '此对话已加锁。可在加锁对话中恢复阅读。';

export default function App() {
  return <SafeAreaProvider><SafeAreaView style={styles.safe}>
    <StatusBar barStyle="dark-content" />
    {client ? <Account client={client} /> : <View style={styles.center}>
      <Text style={styles.heading}>青屿助手</Text>
      <Text style={styles.muted}>需要配置助手服务的 HTTPS 地址。</Text>
    </View>}
  </SafeAreaView></SafeAreaProvider>;
}

function Account({ client }: { client: AssistantClient }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [registering, setRegistering] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [restoreFailed, setRestoreFailed] = useState(false);
  const authPending = useRef(false);

  async function restore() {
    if (authPending.current) return;
    authPending.current = true;
    setLoading(true);
    setError('');
    setRestoreFailed(false);
    try {
      const saved = await readSession();
      if (!saved) return;
      await client.replaceSession(saved);
      const user = await client.getAccount();
      setSession({ ...saved, user });
    } catch (failure) {
      await client.replaceSession(null);
      if (failure instanceof AssistantApiError && failure.status === 401) {
        await clearLocalSession().catch(() => undefined);
      }
      else setRestoreFailed(true);
      setError(messageText(failure));
    } finally {
      authPending.current = false;
      setLoading(false);
    }
  }

  useEffect(() => { void restore(); }, []);

  async function authenticate() {
    const name = username.trim();
    if (authPending.current || !name || !password) return;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(name)) {
      setError('用户名须为 3–32 个字符，以字母或数字开头，可使用下划线和连字符。');
      return;
    }
    if (new TextEncoder().encode(password).byteLength > 72 || (registering && [...password].length < 12)) {
      setError(registering ? '密码至少 12 个字符，最多 72 字节。' : '密码最多 72 字节。');
      return;
    }
    authPending.current = true;
    setLoading(true);
    setError('');
    try {
      const input = { username: name, password };
      const next = await (registering ? client.register(input) : client.login(input));
      await clearBookmark();
      await saveSession(next);
      await client.replaceSession(next);
      setSession(next);
      setPassword('');
      setRestoreFailed(false);
    } catch (failure) {
      if (failure instanceof AssistantApiError && failure.status === 401) setError('用户名或密码错误。');
      else if (registering && failure instanceof AssistantApiError && failure.status === 409) setError('该用户名已被使用。');
      else setError(messageText(failure));
    } finally {
      authPending.current = false;
      setLoading(false);
    }
  }

  async function signOut(revoked = false) {
    if (authPending.current) return;
    authPending.current = true;
    setSession(null);
    setRegistering(false);
    setUsername('');
    setPassword('');
    setLoading(true);
    setError('');
    try {
      if (!revoked) await client.logout();
    } catch {
      setError('本机已退出。服务器暂未确认退出。');
    } finally {
      await client.replaceSession(null);
      try { await clearLocalSession(); } catch { setError('本机安全存储暂时不可用。'); }
      if (revoked) setError('登录会话已失效，请重新登录。');
      authPending.current = false;
      setLoading(false);
    }
  }

  async function chooseWorkspace(id: string) {
    if (!session || authPending.current) throw new Error('正在处理当前登录会话。');
    if (session.user.workspaceId === id) return;
    authPending.current = true;
    try {
      const user = await client.switchWorkspace(id);
      const next = { ...session, user };
      try {
        await clearBookmark();
        await saveSession(next);
      } catch (failure) {
        await client.replaceSession(session);
        throw failure;
      }
      setSession(next);
    } finally {
      authPending.current = false;
    }
  }

  if (session) return <Workspace key={`${session.user.id}:${session.user.workspaceId}`} client={client} session={session}
    signOut={signOut} chooseWorkspace={chooseWorkspace} />;

  return <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
    <View style={styles.center}>
      <Text style={styles.wordmark}>青屿助手</Text>
      <Text accessibilityRole="header" style={styles.heading}>{registering ? '创建账号' : '登录青屿'}</Text>
      <TextInput accessibilityLabel="用户名" style={styles.input} placeholder="用户名" placeholderTextColor={palette.muted}
        autoCapitalize="none" autoCorrect={false} autoComplete="username" maxLength={32} value={username} onChangeText={setUsername} />
      <TextInput accessibilityLabel="密码" style={styles.input} placeholder="密码" placeholderTextColor={palette.muted}
        secureTextEntry autoComplete={registering ? 'new-password' : 'current-password'} value={password} onChangeText={setPassword}
        onSubmitEditing={() => void authenticate()} />
      {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
      <Action title={registering ? '注册' : '登录'} primary disabled={loading || !username.trim() || !password} onPress={() => void authenticate()} />
      <Action title={registering ? '已有账号，返回登录' : '创建一个账号'} disabled={loading}
        onPress={() => { setRegistering(!registering); setPassword(''); setError(''); }} />
      {restoreFailed && <Action title="恢复上次登录" disabled={loading} onPress={() => void restore()} />}
      {loading && <ActivityIndicator accessibilityLabel="请稍候" color={palette.brand} />}
    </View>
  </KeyboardAvoidingView>;
}

function Workspace({ client, session, signOut, chooseWorkspace }: {
  client: AssistantClient; session: Session; signOut: (revoked?: boolean) => Promise<void>;
  chooseWorkspace: (id: string) => Promise<void>;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const selected = useRef<string | null>(null);
  const selectionVersion = useRef(0);
  const historyVersion = useRef(0);
  const listVersion = useRef(0);
  const cursorRef = useRef<string | null>(null);
  const foreground = useRef(AppState.currentState === 'active');
  const mounted = useRef(true);
  const accessRequest = useRef<AbortController | null>(null);
  const locking = useRef<AbortController | null>(null);
  const readStateRef = useRef<ReadState>('ready');
  const [readState, applyReadState] = useState<ReadState>('ready');
  const [lockCreation, setLockCreation] = useState(false);
  const [lockCatalogue, setLockCatalogue] = useState(false);
  const [lockCapabilitiesKnown, setLockCapabilitiesKnown] = useState(false);
  const [lockedOpen, setLockedOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [branch, setBranch] = useState<string | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [modelIndex, setModelIndex] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const [learningOpen, setLearningOpen] = useState(false);
  const [jobsAvailable, setJobsAvailable] = useState(false);
  const [jobsPanel, setJobsPanel] = useState<{ source?: ExportSource }>();
  const [temporaryAvailable, setTemporaryAvailable] = useState(false);
  const [temporaryOpen, setTemporaryOpen] = useState(false);
  const [imagesAvailable, setImagesAvailable] = useState(false);
  const [imagesOpen, setImagesOpen] = useState(false);
  const [audioAccess, setAudioAccess] = useState<'upload' | 'read'>();
  const [pdfAccess, setPdfAccess] = useState<'general' | 'upload' | 'read'>();
  const [pdfOcrAvailable, setPdfOcrAvailable] = useState(false);
  const [mediaOpen, setMediaOpen] = useState<MediaKind>();
  const [projectTextAvailable, setProjectTextAvailable] = useState(false);
  const [projectTextOpen, setProjectTextOpen] = useState(false);
  const [artifactsAvailable, setArtifactsAvailable] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [researchAvailable, setResearchAvailable] = useState(false);
  const [researchOpen, setResearchOpen] = useState(false);
  const [remindersAvailable, setRemindersAvailable] = useState(false);
  const [remindersView, setRemindersView] = useState<'plans' | 'history'>();
  const [proactiveAvailable, setProactiveAvailable] = useState(false);
  const [proactiveOpen, setProactiveOpen] = useState(false);
  const [desktopCompanionAvailable, setDesktopCompanionAvailable] = useState(false);
  const [desktopCompanionOpen, setDesktopCompanionOpen] = useState(false);
  const [sharedDraftsAvailable, setSharedDraftsAvailable] = useState(false);
  const [publicationsAvailable, setPublicationsAvailable] = useState(false);
  const [sharedProjectMode, setSharedProjectMode] = useState<'drafts' | 'publications'>();
  const [historyReferencesAvailable, setHistoryReferencesAvailable] = useState(false);
  const [referencePickerOpen, setReferencePickerOpen] = useState(false);
  const [historyReference, setHistoryReference] = useState<Reference>();
  const [sourceTarget, setSourceTarget] = useState<SourceTarget>();
  const referenceScope = useRef(0);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const inflight = useRef(false);
  const cancelPending = useRef(false);
  const pending = useRef<{ conversationId: string; key: string; input: RunRequest } | null>(null);
  const pendingExport = useRef<{ conversationId: string; messageId: string; key: string } | null>(null);
  const thread = useRef<FlatList<Message>>(null);
  const followThread = useRef(true);
  const scrollFrame = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const closeTemporary = useCallback(() => setTemporaryOpen(false), []);

  const clearHistoryReference = useCallback(() => {
    referenceScope.current += 1;
    setHistoryReference(undefined);
    setReferencePickerOpen(false);
    if (pending.current?.input.action === 'send' && pending.current.input.historyReference) pending.current = null;
  }, []);

  const clearSourceViews = useCallback(() => {
    clearHistoryReference();
    setSourceTarget(undefined);
  }, [clearHistoryReference]);

  const report = useCallback((failure: unknown) => {
    if (failure instanceof AssistantApiError && failure.status === 401) {
      clearSourceViews();
      void signOut(true);
    } else setError(messageText(failure));
  }, [clearSourceViews, signOut]);

  const setReadState = useCallback((state: ReadState) => {
    readStateRef.current = state;
    applyReadState(state);
  }, []);

  const abortAccess = useCallback(() => {
    accessRequest.current?.abort();
    accessRequest.current = null;
  }, []);

  const refreshConversations = useCallback(async (append = false) => {
    const revision = ++listVersion.current;
    const page = await client.listConversations({ limit: 30, archived: false, cursor: append ? cursorRef.current ?? undefined : undefined });
    if (!mounted.current || !foreground.current || revision !== listVersion.current) return;
    setConversations((previous) => append ? [...previous, ...page.items] : page.items);
    cursorRef.current = page.nextCursor;
    setCursor(page.nextCursor);
  }, [client]);

  const forgetConversation = useCallback((id: string, locked: boolean) => {
    listVersion.current += 1;
    setConversations((current) => current.filter((item) => item.id !== id));
    setJobsPanel((current) => current?.source?.conversationId === id ? undefined : current);
    if (pending.current?.conversationId === id) pending.current = null;
    if (pendingExport.current?.conversationId === id) pendingExport.current = null;
    void clearBookmark(id).catch(() => undefined);
    if (selected.current !== id) return;
    clearSourceViews();
    selected.current = null;
    selectionVersion.current += 1;
    historyVersion.current += 1;
    abortAccess();
    Keyboard.dismiss();
    setConversation(null);
    setMessages([]);
    setBranch(null);
    setDraft('');
    setEditing(null);
    setReadState('ready');
    setError(locked ? lockedMessage : '此对话已不可访问。');
  }, [abortAccess, clearSourceViews, setReadState]);

  const refreshMessages = useCallback(async (conversationId: string, focus?: string | ((history: Message[]) => string | undefined)) => {
    if (selected.current !== conversationId) return;
    const version = ++historyVersion.current;
    const history = await listMessages(client, conversationId);
    if (selected.current === conversationId && version === historyVersion.current) {
      setMessages(history);
      const head = typeof focus === 'function' ? focus(history) : focus;
      if (head) setBranch(head);
    }
  }, [client]);

  const generation = useRun(client, (finished) => {
    void refreshMessages(finished.conversationId, finished.messageId).catch((failure) => readFailure(failure, finished.conversationId));
    void refreshConversations().catch(report);
  }, () => void signOut(true), forgetConversation);
  const { observe, discardConversation: discardRun } = generation;

  const discardConversation = useCallback((id: string, locked: boolean) => {
    discardRun(id);
    forgetConversation(id, locked);
    if (foreground.current) void refreshConversations().catch(report);
  }, [discardRun, forgetConversation, refreshConversations, report]);

  const readFailure = useCallback((failure: unknown, id: string) => {
    if (failure instanceof AssistantApiError && (failure.status === 403 || failure.status === 404 || failure.status === 423)) {
      discardConversation(id, failure.status === 423);
    } else report(failure);
  }, [discardConversation, report]);

  const verifyReading = useCallback(async (id: string, hide = false, loadMessages = false) => {
    if (selected.current !== id || !foreground.current || accessRequest.current || locking.current) return false;
    const request = new AbortController();
    const { signal } = request;
    accessRequest.current = request;
    if (hide) setReadState('checking');
    const timer = setTimeout(() => {
      if (accessRequest.current !== request) return;
      abortAccess();
      setReadState('unavailable');
    }, 8_000);
    try {
      const current = await client.getConversation(id, signal);
      if (signal.aborted || selected.current !== id) return false;
      if (loadMessages) await refreshMessages(id);
      if (signal.aborted || selected.current !== id) return false;
      setConversation(current);
      setReadState('ready');
      return true;
    } catch (failure) {
      if (!signal.aborted && selected.current === id) {
        setReadState('unavailable');
        if (failure instanceof AssistantApiError && [401, 403, 404, 423].includes(failure.status)) readFailure(failure, id);
      }
      return false;
    } finally {
      clearTimeout(timer);
      if (accessRequest.current === request) accessRequest.current = null;
    }
  }, [abortAccess, client, readFailure, refreshMessages, setReadState]);

  const model = models[modelIndex];
  const running = !!generation.run && isActive(generation.run);
  const isCurrentRun = generation.run?.conversationId === conversation?.id;
  const canRead = readState === 'ready';
  const canReferenceHistory = historyReferencesAvailable && canRead && model?.id === 'local-echo'
    && !conversation?.projectId && !conversation?.archived && !editing;
  const selectableMessages = lockCapabilitiesKnown && !lockCreation && !lockCatalogue;
  const { leaves, head, visibleMessages } = useMemo(() => {
    const parentIds = new Set(messages.map(({ parentId }) => parentId));
    const leaves = messages.filter(({ id }) => !parentIds.has(id));
    const head = branch && messages.some(({ id }) => id === branch) ? branch : leaves.at(-1)?.id;
    return { leaves, head, visibleMessages: getBranch(messages, head) };
  }, [messages, branch]);
  const voiceScope = `${conversation?.id ?? ''}/${head ?? ''}`;
  const mediaAccess = mediaOpen === 'wav' ? audioAccess : pdfAccess;
  const voiceVisible = canRead && !(drawer || jobsPanel || temporaryOpen || imagesOpen || mediaOpen || projectTextOpen || artifactsOpen
    || researchOpen || remindersView || proactiveOpen || desktopCompanionOpen || sharedProjectMode || lockedOpen || referencePickerOpen || sourceTarget);
  const audioScope = selectionVersion.current;
  const appendDictation = useCallback((text: string) => {
    if (selectionVersion.current !== audioScope || readStateRef.current !== 'ready' || !foreground.current) return;
    setDraft((current) => current && !/\s$/.test(current) ? `${current} ${text}` : `${current}${text}`);
  }, [audioScope]);
  const dictation = useLocalDictation(`${voiceScope}/${editing ?? ''}`, voiceVisible && !busy && !conversation?.archived, appendDictation);
  const cancelDictation = dictation.cancel;
  const { canRead: canReadAloud, toggle: toggleReadAloud, stop: stopReading, playback: reading,
    error: readAloudError, onViewableItemsChanged } = useReadAloud(
    visibleMessages, voiceScope, voiceVisible && !dictation.session,
    running ? generation.run?.messageId : undefined,
  );

  const queueThreadScroll = useCallback(() => {
    if (!followThread.current || scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      if (followThread.current) thread.current?.scrollToEnd({ animated: false });
    });
  }, []);

  const trackThreadScroll = useCallback(({ nativeEvent }: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = nativeEvent;
    followThread.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 96;
  }, []);

  useEffect(() => () => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
  }, []);

  const select = useCallback(async (id: string | null) => {
    clearSourceViews();
    abortAccess();
    selected.current = id;
    selectionVersion.current += 1;
    historyVersion.current += 1;
    followThread.current = true;
    setConversation(null);
    setMessages([]);
    setBranch(null);
    setDraft('');
    setEditing(null);
    setDrawer(false);
    setError('');
    if (id) return verifyReading(id, true, true);
    setReadState('ready');
    return false;
  }, [abortAccess, clearSourceViews, setReadState, verifyReading]);

  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', (state) => {
      foreground.current = state === 'active';
      if (foreground.current) {
        void refreshConversations().catch(report);
        if (selected.current) void verifyReading(selected.current, true, true);
        else setReadState('ready');
      } else {
        clearSourceViews();
        abortAccess();
        listVersion.current += 1;
        historyVersion.current += 1;
        cursorRef.current = null;
        setCursor(null);
        setConversations([]);
        setJobsPanel(undefined);
        if (selected.current) setReadState('checking');
      }
    });
    return () => {
      mounted.current = false;
      subscription.remove();
      abortAccess();
      locking.current?.abort();
      locking.current = null;
    };
  }, [abortAccess, clearSourceViews, refreshConversations, report, setReadState, verifyReading]);

  useEffect(() => {
    if (!canReferenceHistory) clearHistoryReference();
    if (!canRead) setSourceTarget(undefined);
  }, [canRead, canReferenceHistory, clearHistoryReference]);

  useEffect(() => {
    if (!lockCreation && !lockCatalogue) return;
    const timer = setInterval(() => {
      if (!foreground.current) return;
      if (selected.current) void verifyReading(selected.current, false, readStateRef.current !== 'ready');
      if (drawer) void refreshConversations().catch(report);
    }, 15_000);
    return () => clearInterval(timer);
  }, [drawer, lockCatalogue, lockCreation, refreshConversations, report, verifyReading]);

  useEffect(() => {
    let closed = false;
    let restoring = false;
    let restored = false;
    void refreshConversations().catch(report);
    void client.listModels().then(({ models }) => { if (!closed) setModels(models); }).catch(report);
    void client.getCapabilities().then(({ capabilities }) => {
      if (closed) return;
      const available = new Set(capabilities.filter((entry) => entry.available).map(({ id }) => id));
      setJobsAvailable(available.has('background_tasks'));
      setTemporaryAvailable(available.has('temporary_chat'));
      setImagesAvailable(available.has('project_attachments'));
      setAudioAccess(Platform.OS === 'android' && available.has('project_audio_attachments')
        ? available.has('project_audio_uploads') ? 'upload' : 'read' : undefined);
      setPdfAccess(Platform.OS === 'android' && available.has('project_pdf_attachments')
        ? !available.has('project_pdf_uploads') ? 'read' : available.has('project_general_pdf') ? 'general' : 'upload' : undefined);
      setPdfOcrAvailable(available.has('project_pdf_ocr'));
      setProjectTextAvailable(available.has('project_resources'));
      setArtifactsAvailable(available.has('private_artifacts'));
      setResearchAvailable(available.has('curated_research'));
      setRemindersAvailable(available.has('scheduled_reminders'));
      setProactiveAvailable(Platform.OS === 'android' && available.has('local_proactive_assistant'));
      setDesktopCompanionAvailable(Platform.OS === 'android' && available.has('local_desktop_companion'));
      setSharedDraftsAvailable(available.has('project_collaboration') && available.has('project_shared_drafts'));
      setPublicationsAvailable(Platform.OS === 'android' && available.has('project_collaboration') && available.has('project_artifact_publications'));
      setHistoryReferencesAvailable(available.has('explicit_history_references'));
      setLockCreation(available.has('conversation_read_lock'));
      setLockCatalogue(available.has('locked_conversations'));
      setLockCapabilitiesKnown(true);
    }).catch((failure) => {
      if (!closed && failure instanceof AssistantApiError && failure.status === 401) report(failure);
    });
    async function restoreRun() {
      if (restored || restoring || closed || selected.current || !foreground.current) return;
      restoring = true;
      try {
        const bookmark = await readBookmark(session.user.id);
        if (closed || selected.current || !foreground.current) return;
        restored = true;
        if (!bookmark) return;
        const id = bookmark.conversationId;
        if (!await select(id)) return;
        const revision = selectionVersion.current;
        try {
          const snapshot = await client.getRunSnapshot(bookmark.runId);
          if (!closed && selected.current === id && revision === selectionVersion.current) observe(snapshot);
        } catch (failure) {
          if (!closed) readFailure(failure, id);
        }
      } finally { restoring = false; }
    }
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') void restoreRun().catch(report);
    });
    void restoreRun().catch(report);
    return () => { closed = true; listener.remove(); };
  }, []);

  const openHistory = useCallback(() => {
    setDrawer(true);
    if (lockCreation || lockCatalogue || !lockCapabilitiesKnown) {
      setConversations([]);
      cursorRef.current = null;
      setCursor(null);
    }
    void refreshConversations().catch(report);
  }, [lockCatalogue, lockCreation, lockCapabilitiesKnown, refreshConversations, report]);

  function confirmLock() {
    const id = selected.current;
    if (!id || !lockCreation || readStateRef.current !== 'ready' || locking.current) return;
    Alert.alert('加锁此对话', '恢复阅读时需要当前账号密码。旧分享会撤回，正在生成的回复会停止。', [
      { text: '取消', style: 'cancel' },
      { text: '确认加锁', style: 'destructive', onPress: () => {
        if (selected.current !== id || !foreground.current || readStateRef.current !== 'ready' || locking.current) return;
        const request = new AbortController();
        locking.current = request;
        abortAccess();
        setReadState('checking');
        setError('');
        const timer = setTimeout(() => {
          if (locking.current !== request) return;
          request.abort();
          locking.current = null;
          if (selected.current === id) {
            setReadState('unavailable');
            setError('服务暂未确认加锁。请重新核对阅读权限。');
          }
        }, 8_000);
        void client.lockConversationReading(id, request.signal).then(() => {
          if (!request.signal.aborted) discardConversation(id, true);
        }).catch((failure) => {
          if (request.signal.aborted) return;
          if (failure instanceof AssistantApiError && [401, 403, 404, 423].includes(failure.status)) readFailure(failure, id);
          if (selected.current === id) {
            setReadState('unavailable');
            setError('暂时无法确认加锁结果。请重新核对阅读权限。');
          }
        }).finally(() => {
          clearTimeout(timer);
          if (locking.current === request) locking.current = null;
        });
      } },
    ]);
  }

  const describeJobError = useCallback((failure: unknown, fallback: string) => {
    if (failure instanceof AssistantApiError) {
      if (failure.status === 401) { report(failure); return ''; }
      if (failure.status === 403) return '后台任务在当前账号或工作空间不可用。';
      if (failure.status === 404) return '此任务或对话已不可访问。';
      if (failure.status === 429) return '任务请求过于频繁，请稍后重试。';
    }
    return fallback;
  }, [report]);

  const queueExport = useCallback(async (source: ExportSource) => {
    const id = source.conversationId;
    if (selected.current !== id || readStateRef.current !== 'ready' || !foreground.current) throw new Error('Export scope ended');
    try { await client.getConversation(id); }
    catch (failure) { readFailure(failure, id); throw failure; }
    if (selected.current !== id || readStateRef.current !== 'ready' || !foreground.current) throw new Error('Export scope ended');
    const previous = pendingExport.current;
    if (previous?.conversationId !== source.conversationId || previous.messageId !== source.messageId) {
      pendingExport.current = { conversationId: source.conversationId, messageId: source.messageId, key: randomUUID() };
    }
    const key = pendingExport.current!.key;
    try {
      const job = await client.queueConversationExport(id, source.messageId, key);
      if (pendingExport.current?.key === key) pendingExport.current = null;
      return job;
    } catch (failure) {
      if (failure instanceof AssistantApiError && failure.status === 423) discardConversation(id, true);
      throw failure;
    }
  }, [client, discardConversation, readFailure]);

  const start = useCallback(async (input: RunRequest) => {
    if (inflight.current || running || !model || conversation?.archived || readStateRef.current !== 'ready' || !foreground.current) return;
    const revision = selectionVersion.current;
    const sourceRevision = referenceScope.current;
    const referencesHistory = input.action === 'send' && !!input.historyReference;
    const currentSelection = () => mounted.current && selectionVersion.current === revision;
    let target = conversation;
    inflight.current = true;
    followThread.current = true;
    setBusy(true);
    setError('');
    try {
      if (!target) {
        target = await client.createConversation();
        if (!currentSelection()) return;
        selected.current = target.id;
        setConversation(target);
      }
      if (referencesHistory && (sourceRevision !== referenceScope.current || !foreground.current)) return;
      const previous = pending.current;
      if (previous?.conversationId !== target.id || JSON.stringify(previous.input) !== JSON.stringify(input)) {
        pending.current = { input, conversationId: target.id, key: randomUUID() };
      }
      const snapshot = await client.startRun(target.id, input, pending.current!.key);
      if (!currentSelection()) return;
      pending.current = null;
      if (referencesHistory) clearHistoryReference();
      try {
        await saveBookmark({ runId: snapshot.runId, conversationId: target.id, userId: session.user.id });
      } catch {
        if (currentSelection()) setError('消息已发送。本机暂时无法保存生成进度。');
      }
      if (!currentSelection()) return;
      setDraft('');
      setEditing(null);
      observe(snapshot);
      if (!isActive(snapshot)) await refreshMessages(target.id, snapshot.messageId);
      else {
        const previous = new Set(messages.map(({ id }) => id));
        const source = 'messageId' in input ? messages.find(({ id }) => id === input.messageId) : undefined;
        if (input.action === 'regenerate') {
          await refreshMessages(target.id, (source?.role === 'assistant' ? source.parentId : source?.id) ?? undefined);
        } else {
          const parent = (input.action === 'edit' ? source?.parentId : input.parentId) ?? null;
          await refreshMessages(target.id, (history) => history.findLast(({ id, parentId, role, content }) =>
            !previous.has(id) && parentId === parent && role === 'user' && content === input.content)?.id);
        }
      }
      await refreshConversations();
    } catch (failure) {
      if (target && failure instanceof AssistantApiError && failure.status === 423) discardConversation(target.id, true);
      else if (currentSelection() && referencesHistory && failure instanceof AssistantApiError && [400, 403, 404].includes(failure.status)) {
        clearHistoryReference();
        setError('历史引用当前不可用。请重新选择或普通发送。');
      }
      else if (currentSelection()) report(failure);
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }, [clearHistoryReference, client, conversation, discardConversation, messages, model, observe, refreshConversations,
    refreshMessages, report, running, session.user.id]);

  const editMessage = useCallback((message: Message) => {
    if (readStateRef.current !== 'ready' || !foreground.current) return;
    cancelDictation();
    clearSourceViews();
    setEditing(message.id);
    setDraft(message.content);
  }, [cancelDictation, clearSourceViews]);

  const regenerateMessage = useCallback((message: Message) => {
    clearSourceViews();
    if (model) void start({ action: 'regenerate', messageId: message.id, modelId: model.id });
  }, [clearSourceViews, model, start]);

  const openSource = useCallback((message: Message, kind: SourceTarget['kind']) => {
    const id = selected.current;
    if (!id || !foreground.current || readStateRef.current !== 'ready') return;
    Keyboard.dismiss();
    setSourceTarget({ kind, conversationId: id, messageId: message.id });
  }, []);

  const openSourceConversation = useCallback(async (id: string) => { await select(id); }, [select]);

  const sourceAccessDenied = useCallback((failure: AssistantApiError) => {
    if (failure.status === 401) report(failure);
    if (failure.status === 423 && sourceTarget) readFailure(failure, sourceTarget.conversationId);
  }, [readFailure, report, sourceTarget]);

  const messageActionsDisabled = !canRead || running || busy || !!conversation?.archived;
  const canRegenerate = !messageActionsDisabled && !!model;
  const renderMessage = useCallback(({ item }: ListRenderItemInfo<Message>) => <MessageRow message={item}
    editDisabled={messageActionsDisabled} canRegenerate={canRegenerate} onEdit={editMessage} onRegenerate={regenerateMessage}
    canReadAloud={canReadAloud(item)} reading={reading?.messageId === item.id} speaking={reading?.messageId === item.id && reading.started}
    selectable={selectableMessages} projectScope={!!conversation?.projectId} onSource={openSource} onReadAloud={toggleReadAloud} />,
  [canReadAloud, canRegenerate, conversation?.projectId, editMessage, messageActionsDisabled, openSource, reading,
    regenerateMessage, selectableMessages, toggleReadAloud]);

  function submit() {
    const text = draft;
    if (!text.trim() || !model || dictation.session || readStateRef.current !== 'ready') return;
    if ([...text].length > 8000) { setError('单条消息最多 8000 个字符。'); return; }
    const input: RunRequest = editing ? { action: 'edit', messageId: editing, content: text, modelId: model.id }
      : { action: 'send', content: text, parentId: head, modelId: model.id,
        historyReference: canReferenceHistory ? historyReference : undefined };
    Keyboard.dismiss();
    void start(input);
  }

  async function stop() {
    if (!generation.run || !running || cancelPending.current || readStateRef.current !== 'ready') return;
    const { runId, conversationId } = generation.run;
    const revision = selectionVersion.current;
    cancelPending.current = true;
    setStopping(true);
    try {
      const snapshot = await client.cancelRun(runId);
      if (revision !== selectionVersion.current) return;
      generation.observe(snapshot);
      await refreshMessages(snapshot.conversationId, snapshot.messageId);
    } catch (failure) {
      readFailure(failure, conversationId);
    } finally {
      cancelPending.current = false;
      setStopping(false);
    }
  }

  const currentRun = canRead && isCurrentRun ? generation.run : null;
  const showRun = currentRun && (!currentRun.messageId || !messages.some(({ id }) => id === currentRun.messageId));
  const exportSource = canRead && conversation && head ? { conversationId: conversation.id, messageId: head, title: conversation.title } : undefined;
  return <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
    <View style={styles.toolbar}>
      <Action title="历史" onPress={openHistory} />
      <Text style={styles.title} numberOfLines={1}>{canRead ? conversation?.title || '新的对话' : '对话访问权限'}</Text>
      <Action title="新建" disabled={busy || !!locking.current} onPress={() => void select(null)} />
    </View>
    <FlatList ref={thread} style={styles.safe} contentContainerStyle={styles.thread} data={canRead ? visibleMessages : []} keyExtractor={itemKey}
      onContentSizeChange={queueThreadScroll} onScroll={trackThreadScroll}
      viewabilityConfig={readAloudViewability} onViewableItemsChanged={onViewableItemsChanged}
      scrollEventThrottle={48} keyboardShouldPersistTaps="handled" ListEmptyComponent={canRead && !showRun ? EmptyThread : null}
      renderItem={renderMessage}
      ListFooterComponent={showRun ? <View style={styles.message}>
        <Text style={styles.label}>青屿助手</Text>
        <Text style={styles.body} selectable={selectableMessages}>{currentRun.content || (running ? '正在生成…' : '暂无回复')}</Text>
        {currentRun.state === 'cancelled' && <Text style={styles.muted}>已停止生成</Text>}
        {currentRun.state === 'failed' && <Text style={styles.error}>{currentRun.error?.message || '生成失败，请重试。'}</Text>}
      </View> : null} />
    <View style={styles.composer}>
      <View style={styles.actions}>
        <Action title={model?.id ?? '无可用模型'} disabled={models.length < 2 || !!running}
          onPress={() => { clearSourceViews(); setModelIndex((index) => (index + 1) % models.length); }} />
        {canRead && leaves.length > 1 && <Action title={`分支 ${leaves.findIndex(({ id }) => id === head) + 1}/${leaves.length}`}
          onPress={() => { cancelDictation(); setBranch(leaves[(leaves.findIndex(({ id }) => id === head) + 1) % leaves.length].id); }} />}
        {canRead && editing && <Action title="取消编辑" onPress={() => { cancelDictation(); setEditing(null); setDraft(''); }} />}
        {canReferenceHistory && <Action title="引用历史回复" disabled={running || busy} onPress={() => {
          Keyboard.dismiss(); setReferencePickerOpen(true);
        }} />}
        {canRead && conversation && lockCreation && <Action title="加锁对话" onPress={confirmLock} />}
        {temporaryAvailable && <Action title="临时对话" onPress={() => { Keyboard.dismiss(); setTemporaryOpen(true); }} />}
        {imagesAvailable && <Action title="项目图像" onPress={() => { Keyboard.dismiss(); setImagesOpen(true); }} />}
        {researchAvailable && <Action title="研究任务" onPress={() => { Keyboard.dismiss(); setResearchOpen(true); }} />}
        {remindersAvailable && <Action title="定时提醒" onPress={() => { Keyboard.dismiss(); setRemindersView('plans'); }} />}
        {dictation.available && !dictation.session && <Action title="本机听写" onPress={() => {
          Keyboard.dismiss();
          stopReading();
          void dictation.start();
        }} />}
        {jobsAvailable && exportSource && <Action title="后台导出" disabled={running || busy || !!(showRun && currentRun.messageId)}
          onPress={() => setJobsPanel({ source: exportSource })} />}
      </View>
      {readState === 'checking' && <Text accessibilityLiveRegion="polite" style={styles.muted}>正在核对阅读权限…</Text>}
      {readState === 'unavailable' && <>
        <Text accessibilityLiveRegion="polite" style={styles.muted}>暂时无法核对阅读权限。</Text>
        <Action title="重新核对权限" onPress={() => { if (selected.current) void verifyReading(selected.current, true, true); }} />
      </>}
      {canRead && generation.paused && <Text accessibilityLiveRegion="polite" style={styles.muted}>连接暂时中断，正在恢复。</Text>}
      {canRead && running && !isCurrentRun && <Text accessibilityLiveRegion="polite" style={styles.muted}>另一条对话正在生成。</Text>}
      {canRead && conversation?.archived && <Text style={styles.muted}>此对话已归档。</Text>}
      {readAloudError ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{readAloudError}</Text> : null}
      {dictation.error ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{dictation.error}</Text> : null}
      {canRead && dictation.session && <View>
        <Text accessibilityLiveRegion="polite" style={styles.muted}>
          {dictation.session.phase === 'listening' ? '正在本机听写' : dictation.session.phase === 'finishing' ? '正在整理听写结果…' : '正在启动本机听写…'}
        </Text>
        {!!dictation.session.partial && <Text style={styles.body}>{dictation.session.partial}</Text>}
        <View style={styles.actions}>
          {dictation.session.phase === 'listening' && <Action title="结束听写" onPress={dictation.finish} />}
          <Action title="取消听写" onPress={() => dictation.cancel()} />
        </View>
      </View>}
      {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
      {error === lockedMessage && lockCatalogue && <Action title="查看加锁对话" onPress={() => setLockedOpen(true)} />}
      {canReferenceHistory && historyReference && <View style={styles.actions}>
        <Text accessibilityLiveRegion="polite" style={styles.muted}>已选一条历史回复。仅用于本次发送。</Text>
        <Action title="移除历史引用" disabled={busy} onPress={clearHistoryReference} />
      </View>}
      <TextInput accessibilityLabel="消息" placeholder="输入消息" placeholderTextColor={palette.muted}
        editable={canRead && !conversation?.archived} contextMenuHidden={!selectableMessages} multiline maxLength={16000}
        style={[styles.input, styles.messageInput]} value={canRead ? draft : ''}
        onChangeText={(text) => { if (readStateRef.current === 'ready') setDraft(text); }} />
      <View style={styles.actions}>
        {running && canRead ? <Action title={stopping ? '正在停止…' : '停止生成'} disabled={stopping} primary onPress={() => void stop()} />
          : <Action title={editing ? '发送编辑' : '发送'} primary
            disabled={!canRead || busy || !!dictation.session || !draft.trim() || !model || conversation?.archived} onPress={submit} />}
      </View>
    </View>
    <Modal visible={drawer || !!jobsPanel} animationType="slide" onRequestClose={() => {
      if (jobsPanel) setJobsPanel(undefined);
      else if (learningOpen) setLearningOpen(false);
      else setDrawer(false);
    }}>
      {jobsPanel ? <BackgroundExports client={client} source={jobsPanel.source} describeError={describeJobError}
        queueExport={queueExport} close={() => setJobsPanel(undefined)} />
        : learningOpen ? <Learning close={() => { Keyboard.dismiss(); setLearningOpen(false); }} /> : <SafeAreaView style={styles.safe}>
        <View style={styles.toolbar}>
          <Text accessibilityRole="header" style={styles.heading}>历史会话</Text>
          <Action title="关闭" onPress={() => setDrawer(false)} />
        </View>
        <View style={[styles.historyTools, styles.actions]}>
          <Action title="学习模式" onPress={() => setLearningOpen(true)} />
          {lockCatalogue && <Action title="加锁对话" onPress={() => { setDrawer(false); setLockedOpen(true); }} />}
          {jobsAvailable && <Action title="后台任务" onPress={() => setJobsPanel({})} />}
          {proactiveAvailable && <Action title="主动助手" onPress={() => { setDrawer(false); setProactiveOpen(true); }} />}
          {desktopCompanionAvailable && <Action title="桌面接续" onPress={() => { setDrawer(false); setDesktopCompanionOpen(true); }} />}
          {projectTextAvailable && <Action title="项目文本资料" onPress={() => { setDrawer(false); setProjectTextOpen(true); }} />}
          {audioAccess && <Action title="项目音频" onPress={() => { setDrawer(false); setMediaOpen('wav'); }} />}
          {pdfAccess && <Action title="项目 PDF" onPress={() => { setDrawer(false); setMediaOpen('pdf'); }} />}
          {artifactsAvailable && <Action title="私有产物" onPress={() => { setDrawer(false); setArtifactsOpen(true); }} />}
          {sharedDraftsAvailable && <Action title="共享文稿" onPress={() => { setDrawer(false); setSharedProjectMode('drafts'); }} />}
          {publicationsAvailable && <Action title="项目发布" onPress={() => { setDrawer(false); setSharedProjectMode('publications'); }} />}
        </View>
        <FlatList data={conversations} keyExtractor={({ id }) => id} contentContainerStyle={styles.thread}
          renderItem={({ item }) => <Pressable style={styles.historyRow} accessibilityRole="button"
            onPress={() => void select(item.id)}><Text style={styles.body}>{item.title}</Text></Pressable>}
          ListEmptyComponent={<Text style={styles.muted}>暂无会话</Text>}
          ListFooterComponent={cursor ? <Action title="加载更多" onPress={() => void refreshConversations(true).catch(report)} /> : null} />
        <View style={styles.toolbar}>
          <Text style={styles.label}>{session.user.username}</Text>
          <Action title="退出登录" onPress={() => Alert.alert('退出登录', '此设备会清除本地登录凭证。', [
            { text: '取消', style: 'cancel' }, { text: '退出', onPress: () => void signOut() },
          ])} />
        </View>
      </SafeAreaView>}
    </Modal>
    {temporaryOpen && <TemporaryChat client={client} close={closeTemporary} onSessionExpired={report} />}
    {referencePickerOpen && canReferenceHistory && <HistoryReferencePicker client={client} targetId={conversation?.id ?? null}
      close={() => setReferencePickerOpen(false)} onSessionExpired={report}
      select={(value) => {
        if (!foreground.current || selected.current !== (conversation?.id ?? null)) return;
        clearHistoryReference();
        setHistoryReference(value);
      }} />}
    {sourceTarget && canRead && <MessageSources client={client} target={sourceTarget} close={() => setSourceTarget(undefined)}
      openConversation={openSourceConversation} onAccessDenied={sourceAccessDenied} />}
    {lockedOpen && <LockedConversations client={client} close={() => setLockedOpen(false)} onSessionExpired={report}
      onRestored={async (id) => {
        setLockedOpen(false);
        await select(id);
        await refreshConversations().catch(report);
      }} />}
    {imagesOpen && <ProjectImages client={client} close={() => setImagesOpen(false)} onSessionExpired={report} />}
    {mediaOpen && mediaAccess && <ProjectMedia key={mediaOpen} client={client} kind={mediaOpen}
      uploadsAllowed={mediaAccess !== 'read'} generalPdf={mediaAccess === 'general'} pdfOcr={pdfOcrAvailable}
      close={() => setMediaOpen(undefined)} onSessionExpired={report} />}
    {projectTextOpen && <ProjectText client={client} close={() => setProjectTextOpen(false)} onSessionExpired={report} />}
    {artifactsOpen && <PrivateArtifacts client={client} close={() => setArtifactsOpen(false)} onSessionExpired={report} />}
    {researchOpen && <ResearchTasks client={client} close={() => setResearchOpen(false)} onSessionExpired={report} />}
    {remindersView && <Reminders client={client} initialView={remindersView} close={() => setRemindersView(undefined)} onSessionExpired={report} />}
    {proactiveOpen && <Proactive client={client} close={() => setProactiveOpen(false)} onSessionExpired={report}
      openReminders={(target) => { setProactiveOpen(false); setRemindersView(target); }} />}
    {desktopCompanionOpen && <DesktopCompanion client={client} close={() => setDesktopCompanionOpen(false)} onSessionExpired={report} />}
    {sharedProjectMode && <SharedDrafts client={client} workspaceId={session.user.workspaceId} mode={sharedProjectMode}
      close={() => setSharedProjectMode(undefined)} chooseWorkspace={chooseWorkspace} onSessionExpired={report} />}
  </KeyboardAvoidingView>;
}

const temporaryPromptLimit = 512;

function TemporaryChat({ client, close, onSessionExpired }: {
  client: AssistantClient;
  close: () => void;
  onSessionExpired: (failure: AssistantApiError) => void;
}) {
  const [draft, setDraft] = useState('');
  const [result, setResult] = useState<{ prompt: string; reply: string }>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const remaining = temporaryPromptLimit - [...draft].length;

  const abortPending = useCallback(() => {
    const request = pending.current;
    pending.current = null;
    request?.abort();
  }, []);

  const discard = useCallback(() => {
    abortPending();
    Keyboard.dismiss();
    close();
  }, [abortPending, close]);

  useEffect(() => {
    function onAppState(state: AppStateStatus) {
      if (state === 'inactive' || state === 'background') discard();
    }
    const appState = AppState.addEventListener('change', onAppState);
    onAppState(AppState.currentState);
    return () => { appState.remove(); abortPending(); };
  }, [abortPending, discard]);

  async function send() {
    if (pending.current || remaining < 0 || !draft.trim()) return;
    const request = new AbortController();
    pending.current = request;
    setError('');
    setBusy(true);
    Keyboard.dismiss();
    try {
      const reply = await client.replyToTemporaryChat(draft, request.signal);
      if (pending.current !== request) return;
      setResult({ prompt: draft, reply: reply.content });
      setDraft('');
    } catch (failure) {
      if (pending.current !== request) return;
      if (failure instanceof AssistantApiError && failure.status === 401) onSessionExpired(failure);
      else if (failure instanceof AssistantApiError && failure.status === 403) setError('临时对话在当前工作空间不可用。');
      else setError(messageText(failure));
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  return <Modal visible onRequestClose={discard}>
    <SafeAreaView style={styles.safe} accessibilityViewIsModal>
      <KeyboardAvoidingView style={styles.safe} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.toolbar}>
          <Text accessibilityRole="header" style={[styles.heading, styles.flexibleHeading]}>临时对话</Text>
          <Action title="关闭临时对话" onPress={discard} />
        </View>
        <ScrollView style={styles.safe} contentContainerStyle={styles.thread} keyboardShouldPersistTaps="handled">
          <Text style={styles.body}>测试服务的本地模拟模型每次只处理当前消息。内容不会写入历史或记忆，关闭或退到后台会清除。</Text>
          {result && <>
            <View style={[styles.message, styles.userMessage]}>
              <Text style={styles.label}>你</Text>
              <Text style={styles.body}>{result.prompt}</Text>
            </View>
            <View style={styles.message}>
              <Text style={styles.label}>本地模拟回复</Text>
              <Text style={styles.body} accessibilityLiveRegion="polite">{result.reply}</Text>
            </View>
          </>}
          <Text style={styles.label}>临时消息</Text>
          <TextInput accessibilityLabel="临时消息" placeholder="输入临时消息" placeholderTextColor={palette.muted}
            editable={!busy} multiline maxLength={2048} autoComplete="off" importantForAutofill="no"
            autoCorrect={false} spellCheck={false} style={[styles.input, styles.messageInput]} value={draft} onChangeText={setDraft} />
          {remaining < 0 && <Text accessibilityLiveRegion="polite" style={styles.error}>消息最多 512 个字符，请删减 {-remaining} 个字符。</Text>}
          {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
          <View style={styles.actions}>
            <Action title={busy ? '正在生成…' : '发送临时消息'} primary disabled={busy || remaining < 0 || !draft.trim()} onPress={() => void send()} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

const exportStates: Record<ExportJob['status'], string> = {
  queued: '排队中', running: '处理中', completed: '已完成', cancelled: '已取消', failed: '失败',
};
const exportTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });

function BackgroundExports({ client, source, describeError, queueExport, close }: {
  client: AssistantClient;
  source?: ExportSource;
  describeError: (failure: unknown, fallback: string) => string;
  queueExport: (source: ExportSource) => Promise<ExportJob>;
  close: () => void;
}) {
  const tasks = useExportJobs(client, describeError);
  const busy = tasks.pending !== null;
  return <SafeAreaView style={styles.safe}>
    <View style={styles.toolbar}>
      <Text accessibilityRole="header" style={styles.heading}>后台任务</Text>
      <Action title="关闭任务" onPress={close} />
    </View>
    {source && <View style={styles.jobControls}>
      <Text style={styles.body}>将「{source.title}」当前分支导出为 Markdown。关闭窗口后任务仍会继续。</Text>
      <Action title={tasks.submitted ? '已提交' : tasks.pending === 'queue' ? '正在提交…' : '开始导出'} primary
        disabled={busy || tasks.loading || tasks.submitted} onPress={() => tasks.queue(() => queueExport(source))} />
    </View>}
    <View style={styles.jobControls}>
      <View style={styles.actions}>
        <Action title="刷新任务" disabled={busy || tasks.loading} onPress={tasks.refresh} />
      </View>
      {tasks.loading && <ActivityIndicator accessibilityLabel="正在读取任务" color={palette.brand} />}
      {tasks.error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{tasks.error}</Text> : null}
      {tasks.pollError ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{tasks.pollError}</Text> : null}
    </View>
    <FlatList data={tasks.jobs} keyExtractor={itemKey} contentContainerStyle={styles.thread}
      ListEmptyComponent={!tasks.loading && !tasks.error ? <Text style={styles.muted}>暂无任务。</Text> : null}
      ListFooterComponent={tasks.cursor ? <Action title="加载更多任务" disabled={busy || tasks.loading} onPress={tasks.more} /> : null}
      renderItem={({ item }) => {
        const state = `${exportStates[item.status]} ${item.progress}%`;
        return <View style={styles.message}>
          <Text style={styles.label}>对话导出</Text>
          <Text style={styles.muted}>{exportTime.format(new Date(item.createdAt))}</Text>
          <Text accessibilityRole="progressbar" accessibilityLiveRegion="polite"
            accessibilityValue={{ min: 0, max: 100, now: item.progress, text: state }} style={styles.body}>{state}</Text>
          {item.errorCode === 'EXPORT_TOO_LARGE' && <Text style={styles.error}>当前分支超过导出大小限制。</Text>}
          {item.status === 'completed' && <Text style={styles.muted}>在网页版的「后台任务」中下载 Markdown。</Text>}
          {activeExport(item) && <View style={styles.actions}>
            <Action title={tasks.pending === item.id ? '正在取消…' : '取消任务'} disabled={busy} onPress={() => tasks.cancel(item)} />
          </View>}
        </View>;
      }} />
  </SafeAreaView>;
}

const MessageRow = memo(function MessageRow({ message, editDisabled, canRegenerate, onEdit, onRegenerate,
  canReadAloud, reading, speaking, selectable, projectScope, onSource, onReadAloud }: {
  message: Message;
  editDisabled: boolean;
  canRegenerate: boolean;
  onEdit: (message: Message) => void;
  onRegenerate: (message: Message) => void;
  canReadAloud: boolean;
  reading: boolean;
  speaking: boolean;
  selectable: boolean;
  projectScope: boolean;
  onSource: (message: Message, kind: SourceTarget['kind']) => void;
  onReadAloud: (message: Message) => void;
}) {
  const user = message.role === 'user';
  return <View style={[styles.message, user && styles.userMessage]}>
    <Text style={styles.label}>{user ? '你' : '青屿助手'}</Text>
    <Text selectable={selectable} style={styles.body}>{message.content}</Text>
    {message.generation && <Text style={styles.muted}>{message.generation.modelId} · {message.generation.modelVersion}
      {message.generation.context?.trimmed ? ' · 部分旧消息未纳入上下文' : ''}
      {message.generation.fallbackFromModelId ? ` · 由 ${message.generation.fallbackFromModelId} 切换` : ''}</Text>}
    <View style={styles.actions}>
      {user && <Action title="编辑" disabled={editDisabled} onPress={() => onEdit(message)} />}
      <Action title={user ? '重试' : '重新生成'} disabled={!canRegenerate} onPress={() => onRegenerate(message)} />
      {canReadAloud && <Action title={reading ? '停止朗读' : '本机朗读'} onPress={() => onReadAloud(message)} />}
      {!user && message.generation?.historyReferenceUsed && <Action title="查看历史来源" onPress={() => onSource(message, 'history')} />}
      {!user && projectScope && message.generation?.projectMemorySourcesUsed &&
        <Action title="查看项目记忆来源" onPress={() => onSource(message, 'project')} />}
    </View>
    {speaking && <Text accessibilityLiveRegion="polite" style={styles.muted}>正在本机朗读</Text>}
  </View>;
});

function EmptyThread() {
  return <View style={styles.hero}>
    <Text style={styles.wordmark}>青屿助手</Text><Text style={styles.heading}>今天聊些什么？</Text>
  </View>;
}

function getBranch(messages: Message[], head?: string) {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const branch: Message[] = [];
  let entry = head ? byId.get(head) : undefined;
  while (entry && branch.length < messages.length) {
    branch.push(entry);
    entry = entry.parentId ? byId.get(entry.parentId) : undefined;
  }
  return branch.reverse();
}
