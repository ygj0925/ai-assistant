import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Image, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AssistantApiError, type AssistantClient, type components } from '../../../packages/contracts/dist/index.js';
import { waitForForeground } from '../lib/foreground';
import { readDownloadBytes, saveDownload } from '../lib/save-download';
import { ArtifactBody } from './artifact-body';
import { Action, styles } from './ui';

const pngLimit = 1_048_576;
const signature = [137, 80, 78, 71, 13, 10, 26, 10];
const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const defaultAlt = '已发布 PNG';
type Data = components['schemas'];
export const publicationFormats = {
  image: { type: '图片', label: 'PNG', ext: 'png', mime: 'image/png', maxBytes: pngLimit },
  sheet: { type: '工作表', label: 'XLSX', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', maxBytes: 2_097_152 },
  slides: { type: '幻灯片', label: 'PPTX', ext: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', maxBytes: 2_097_152 },
  code: { type: '代码稿', label: '代码稿', ext: 'txt', mime: 'text/plain', maxBytes: 32_768 },
} as const;
export type PublicationFormat = keyof typeof publicationFormats;

type Projection = { title: string; number: number; size: number } & (
  | { format: 'image'; image: { width: number; height: number; altText: string } }
  | { format: 'sheet'; sheet: Data['Spreadsheet'] }
  | { format: 'slides'; presentation: Data['Presentation'] }
  | { format: 'code'; code: Data['CodeDraft'] }
);
type Transfer = { controller: AbortController; choosingFolder: boolean; timer?: ReturnType<typeof setTimeout> };

export function supportsPublication(format: Data['ArtifactPublishedFormat']): format is PublicationFormat {
  return Object.hasOwn(publicationFormats, format);
}

async function checkedPublication(client: AssistantClient, projectId: string, publicationId: string,
  format: PublicationFormat, signal: AbortSignal): Promise<Projection> {
  const current = await client.getProjectArtifactPublication(projectId, publicationId, signal);
  if (current.id !== publicationId || current.format !== format || !Number.isInteger(current.versionNumber)
    || current.versionNumber < 1 || current.versionNumber > 32 || !Number.isInteger(current.sizeBytes)
    || current.sizeBytes < 0 || current.sizeBytes > pngLimit) throw new Error('Invalid publication metadata');
  const projection = { title: current.title, number: current.versionNumber, size: current.sizeBytes };
  if (format === 'image' && 'image' in current) {
    const { size, width, height, altText } = current.image;
    if (size < 1 || current.sizeBytes !== size || width < 1 || width > 2048 || height < 1 || height > 2048) {
      throw new Error('Invalid PNG metadata');
    }
    return { ...projection, format, image: { width, height, altText } };
  }
  if (format === 'sheet' && 'sheet' in current) return { ...projection, format, sheet: current.sheet };
  if (format === 'slides' && 'presentation' in current) return { ...projection, format, presentation: current.presentation };
  if (format === 'code' && 'code' in current) return { ...projection, format, code: current.code };
  throw new Error('Invalid publication body');
}

async function readPng(client: AssistantClient, projectId: string, publicationId: string, size: number, signal: AbortSignal) {
  const blob = await client.downloadProjectArtifactPublication(projectId, publicationId, 'image', signal);
  const bytes = await readDownloadBytes(blob, size, size);
  if (bytes.length !== size || !signature.every((value, index) => bytes[index] === value)) throw new Error('Invalid PNG bytes');
  return bytes;
}

function imageUri(bytes: Uint8Array) {
  let uri = 'data:image/png;base64,';
  for (let offset = 0; offset < bytes.length; offset += 3) {
    const first = bytes[offset];
    const second = bytes[offset + 1] ?? 0;
    const third = bytes[offset + 2] ?? 0;
    uri += base64[first >> 2] + base64[((first & 3) << 4) | (second >> 4)];
    uri += offset + 1 < bytes.length ? base64[((second & 15) << 2) | (third >> 6)] : '=';
    uri += offset + 2 < bytes.length ? base64[third & 63] : '=';
  }
  return uri;
}

export function PublishedArtifact({ client, projectId, publicationId, format, back, onSessionExpired }: {
  client: AssistantClient; projectId: string; publicationId: string; format: PublicationFormat; back: () => void;
  onSessionExpired: (failure: AssistantApiError) => void;
}) {
  const active = useRef(false);
  const reading = useRef<AbortController | null>(null);
  const transfer = useRef<Transfer | null>(null);
  const [metadata, setMetadata] = useState<Projection>();
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const spec = publicationFormats[format];
  const unavailable = format === 'image' ? '这张发布图片已不可访问。' : '此发布已不可访问。';
  const retry = `暂时无法核对发布${spec.type}。请重新读取。`;

  const stopRead = useCallback(() => {
    reading.current?.abort();
    reading.current = null;
  }, []);

  const stopTransfer = useCallback(() => {
    const current = transfer.current;
    if (!current) return;
    transfer.current = null;
    clearTimeout(current.timer);
    current.controller.abort();
  }, []);

  const scrub = useCallback(() => {
    setMetadata(undefined);
    setPreview('');
    setNotice('');
  }, []);

  const failure = useCallback((problem: unknown) => {
    scrub();
    if (problem instanceof AssistantApiError && problem.status === 401) onSessionExpired(problem);
    else setError(problem instanceof AssistantApiError && (problem.status === 403 || problem.status === 404) ? unavailable : retry);
  }, [onSessionExpired, retry, scrub, unavailable]);

  const read = useCallback(async (loadPreview = false, quiet = false) => {
    if (!active.current || reading.current || transfer.current) return;
    const current = new AbortController();
    reading.current = current;
    const { signal } = current;
    if (!quiet) setBusy(loadPreview ? '正在读取预览…' : '正在核对访问权限…');
    setError('');
    const timer = setTimeout(() => {
      if (reading.current !== current) return;
      stopRead();
      scrub();
      setBusy('');
      setError(retry);
    }, 8_000);
    try {
      const item = await checkedPublication(client, projectId, publicationId, format, signal);
      if (signal.aborted) return;
      if (loadPreview && item.format === 'image') {
        const bytes = await readPng(client, projectId, publicationId, item.size, signal);
        if (signal.aborted) return;
        setPreview(imageUri(bytes));
      }
      setMetadata(item);
    } catch (problem) {
      if (!signal.aborted) failure(problem);
    } finally {
      clearTimeout(timer);
      if (reading.current === current) {
        reading.current = null;
        setBusy('');
      }
    }
  }, [client, failure, format, projectId, publicationId, retry, scrub, stopRead]);

  useEffect(() => {
    function update(state: string) {
      active.current = state === 'active';
      if (active.current) {
        if (!transfer.current) void read();
      } else {
        stopRead();
        if (transfer.current && !transfer.current.choosingFolder) stopTransfer();
        scrub();
        setError('');
        if (!transfer.current) setBusy('');
      }
    }
    const subscription = AppState.addEventListener('change', update);
    update(AppState.currentState);
    return () => {
      active.current = false;
      subscription.remove();
      stopRead();
      stopTransfer();
    };
  }, [read, scrub, stopRead, stopTransfer]);

  const verifying = metadata !== undefined;
  useEffect(() => {
    if (!verifying) return;
    const interval = setInterval(() => void read(false, true), 15_000);
    return () => clearInterval(interval);
  }, [read, verifying]);

  async function save(item: Projection) {
    if (!active.current || reading.current || transfer.current) return;
    const stem = publicationId.slice(0, 8);
    if (!/^[a-f0-9]{8}$/i.test(stem)) return;
    const current: Transfer = { controller: new AbortController(), choosingFolder: true };
    const { signal } = current.controller;
    transfer.current = current;
    scrub();
    setError('');
    setBusy('正在选择保存目录…');
    try {
      const name = await saveDownload(async () => {
        await waitForForeground(signal);
        if (signal.aborted || !active.current || transfer.current !== current) throw new Error('Save scope ended');
        current.choosingFolder = false;
        setBusy('正在核对权限并下载…');
        current.timer = setTimeout(() => {
          if (transfer.current !== current) return;
          stopTransfer();
          setBusy('');
          setError(retry);
        }, 8_000);
        const fresh = await checkedPublication(client, projectId, publicationId, format, signal);
        if (fresh.number !== item.number) throw new Error('Published revision changed');
        return fresh.format === 'image' ? readPng(client, projectId, publicationId, fresh.size, signal)
          : client.downloadProjectArtifactPublication(projectId, publicationId, fresh.format, signal);
      }, { filename: `publication-${stem}-v${item.number}.${spec.ext}`, contentType: spec.mime, maxBytes: spec.maxBytes,
        allowEmpty: format === 'code', signal });
      if (!signal.aborted && name) setNotice(`已保存 ${name}。`);
    } catch (problem) {
      if (!signal.aborted) {
        failure(problem);
        if (transfer.current === current) { stopTransfer(); setBusy(''); }
      }
    } finally {
      if (transfer.current === current) {
        stopTransfer();
        setBusy('');
        if (active.current) void read();
      }
    }
  }

  return <SafeAreaView style={styles.safe} accessibilityViewIsModal>
    <View style={styles.toolbar}>
      <Text accessibilityRole="header" style={[styles.heading, styles.flexibleHeading]}>{`已发布${spec.type}`}</Text>
      <Action title="返回项目发布" onPress={back} />
    </View>
    <ScrollView contentContainerStyle={styles.thread}>
      <View style={styles.actions}><Action title={`重新读取发布${spec.type}`} disabled={!!busy} onPress={() => void read()} /></View>
      {!!busy && <Text accessibilityLiveRegion="polite" style={styles.muted}>{busy}</Text>}
      {!!error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
      {!!notice && <Text accessibilityLiveRegion="polite" style={styles.muted}>{notice}</Text>}
      {metadata && <View style={styles.message}>
        <Text accessibilityRole="header" style={styles.heading}>{metadata.title}</Text>
        <Text style={styles.muted}>{`第 ${metadata.number} 版 · ${spec.label}`}
          {metadata.format === 'image' && ` · ${metadata.image.width} × ${metadata.image.height} · ${metadata.size} 字节`}</Text>
        {metadata.format === 'image' && !!metadata.image.altText && <Text style={styles.body}>{metadata.image.altText}</Text>}
        <View style={styles.actions}>
          {metadata.format === 'image' && <Action title={preview ? '关闭图片预览' : '预览已发布图片'} disabled={!!busy}
            onPress={() => preview ? setPreview('') : void read(true)} />}
          <Action title={`保存发布 ${spec.label}`} disabled={!!busy} onPress={() => void save(metadata)} />
        </View>
        {metadata.format !== 'image' && <ArtifactBody body={metadata} />}
        {metadata.format === 'image' && !!preview && <Image accessibilityLabel={metadata.image.altText || defaultAlt} accessible resizeMode="contain" fadeDuration={0}
          style={{ width: '100%', height: 280 }} source={{ uri: preview }}
          onError={() => { setPreview(''); setError('当前设备无法显示此 PNG，可使用保存操作。'); }} />}
      </View>}
    </ScrollView>
  </SafeAreaView>;
}
