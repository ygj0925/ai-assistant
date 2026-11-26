import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Modal, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AssistantApiError, type AssistantClient, type components } from '../../../packages/contracts/dist/index.js';
import { waitForForeground } from '../lib/foreground';
import { saveDownload } from '../lib/save-download';
import { ArtifactBody } from './artifact-body';
import { Action, styles } from './ui';

type Data = components['schemas'];
type Format = Data['ArtifactFormat'];
type Version = Data['ArtifactVersion'];
type Route = { kind: 'home' } | { kind: 'head' | 'history'; id: string; format: Format }
  | { kind: 'version'; id: string; versionId: string; format: Format };
type Snapshot = { kind: 'home'; page: Data['ArtifactPage'] }
  | { kind: 'history'; head: Data['ArtifactVersionPage']; format: Format }
  | { kind: 'retiredImage' }
  | { kind: 'detail'; version: Version; format: Format };
type Transfer = { controller: AbortController; choosingDirectory: boolean; timer?: ReturnType<typeof setTimeout> };

const home: Route = { kind: 'home' };
const formats = {
  text: { label: '纯文本', ext: 'txt', mime: 'text/plain', maxBytes: 32_768 },
  markdown: { label: 'Markdown', ext: 'md', mime: 'text/markdown', maxBytes: 32_768 },
  code: { label: '代码稿', ext: 'txt', mime: 'text/plain', maxBytes: 32_768 },
  sheet: { label: '工作表', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', maxBytes: 2_097_152 },
  slides: { label: '幻灯片', ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', maxBytes: 2_097_152 },
  webpage: { label: '静态网页', ext: 'html', mime: 'text/html', maxBytes: 262_144 },
  image: { label: '图像', ext: 'png', mime: 'image/png', maxBytes: 1_048_576 },
} satisfies Record<Format, { label: string; ext: string; mime: string; maxBytes: number }>;
const codeSuffix = { plaintext: 'txt', javascript: 'js.txt', typescript: 'ts.txt', python: 'py.txt', java: 'java.txt',
  sql: 'sql.txt', json: 'json.txt', css: 'css.txt' } satisfies Record<Data['CodeLanguage'], string>;
const denied = '此产物或版本已不可访问。';
const retiredImageTitle = '已退役的图像产物';

export function PrivateArtifacts({ client, close, onSessionExpired }: {
  client: AssistantClient;
  close: () => void;
  onSessionExpired: (failure: AssistantApiError) => void;
}) {
  const route = useRef<Route>(home);
  const foreground = useRef(false);
  const request = useRef<AbortController | null>(null);
  const transfer = useRef<Transfer | null>(null);
  const [location, setLocation] = useState<Route>(home);
  const [view, setView] = useState<Snapshot>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const stopRead = useCallback(() => {
    request.current?.abort();
    request.current = null;
  }, []);

  const stopExport = useCallback(() => {
    const current = transfer.current;
    if (!current) return;
    transfer.current = null;
    clearTimeout(current.timer);
    current.controller.abort();
  }, []);

  const showFailure = useCallback((failure: unknown, fallback: string) => {
    setView(undefined);
    if (failure instanceof AssistantApiError && failure.status === 401) onSessionExpired(failure);
    else setError(failure instanceof AssistantApiError && (failure.status === 403 || failure.status === 404) ? denied : fallback);
  }, [onSessionExpired]);

  const read = useCallback(async (next: Route, after?: string | null) => {
    if (!foreground.current || request.current || transfer.current) return;
    const token = new AbortController();
    request.current = token;
    const { signal } = token;
    const cursor = after ?? undefined;
    const timer = setTimeout(() => {
      if (request.current !== token) return;
      stopRead();
      setView(undefined);
      setBusy('');
      setError('服务暂未响应。请重新读取。');
    }, 8_000);
    setBusy('正在核对访问权限…');
    setError('');
    if (!cursor) setView(undefined);
    try {
      switch (next.kind) {
        case 'home': {
          const page = await client.listArtifacts({ limit: 20, cursor }, signal);
          if (signal.aborted) return;
          setView((current) => ({ kind: 'home', page: cursor && current?.kind === 'home'
            ? { ...page, items: [...current.page.items, ...page.items] } : page }));
          break;
        }
        case 'head': {
          try {
            const item = await client.getArtifact(next.id, signal);
            if (!signal.aborted) setView(item.headAvailable === false ? { kind: 'retiredImage' }
              : { kind: 'detail', version: item.head, format: item.format });
          } catch (failure) {
            if (next.format !== 'image' || !(failure instanceof AssistantApiError) || failure.status !== 404) throw failure;
            await client.listArtifactVersions(next.id, { limit: 1 }, signal);
            if (!signal.aborted) setView({ kind: 'retiredImage' });
          }
          break;
        }
        case 'history': {
          const head = await client.listArtifactVersions(next.id, { limit: 16, cursor }, signal);
          if (signal.aborted) return;
          setView((current) => ({ kind: 'history', format: next.format, head: cursor && current?.kind === 'history'
            ? { ...head, items: [...current.head.items, ...head.items] } : head }));
          break;
        }
        case 'version': {
          const version = await client.getArtifactVersion(next.id, next.versionId, signal);
          if (!signal.aborted) setView({ kind: 'detail', version, format: next.format });
          break;
        }
      }
    } catch (failure) {
      if (!signal.aborted) showFailure(failure, '暂时无法读取私有产物。请重试。');
    } finally {
      clearTimeout(timer);
      if (request.current === token) {
        request.current = null;
        setBusy('');
      }
    }
  }, [client, showFailure, stopRead]);

  const navigate = useCallback((next: Route) => {
    stopRead();
    route.current = next;
    setLocation(next);
    setNotice('');
    void read(next);
  }, [read, stopRead]);

  useEffect(() => {
    function update(state: string) {
      foreground.current = state === 'active';
      if (foreground.current) {
        if (!transfer.current) void read(route.current);
        return;
      }
      stopRead();
      if (transfer.current && !transfer.current.choosingDirectory) stopExport();
      setView(undefined);
      setNotice('');
      setError('');
      if (!transfer.current) setBusy('');
    }
    const subscription = AppState.addEventListener('change', update);
    update(AppState.currentState);
    return () => {
      subscription.remove();
      foreground.current = false;
      stopRead();
      stopExport();
    };
  }, [read, stopExport, stopRead]);

  const back = () => {
    if (transfer.current) return;
    const here = route.current;
    if (here.kind === 'home') close();
    else if (here.kind === 'version') navigate({ kind: 'history', id: here.id, format: here.format });
    else if (here.kind === 'history') navigate({ kind: 'head', id: here.id, format: here.format });
    else navigate(home);
  };

  async function save(artifactId: string, versionId: string, number: number, format: Format, language?: Data['CodeLanguage']) {
    if (!foreground.current || transfer.current || request.current) return;
    const resourceKey = artifactId.slice(0, 8);
    if (!/^[a-f0-9]{8}$/i.test(resourceKey) || !Number.isInteger(number) || number < 1 || number > 32) return;
    const spec = formats[format];
    const extension = format === 'code' && language ? codeSuffix[language] ?? 'txt' : spec.ext;
    const current: Transfer = { controller: new AbortController(), choosingDirectory: true };
    const { signal } = current.controller;
    transfer.current = current;
    setView(undefined);
    setBusy('正在选择保存目录…');
    setError('');
    setNotice('');
    try {
      const name = await saveDownload(async () => {
        await waitForForeground(signal);
        if (signal.aborted || !foreground.current || transfer.current !== current) throw new Error('Export scope ended');
        current.choosingDirectory = false;
        setBusy('正在核对版本并下载…');
        current.timer = setTimeout(() => {
          if (transfer.current !== current) return;
          stopExport();
          setBusy('');
          setError('无法核对当前访问权限。请重新读取。');
        }, 8_000);
        return client.downloadArtifactVersion(artifactId, versionId, format, signal);
      }, { filename: `artifact-${resourceKey}-v${number}.${extension}`, contentType: spec.mime, maxBytes: spec.maxBytes,
        allowEmpty: format === 'text' || format === 'markdown' || format === 'code', signal });
      if (!signal.aborted && name) setNotice(`已保存 ${name}。`);
    } catch (failure) {
      if (!signal.aborted) {
        showFailure(failure, '无法保存当前版本。请重新读取。');
        if (transfer.current === current) {
          stopExport();
          setBusy('');
        }
      }
    } finally {
      if (transfer.current === current) {
        stopExport();
        setBusy('');
        if (foreground.current) void read(route.current);
      }
    }
  }

  return <Modal visible onRequestClose={back}>
    <SafeAreaView style={styles.safe} accessibilityViewIsModal>
      <View style={styles.toolbar}>
        <Text accessibilityRole="header" style={[styles.heading, styles.flexibleHeading]}>
          {location.kind === 'history' ? '产物版本记录' : location.kind === 'version' ? '产物历史版本' : '私有产物'}
        </Text>
        <Action title={location.kind === 'home' ? '关闭私有产物' : '返回'} onPress={back} />
      </View>
      <ScrollView contentContainerStyle={styles.thread}>
        <View style={styles.actions}>
          <Action title="重新读取" disabled={!!busy} onPress={() => void read(location)} />
          {(view?.kind === 'detail' || view?.kind === 'retiredImage') && location.kind === 'head' &&
            <Action title="版本记录" onPress={() => navigate({ kind: 'history', id: location.id, format: location.format })} />}
        </View>
        {!!busy && <Text style={styles.muted} accessibilityLiveRegion="polite">{busy}</Text>}
        {!!error && <Text style={styles.error} accessibilityLiveRegion="polite">{error}</Text>}
        {!!notice && <Text style={styles.muted} accessibilityLiveRegion="polite">{notice}</Text>}
        {view?.kind === 'home' && <>
          {!view.page.items.length && <Text style={styles.muted}>暂无私有产物。</Text>}
          {view.page.items.map((item) => {
            const retired = item.headAvailable === false;
            const name = retired ? retiredImageTitle : item.title;
            return <View key={item.id} style={styles.message}>
              <Text style={styles.label}>{name}</Text>
              {!retired && <Text style={styles.muted}>{formats[item.format].label} · 第 {item.headVersionNumber} 版</Text>}
              <Action title="查看产物" accessibilityLabel={`查看 ${name}`} disabled={!!busy}
                onPress={() => navigate({ kind: 'head', id: item.id, format: item.format })} />
            </View>;
          })}
          {view.page.nextCursor && <Action title="加载更多产物" disabled={!!busy} onPress={() => void read(home, view.page.nextCursor)} />}
        </>}
        {view?.kind === 'history' && location.kind === 'history' && <>
          {!view.head.items.length && <Text style={styles.muted}>暂无可读取的历史版本。</Text>}
          {view.head.items.map((item) => <View key={item.id} style={styles.message}>
            <Text style={styles.label}>{item.title}</Text>
            <Action title={`查看第 ${item.number} 版`} disabled={!!busy} onPress={() => navigate({
              kind: 'version', id: location.id, versionId: item.id, format: view.format,
            })} />
          </View>)}
          {view.head.nextCursor && <Action title="加载更多版本" disabled={!!busy} onPress={() => void read(location, view.head.nextCursor)} />}
        </>}
        {view?.kind === 'retiredImage' && <View style={styles.message}>
          <Text accessibilityRole="header" style={styles.heading}>{retiredImageTitle}</Text>
          <Text style={styles.muted}>原图已撤回。版本记录会列出仍可读取的版本，可在桌面网页版查看可用的恢复操作。</Text>
        </View>}
        {view?.kind === 'detail' && <>
          <Text accessibilityRole="header" style={styles.heading}>{view.version.title}</Text>
          <Text style={styles.muted}>{formats[view.format].label} · 第 {view.version.number} 版</Text>
          {view.format !== 'image' && <Text style={styles.muted}>可在桌面网页版编辑产物。</Text>}
          <Action title="保存此版本到设备" disabled={!!busy} onPress={() => void save(view.version.artifactId,
            view.version.id, view.version.number, view.format, 'code' in view.version ? view.version.code.language : undefined)} />
          <ArtifactBody body={view.version} />
        </>}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

