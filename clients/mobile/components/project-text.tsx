import { File, FileMode, Paths } from 'expo-file-system';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Keyboard, Modal, Platform, ScrollView, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AssistantApiError, type AssistantClient, type components } from '../../../packages/contracts/dist/index.js';
import { waitForForeground } from '../lib/foreground';
import { saveDownload } from '../lib/save-download';
import { decodeUtf8 } from '../lib/utf8';
import { Action, palette, styles } from './ui';

type Data = components['schemas'];
type Route = { kind: 'projects' } | { kind: 'resources'; projectId: string }
  | { kind: 'detail'; projectId: string; resourceId: string };
type Snapshot = { kind: 'projects'; page: Data['ProjectPage'] }
  | { kind: 'resources'; page: Data['ProjectResourcePage']; name: string }
  | { kind: 'detail'; item: Data['ProjectResource'] };
type Picker = { controller: AbortController; presenting: boolean; deadline?: ReturnType<typeof setTimeout> };
const projects: Route = { kind: 'projects' };
const textMime = 'text/plain';
const byteLimit = 16_384;

function decodeText(file: File): Data['ProjectResourceCreate'] {
  const name = file.name.trim();
  if (!/\.txt$/i.test(name) || [...name].length > 120 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
    throw new Error('请选择名称不超过 120 个字符的 .txt 文件。');
  }
  if (file.size > byteLimit) throw new Error('文本文件须为 16 KiB 以内。');
  const handle = file.open(FileMode.ReadOnly);
  try {
    const bytes = handle.readBytes(byteLimit + 1);
    if (bytes.length > byteLimit) throw new Error('文本文件须为 16 KiB 以内。');
    let content: string;
    try { content = decodeUtf8(bytes); }
    catch { throw new Error('请选择 UTF-8 编码的文本文件。'); }
    if (!content.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(content)) {
      throw new Error('请选择非空文本，正文可包含换行和制表符。');
    }
    return { name, content };
  } finally { handle.close(); }
}

function discardPickerCopy(file: File) {
  if (Platform.OS !== 'ios') return;
  try {
    const url = new URL(file.uri);
    const cache = new URL(Paths.cache.uri);
    const cachePrefix = cache.pathname.replace(/\/?$/, '/');
    if (url.protocol === 'file:' && !url.host && !url.search && !url.hash && url.pathname.startsWith(cachePrefix)
        && !decodeURIComponent(url.pathname).split('/').some((part) => part === '..')) file.delete();
  } catch { /* The OS controls cleanup outside the app cache. */ }
}

export function ProjectText({ client, close, onSessionExpired }: {
  client: AssistantClient;
  close: () => void;
  onSessionExpired: (failure: AssistantApiError) => void;
}) {
  const route = useRef<Route>(projects);
  const foreground = useRef(false);
  const request = useRef<AbortController | null>(null);
  const picker = useRef<Picker | null>(null);
  const [location, setLocation] = useState<Route>(projects);
  const [view, setView] = useState<Snapshot>();
  const [picked, setPicked] = useState<Data['ProjectResourceCreate']>();
  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const filter = term.trim();

  const failed = useCallback((failure: unknown, fallback: string) => {
    if (failure instanceof AssistantApiError && failure.status === 401) onSessionExpired(failure);
    else if (failure instanceof AssistantApiError && (failure.status === 403 || failure.status === 404)) {
      setView(undefined);
      setPicked(undefined);
      setError('此项目或资料已不可访问。');
    } else setError(fallback);
  }, [onSessionExpired]);

  const stop = useCallback(() => {
    request.current?.abort();
    request.current = null;
  }, []);

  const stopPicker = useCallback(() => {
    const selection = picker.current;
    if (!selection) return;
    picker.current = null;
    clearTimeout(selection.deadline);
    selection.controller.abort();
  }, []);

  const operate = useCallback(async (label: string, fallback: string, work: (signal: AbortSignal) => Promise<void>) => {
    if (!foreground.current || picker.current || request.current) return;
    const token = new AbortController();
    request.current = token;
    setBusy(label);
    setError('');
    const deadline = setTimeout(() => {
      if (request.current !== token) return;
      stop();
      setView(undefined);
      setPicked(undefined);
      setBusy('');
      setError('服务暂未响应。请重新读取后确认结果。');
    }, 8_000);
    try { await work(token.signal); }
    catch (failure) { if (!token.signal.aborted) failed(failure, fallback); }
    finally {
      clearTimeout(deadline);
      if (request.current === token) {
        request.current = null;
        setBusy('');
      }
    }
  }, [failed, stop]);

  const read = useCallback((next: Route, q = '', after?: string | null) => {
    const cursor = after ?? undefined;
    void operate('正在读取…', '暂时无法读取，请重试。', async (signal) => {
      if (!cursor) setView(undefined);
      switch (next.kind) {
        case 'projects': {
          const page = await client.listProjects({ limit: 30, cursor });
          if (signal.aborted) return;
          setView((current) => ({ kind: 'projects', page: cursor && current?.kind === 'projects'
            ? { ...page, items: [...current.page.items, ...page.items] } : page }));
          break;
        }
        case 'resources': {
          const [project, page] = await Promise.all([client.getProject(next.projectId),
            client.listProjectResources(next.projectId, { limit: 20, q: q || undefined, cursor }, signal)]);
          if (signal.aborted) return;
          setView((current) => ({ kind: 'resources', name: project.name, page: cursor && current?.kind === 'resources'
            ? { ...page, items: [...current.page.items, ...page.items] } : page }));
          break;
        }
        case 'detail': {
          const item = await client.getProjectResource(next.projectId, next.resourceId);
          if (!signal.aborted) setView({ kind: 'detail', item });
        }
      }
    });
  }, [client, operate]);

  const navigate = useCallback((next: Route, q = '') => {
    stop();
    route.current = next;
    setLocation(next);
    setPicked(undefined);
    setNotice('');
    setQuery(q);
    read(next, q);
  }, [read, stop]);

  useEffect(() => {
    const update = (next: string) => {
      foreground.current = next === 'active';
      if (foreground.current) {
        if (!picker.current) read(route.current);
        return;
      }
      stop();
      if (picker.current && !picker.current.presenting) stopPicker();
      setView(undefined);
      setPicked(undefined);
      setTerm('');
      setQuery('');
      setNotice('');
      setError('');
      if (!picker.current) setBusy('');
    };
    const listener = AppState.addEventListener('change', update);
    update(AppState.currentState);
    return () => {
      listener.remove();
      foreground.current = false;
      stopPicker();
      stop();
    };
  }, [read, stop, stopPicker]);

  function back() {
    if (picker.current) return;
    const here = route.current;
    if (here.kind === 'projects') close();
    else if (here.kind === 'detail') navigate({ kind: 'resources', projectId: here.projectId }, query);
    else { setTerm(''); navigate(projects); }
  }

  async function duringPicker(label: string, work: (selection: Picker) => Promise<void>) {
    if (!foreground.current || request.current || picker.current) return;
    const selection: Picker = { controller: new AbortController(), presenting: true };
    picker.current = selection;
    setBusy(label);
    setView(undefined);
    setTerm('');
    setQuery('');
    setError('');
    setNotice('');
    try { await work(selection); }
    catch (failure) {
      if (!selection.controller.signal.aborted) failed(failure, '无法读取所选文件或目录。');
    } finally {
      if (picker.current === selection) {
        stopPicker();
        setBusy('');
        if (foreground.current) read(route.current);
      }
    }
  }

  async function checkPickerReturn(selection: Picker) {
    await waitForForeground(selection.controller.signal);
    if (selection.controller.signal.aborted || !foreground.current || picker.current !== selection) {
      throw new Error('Picker scope ended.');
    }
    selection.presenting = false;
    selection.deadline = setTimeout(() => {
      if (picker.current !== selection) return;
      stopPicker();
      setView(undefined);
      setPicked(undefined);
      setBusy('');
      setError('无法核对当前访问权限。请重新读取。');
    }, 8_000);
  }

  function chooseText(projectId: string) {
    Keyboard.dismiss();
    setPicked(undefined);
    void duringPicker('正在选择文本文件…', async (selection) => {
      const result = await File.pickFileAsync({ mimeTypes: textMime, multipleFiles: false });
      if (result.canceled) return;
      const { result: file } = result;
      try {
        await checkPickerReturn(selection);
        const { signal } = selection.controller;
        await client.listProjectResources(projectId, { limit: 1 }, signal);
        if (signal.aborted) return;
        try { setPicked(decodeText(file)); }
        catch (failure) { setNotice(failure instanceof Error ? failure.message : '无法读取所选文本。'); }
      } finally { discardPickerCopy(file); }
    });
  }

  function importText(projectId: string, data: Data['ProjectResourceCreate']) {
    void operate('正在导入文本…', '导入暂未确认。请先重新读取资料列表。', async (signal) => {
      setPicked(undefined);
      const item = await client.createProjectResource(projectId, data);
      if (!signal.aborted) {
        navigate({ kind: 'detail', projectId, resourceId: item.id }, query);
      }
    });
  }

  function save(here: Extract<Route, { kind: 'detail' }>) {
    void duringPicker('正在选择保存目录…', async (selection) => {
      const { signal } = selection.controller;
      const name = await saveDownload(async () => {
        await checkPickerReturn(selection);
        const item = await client.getProjectResource(here.projectId, here.resourceId);
        return new TextEncoder().encode(item.content);
      }, { filename: `project-text-${here.resourceId.slice(0, 8)}.txt`, contentType: textMime, maxBytes: byteLimit, signal });
      if (!signal.aborted && name) setNotice(`已保存 ${name}。`);
    });
  }

  function remove(here: Extract<Route, { kind: 'detail' }>) {
    Alert.alert('删除项目资料', '删除后将无法再访问这条资料。', [
      { text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: () => {
        if (route.current !== here) return;
        void operate('正在删除…', '删除暂未确认。请重新读取。', async (signal) => {
          await client.deleteProjectResource(here.projectId, here.resourceId);
          if (!signal.aborted) navigate({ kind: 'resources', projectId: here.projectId }, query);
        });
      } },
    ]);
  }

  return <Modal visible onRequestClose={back}>
    <SafeAreaView style={styles.safe} accessibilityViewIsModal>
      <View style={styles.toolbar}>
        <Text accessibilityRole="header" style={[styles.heading, styles.flexibleHeading]}>项目文本资料</Text>
        <Action title={location.kind === 'projects' ? '关闭项目资料' : '返回'} onPress={back} />
      </View>
      <ScrollView contentContainerStyle={styles.thread} keyboardShouldPersistTaps="handled">
        <View style={styles.actions}>
          <Action title="重新读取" disabled={!!busy} onPress={() => read(location, query)} />
          {location.kind === 'resources' && view?.kind === 'resources' &&
            <Action title="选择 TXT 文件" disabled={!!busy} onPress={() => chooseText(location.projectId)} />}
        </View>
        {!!busy && <Text accessibilityLiveRegion="polite" style={styles.muted}>{busy}</Text>}
        {!!error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
        {!!notice && <Text accessibilityLiveRegion="polite" style={styles.muted}>{notice}</Text>}
        {view?.kind === 'projects' && <>
          {!view.page.items.length && <Text style={styles.muted}>暂无自有项目，可在网页版创建项目。</Text>}
          {view.page.items.map((item) => <View key={item.id} style={styles.message}>
            <Text style={styles.label}>{item.name}</Text>
            <Action title="查看资料" accessibilityLabel={`查看 ${item.name} 的资料`} disabled={!!busy}
              onPress={() => navigate({ kind: 'resources', projectId: item.id })} />
          </View>)}
          {view.page.nextCursor && <Action title="加载更多项目" disabled={!!busy} onPress={() => read(projects, '', view.page.nextCursor)} />}
        </>}
        {view?.kind === 'resources' && location.kind === 'resources' && <>
          <Text accessibilityRole="header" style={styles.label}>{view.name}</Text>
          <TextInput accessibilityLabel="资料搜索词" style={styles.input} placeholder="搜索名称或正文" placeholderTextColor={palette.muted}
            editable={!busy} value={term} onChangeText={setTerm} onSubmitEditing={() => { if ([...filter].length <= 100) navigate(location, filter); }} />
          <Action title="搜索资料" disabled={!!busy || [...filter].length > 100} onPress={() => { Keyboard.dismiss(); navigate(location, filter); }} />
          {[...filter].length > 100 && <Text style={styles.error}>搜索词最多 100 个字符。</Text>}
          {picked && <View style={styles.message}>
            <Text style={styles.label}>{picked.name}</Text>
            <Text style={styles.muted}>将文件正文导入当前项目。</Text>
            <Action title="导入到项目" primary disabled={!!busy} onPress={() => importText(location.projectId, picked)} />
            <Action title="取消导入" disabled={!!busy} onPress={() => setPicked(undefined)} />
          </View>}
          {!view.page.items.length && <Text style={styles.muted}>{query ? '未找到匹配资料。' : '暂无文本资料。'}</Text>}
          {view.page.items.map((item) => <View key={item.id} style={styles.message}>
            <Text style={styles.label}>{item.name}</Text>
            <Action title="读取正文" accessibilityLabel={`读取 ${item.name}`} disabled={!!busy}
              onPress={() => navigate({ kind: 'detail', projectId: location.projectId, resourceId: item.id }, query)} />
          </View>)}
          {view.page.nextCursor && <Action title="加载更多资料" disabled={!!busy} onPress={() => read(location, query, view.page.nextCursor)} />}
        </>}
        {view?.kind === 'detail' && location.kind === 'detail' && <>
          <Text accessibilityRole="header" style={styles.label}>{view.item.name}</Text>
          <View style={styles.actions}>
            <Action title="保存 TXT 到设备" disabled={!!busy} onPress={() => save(location)} />
            <Action title="删除资料" disabled={!!busy} onPress={() => remove(location)} />
          </View>
          <View style={styles.message}><Text selectable style={styles.body}>{view.item.content}</Text></View>
        </>}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}
