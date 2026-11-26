import { randomUUID } from 'expo-crypto';
import { File, FileMode } from 'expo-file-system';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AssistantApiError, type AssistantClient, type components } from '../../../packages/contracts/dist/index.js';
import { BinaryUpload } from '../lib/binary-upload';
import { waitForForeground } from '../lib/foreground';
import { acceptsPdfHeader, pdfApproximation, pdfFileLimit, pdfTextLimit, requirePdfDownload, requirePdfPreview,
  type PdfTextPreview } from '../lib/project-pdf';
import { inspectWave, waveLimit, waveMime, wavePeaks } from '../lib/project-wave';
import { readDownloadBytes, saveDownload } from '../lib/save-download';
import { useProjectRecording } from '../lib/use-project-recording';
import { Action, palette, styles } from './ui';

type Data = components['schemas'];
type Attachment = Data['ProjectAudioAttachment'] | Data['ProjectPdfAttachment'];
export type MediaKind = 'wav' | 'pdf';
type Scope = { projectId: string };
type Snapshot = { kind: 'projects'; page: Data['ProjectPage'] }
  | { kind: 'attachments'; project: Data['Project']; items: Attachment[] };
type Selection = { name: string; details?: string; body: Blob; key: string };
type RecordedSelection = { id: string; key: string };
type Preview = { id: string; peaks: number[] } | PdfTextPreview;
type Operation = { controller: AbortController; choosing: boolean; timer?: ReturnType<typeof setTimeout> };
const states: Record<Attachment['state'], string> = {
  quarantined: '等待隔离扫描', approved: '扫描通过', rejected: '未通过检查',
};
const unavailable = '此项目或附件已不可访问。';
const pdfMime = 'application/pdf';
const formats = {
  wav: { name: '音频', title: '项目音频', suffix: 'WAV', mime: waveMime, limit: waveLimit, size: '1 MiB',
    pickerTypes: [waveMime, 'audio/x-wav', 'audio/wave', 'audio/vnd.wave'], hint: '16 位 PCM WAV，最长 30 秒，最大 1 MiB。' },
  pdf: { name: 'PDF', title: '项目 PDF', suffix: 'PDF', mime: pdfMime, limit: pdfFileLimit, size: '32 KiB',
    pickerTypes: [pdfMime], hint: '单页无压缩 PDF 1.4 文本，最大 32 KiB。扫描通过后可读取提取的纯文本。' },
} as const;

function readSelectedFile(file: File, kind: MediaKind, generalPdf: boolean): Selection {
  const format = formats[kind];
  const { name, size } = file;
  if (!name.toLowerCase().endsWith(`.${kind}`) || [...name].length > 120 || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
    throw new Error(`请选择名称不超过 120 个字符的 .${kind} 文件。`);
  }
  if (size < 1 || size > format.limit) throw new Error(`请选择 ${format.size} 以内的 ${format.suffix} 文件。`);
  const handle = file.open(FileMode.ReadOnly);
  try {
    const bytes = handle.readBytes(format.limit + 1);
    if (bytes.length !== size) throw new Error('未能完整读取文件。请重新选择。');
    if (kind === 'pdf' && !acceptsPdfHeader(bytes, generalPdf)) {
      throw new Error(generalPdf ? '请选择有效的 PDF 1.0–1.7 或 2.0 文件。' : '请选择符合 PDF 1.4 文本规范的文件。');
    }
    const details = kind === 'wav' ? describeFormat(inspectWave(bytes)) : undefined;
    return { name, details, body: new BinaryUpload(bytes, format.mime), key: randomUUID() };
  } finally { handle.close(); }
}

function describeFormat(audio: Data['AudioAttachmentFormat']) {
  return `${audio.channels === 1 ? '单声道' : '双声道'} · ${audio.sampleRate} Hz · ${audio.durationMillis / 1000} 秒`;
}

async function approvedBytes(client: AssistantClient, projectId: string, id: string, signal: AbortSignal) {
  const { items } = await client.listProjectAudioAttachments(projectId, signal);
  const current = items.find((item) => item.id === id && item.state === 'approved');
  if (!current?.audio) throw new AssistantApiError(404, 'NOT_FOUND', unavailable);
  const blob = await client.downloadProjectAudioAttachment(projectId, id, signal);
  const bytes = await readDownloadBytes(blob, 46, waveLimit);
  const layout = inspectWave(bytes, true);
  if (layout.sampleRate !== current.audio.sampleRate || layout.channels !== current.audio.channels
    || layout.durationMillis !== current.audio.durationMillis) throw new Error('Audio metadata mismatch');
  return { bytes, layout };
}

export function ProjectMedia({ client, kind, uploadsAllowed, generalPdf = false, pdfOcr = false, close, onSessionExpired }: {
  client: AssistantClient; kind: MediaKind; uploadsAllowed: boolean; generalPdf?: boolean; pdfOcr?: boolean; close: () => void;
  onSessionExpired: (problem: AssistantApiError) => void;
}) {
  const format = formats[kind];
  const canRead = kind !== 'pdf' || uploadsAllowed;
  const list = kind === 'wav' ? client.listProjectAudioAttachments : client.listProjectPdfAttachments;
  const upload = kind === 'wav' ? client.uploadProjectAudioAttachment : client.uploadProjectPdfAttachment;
  const removeAttachment = kind === 'wav' ? client.deleteProjectAudioAttachment : client.deleteProjectPdfAttachment;
  const scope = useRef<Scope | undefined>(undefined);
  const active = useRef(false);
  const pending = useRef<Operation | null>(null);
  const staged = useRef<Selection | undefined>(undefined);
  const [here, setHere] = useState<Scope>();
  const [view, setView] = useState<Snapshot>();
  const [draft, setDraft] = useState<Selection>();
  const [preview, setPreview] = useState<Preview>();
  const previewRef = useRef<Preview | undefined>(undefined);
  const [reviewOcrId, setReviewOcrId] = useState<string>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const authorizeRecording = useCallback((project: string, signal: AbortSignal) =>
    client.listProjectAudioAttachments(project, signal), [client]);
  const recording = useProjectRecording(here?.projectId, kind === 'wav' && uploadsAllowed && !!here, authorizeRecording, onSessionExpired);
  const discardRecording = recording.discard;
  const recordingClip = recording.state && 'frames' in recording.state ? recording.state : undefined;
  const recordingInProgress = !!recording.state && !recordingClip;

  const replaceDraft = useCallback((next?: Selection) => { staged.current = next; setDraft(next); }, []);
  const showPreview = useCallback((next?: Preview) => { previewRef.current = next; setPreview(next); }, []);
  const clear = useCallback(() => { setView(undefined); showPreview(); replaceDraft(); setReviewOcrId(undefined); },
    [replaceDraft, showPreview]);

  const stop = useCallback(() => {
    const current = pending.current;
    pending.current = null;
    clearTimeout(current?.timer);
    current?.controller.abort();
  }, []);

  const setDeadline = useCallback((current: Operation) => {
    current.timer = setTimeout(() => {
      if (pending.current !== current) return;
      stop();
      setView(undefined);
      showPreview();
      setReviewOcrId(undefined);
      setBusy('');
      setError('服务暂未响应。请先刷新状态。');
    }, 8_000);
  }, [showPreview, stop]);

  const operate = useCallback(async (label: string, fallback: string, work: (operation: Operation) => Promise<void>,
    { choosing = false, quiet = false } = {}) => {
    if (!active.current || pending.current) return false;
    const operation: Operation = { controller: new AbortController(), choosing };
    pending.current = operation;
    const { signal } = operation.controller;
    if (!quiet) setBusy(label);
    setError('');
    if (!choosing) setDeadline(operation);
    try { await work(operation); return !signal.aborted; }
    catch (problem) {
      if (!signal.aborted) {
        if (problem instanceof AssistantApiError && problem.status === 401) { clear(); onSessionExpired(problem); }
        else if (problem instanceof AssistantApiError && [403, 404, 409].includes(problem.status)) {
          discardRecording(); clear(); setError(unavailable);
        }
        else { showPreview(); setReviewOcrId(undefined); setError(fallback); }
      }
      return false;
    } finally {
      if (pending.current === operation) { stop(); setBusy(''); }
    }
  }, [clear, discardRecording, onSessionExpired, setDeadline, showPreview, stop]);

  const read = useCallback((next?: Scope, cursor?: string | null, quiet = false) => {
    void operate('正在刷新状态…', `暂时无法读取${format.title}。请重试。`, async ({ controller: { signal } }) => {
      if (!quiet && !cursor) { setView(undefined); setReviewOcrId(undefined); }
      if (!next) {
        const page = await client.listProjects({ limit: 30, cursor: cursor ?? undefined });
        if (!signal.aborted) setView((previous) => ({ kind: 'projects', page: cursor && previous?.kind === 'projects'
          ? { ...page, items: [...previous.page.items, ...page.items.filter(({ id }) => !previous.page.items.some((item) => item.id === id))] }
          : page }));
        return;
      }
      const displayed = previewRef.current;
      const recheckText = displayed && 'text' in displayed
        ? client.getProjectPdfAttachmentText(next.projectId, displayed.id, signal) : undefined;
      const [project, page, authorizedText] = await Promise.all([
        client.getProject(next.projectId), list.call(client, next.projectId, signal), recheckText,
      ]);
      if (signal.aborted) return;
      setView({ kind: 'attachments', project, items: page.items });
      if (kind === 'pdf') setReviewOcrId((current) => current && page.items.some((item) =>
        item.id === current && item.state === 'approved' && 'approximateText' in item && item.approximateText === true) ? current : undefined);
      if (displayed) {
        const current = page.items.find(({ id, state }) => id === displayed.id && state === 'approved');
        if (!current) showPreview();
        else if ('text' in displayed) {
          const confirmed = authorizedText && requirePdfPreview(current, authorizedText);
          if (!confirmed || confirmed.text !== displayed.text || confirmed.approximate !== displayed.approximate) showPreview();
        }
      }
    }, { quiet });
  }, [client, format.title, kind, list, operate, showPreview]);

  const navigate = useCallback((next?: Scope) => {
    stop();
    discardRecording();
    clear();
    scope.current = next;
    setHere(next);
    setNotice('');
    read(next);
  }, [clear, discardRecording, read, stop]);

  useEffect(() => {
    function update(state: string) {
      active.current = state === 'active';
      if (active.current) { if (!pending.current) read(scope.current); return; }
      if (!pending.current?.choosing) { stop(); setBusy(''); }
      clear();
      setNotice('');
      setError('');
    }
    const subscription = AppState.addEventListener('change', update);
    update(AppState.currentState);
    return () => { subscription.remove(); active.current = false; stop(); };
  }, [clear, read, stop]);

  const polling = !!preview || (view?.kind === 'attachments' && view.items.some(({ state }) => state === 'quarantined'));
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => { if (!staged.current) read(scope.current, null, true); }, 8_000);
    return () => clearInterval(timer);
  }, [polling, read]);

  function back() {
    if (pending.current?.choosing) return;
    if (scope.current) navigate(); else { stop(); close(); }
  }

  async function duringPicker(location: Scope, label: string, work: (checked: () => Promise<void>, signal: AbortSignal) => Promise<void>) {
    if (scope.current !== location) return;
    const succeeded = await operate(label, '无法读取所选文件或保存到此目录。', async (operation) => {
      setView(undefined);
      setNotice('');
      showPreview();
      setReviewOcrId(undefined);
      const { signal } = operation.controller;
      await work(async () => {
        await waitForForeground(signal);
        if (signal.aborted || !active.current || pending.current !== operation || scope.current !== location) {
          throw new Error('Picker scope ended');
        }
        operation.choosing = false;
        setBusy('正在核对访问权限…');
        setDeadline(operation);
      }, signal);
    }, { choosing: true });
    if (succeeded && active.current && scope.current === location) read(location);
  }

  function chooseFile(location: Scope) {
    replaceDraft();
    void duringPicker(location, `正在选择 ${format.suffix} 文件…`, async (checked, signal) => {
      const selected = await File.pickFileAsync({ mimeTypes: [...format.pickerTypes], multipleFiles: false });
      await checked();
      if (selected.canceled) return;
      await list.call(client, location.projectId, signal);
      if (signal.aborted) return;
      try { replaceDraft(readSelectedFile(selected.result, kind, generalPdf)); }
      catch (problem) { setNotice(problem instanceof Error ? problem.message : `无法读取所选 ${format.suffix} 文件。`); }
    });
  }

  function confirmUpload(location: Scope, selection: Selection | RecordedSelection) {
    Alert.alert(`上传私有 ${format.suffix}`, '将所选文件提交到当前项目，扫描通过后可查看和保存。', [
      { text: '取消', style: 'cancel' }, { text: '上传', onPress: () => {
        if (!uploadsAllowed || scope.current !== location) return;
        if ('body' in selection ? staged.current !== selection : !recording.ready(selection.id)) return;
        void operate(`正在上传${format.name}…`, '尚未确认上传结果。可用同一文件重试。', async ({ controller: { signal } }) => {
          setNotice('');
          const body = 'body' in selection ? selection.body : await recording.readClip(selection.id, signal);
          const item = await upload.call(client, location.projectId, body, selection.key, signal);
          if (signal.aborted) return;
          setView((old) => old?.kind === 'attachments' ? { ...old, items: [item, ...old.items.filter(({ id }) => id !== item.id)] } : old);
          replaceDraft();
          if (!('body' in selection)) discardRecording();
          setNotice(`已接收${format.name}。扫描结果可在列表中查看。`);
        });
      } },
    ]);
  }

  function previewAttachment(location: Scope, item: Attachment) {
    const { id } = item;
    if (preview?.id === id) { showPreview(); return; }
    const label = kind === 'pdf' ? '提取文本' : '波形';
    void operate(`正在读取${label}…`, `无法读取${label}。请刷新状态。`, async ({ controller: { signal } }) => {
      if (kind === 'pdf') {
        const current = await client.getProjectPdfAttachmentText(location.projectId, id, signal);
        if (!signal.aborted) showPreview(requirePdfPreview(item, current));
      } else {
        const { bytes, layout } = await approvedBytes(client, location.projectId, id, signal);
        if (!signal.aborted) showPreview({ id, peaks: wavePeaks(bytes, layout) });
      }
    });
  }

  function requestSave(location: Scope, item: Attachment) {
    if (!active.current || pending.current || scope.current !== location || item.state !== 'approved') return;
    try {
      if (kind === 'pdf' && pdfApproximation(item)) {
        setError('');
        setNotice('');
        setReviewOcrId(item.id);
        return;
      }
      save(location, item.id);
    } catch {
      showPreview();
      setError('无法确认 PDF 文本的提取方式。请刷新状态。');
    }
  }

  function save(location: Scope, id: string, acknowledgeOcr = false) {
    const stem = id.slice(0, 8);
    if (!/^[a-f0-9]{8}$/i.test(stem)) return;
    void duringPicker(location, '正在选择保存目录…', async (checked, signal) => {
      const name = await saveDownload(async () => {
        await checked();
        if (kind === 'pdf') {
          const { items } = await client.listProjectPdfAttachments(location.projectId, signal);
          const current = items.find((item) => item.id === id && item.state === 'approved');
          if (!current || pdfApproximation(current) !== acknowledgeOcr) {
            throw new AssistantApiError(409, 'CONFLICT', unavailable);
          }
          const blob = await client.downloadProjectPdfAttachment(location.projectId, id, signal, acknowledgeOcr);
          return requirePdfDownload(await readDownloadBytes(blob, 1, pdfTextLimit), acknowledgeOcr);
        }
        return (await approvedBytes(client, location.projectId, id, signal)).bytes;
      }, kind === 'pdf' ? { filename: 'extracted.txt', contentType: 'text/plain', maxBytes: pdfTextLimit, signal }
        : { filename: `project-audio-${stem}.wav`, contentType: waveMime, maxBytes: waveLimit, signal });
      if (!name && pending.current?.choosing) await checked();
      if (name && !signal.aborted) setNotice(`已保存 ${name}。`);
    });
  }

  function remove(location: Scope, id: string) {
    Alert.alert(`删除${format.title}`, `删除后将撤回此${format.name}的访问授权。`, [
      { text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: () => {
        if (scope.current !== location) return;
        void operate(`正在撤回${format.name}…`, '尚未确认删除结果。请刷新状态。', async ({ controller: { signal } }) => {
          await removeAttachment.call(client, location.projectId, id, signal);
          if (signal.aborted) return;
          if (previewRef.current?.id === id) showPreview();
          setReviewOcrId((current) => current === id ? undefined : current);
          setView((current) => current?.kind === 'attachments' ? { ...current, items: current.items.filter((item) => item.id !== id) } : current);
          setNotice(`${format.name}已撤回。`);
        });
      } },
    ]);
  }

  return <Modal visible onRequestClose={() => {
    if (reviewOcrId) setReviewOcrId(undefined); else back();
  }}>
    <SafeAreaView style={styles.safe} accessibilityViewIsModal>
      <View style={styles.toolbar}>
        <Text accessibilityRole="header" style={[styles.heading, styles.flexibleHeading]}>{format.title}</Text>
        <Action title={here ? '返回项目列表' : `关闭${format.title}`} onPress={back} />
      </View>
      <ScrollView contentContainerStyle={styles.thread}>
        <View style={styles.actions}>
          <Action title="刷新状态" disabled={!!busy || !!recording.state} onPress={() => read(here)} />
          {here && uploadsAllowed && view?.kind === 'attachments' && <Action title={`选择 ${format.suffix} 文件`}
            disabled={!!busy || !!recording.state} onPress={() => chooseFile(here)} />}
          {recording.available && view?.kind === 'attachments' && !recording.state && <Action title="开始本机录音" disabled={!!busy}
            onPress={() => { replaceDraft(); showPreview(); setNotice(''); void recording.start(); }} />}
          {busy === `正在上传${format.name}…` && <Action title="取消等待" onPress={() => {
            stop(); setBusy(''); setNotice('已停止等待。可刷新核对服务是否接收，或重试同一文件。');
          }} />}
        </View>
        {!!busy && <Text accessibilityLiveRegion="polite" style={styles.muted}>{busy}</Text>}
        {!!error && <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text>}
        {!!notice && <Text accessibilityLiveRegion="polite" style={styles.muted}>{notice}</Text>}
        {!!recording.error && <Text accessibilityLiveRegion="polite" style={styles.error}>{recording.error}</Text>}
        {view?.kind === 'projects' && <>
          {!view.page.items.length && <Text style={styles.muted}>暂无自有项目，可在网页版创建项目。</Text>}
          {view.page.items.map((project) => <View key={project.id} style={styles.message}>
            <Text style={styles.label}>{project.name}</Text>
            <Action title={`查看${format.title}`} accessibilityLabel={`查看 ${project.name} 的${format.name}`}
              disabled={!!busy} onPress={() => navigate({ projectId: project.id })} />
          </View>)}
          {view.page.nextCursor && <Action title="加载更多项目" disabled={!!busy} onPress={() => read(undefined, view.page.nextCursor)} />}
        </>}
        {view?.kind === 'attachments' && here && <>
          <Text accessibilityRole="header" style={styles.label}>{view.project.name}</Text>
          {uploadsAllowed && <Text style={styles.muted}>{kind === 'pdf' && generalPdf
            ? '文本型 PDF，最多 8 页，最大 32 KiB。扫描通过后可读取提取的纯文本。' : format.hint}</Text>}
          {kind === 'pdf' && pdfOcr && uploadsAllowed && <Text style={styles.muted}>单页扫描件可尝试 OCR，识别结果需核对。</Text>}
          {!canRead && <Text style={styles.muted}>当前只可查看处理状态及删除已有 PDF。</Text>}
          {recordingInProgress && <View style={styles.message}>
            <Text accessibilityLiveRegion="polite" style={styles.label}>{recording.state?.phase === 'recording' ? '正在本机录音 · 最长 30 秒'
              : recording.state?.phase === 'finishing' ? '正在结束录音…' : '正在准备本机录音…'}</Text>
            <View style={styles.actions}>
              <Action title="结束录音" primary disabled={recording.state?.phase !== 'recording'} onPress={recording.finish} />
              <Action title="取消录音" onPress={() => discardRecording()} />
            </View>
          </View>}
          {recordingClip && <View style={styles.message}>
            <Text style={styles.label}>本机录音.wav</Text>
            <Text style={styles.muted}>单声道 · 16000 Hz · {(recordingClip.frames / 16_000).toFixed(2)} 秒</Text>
            <Text style={styles.muted}>录音留在本机。点上传后才会发送到当前项目。</Text>
            <View style={styles.actions}>
              <Action title={recordingClip.phase === 'playing' ? '停止试听' : '试听录音'} disabled={!!busy} onPress={recording.togglePlayback} />
              <Action title="上传录音" primary disabled={!!busy || recordingClip.phase !== 'ready'}
                onPress={() => confirmUpload(here, { id: recordingClip.id, key: recordingClip.id })} />
              <Action title="丢弃录音" disabled={!!busy} onPress={() => discardRecording()} />
            </View>
          </View>}
          {draft && uploadsAllowed && <View style={styles.message}>
            <Text style={styles.label}>{draft.name}</Text>
            <Text style={styles.muted}>{draft.details ? `${draft.details} · ` : ''}{draft.body.size} 字节</Text>
            <View style={styles.actions}>
              <Action primary title={`上传 ${format.suffix}`} disabled={!!busy} onPress={() => confirmUpload(here, draft)} />
              <Action title="取消选择" disabled={!!busy} onPress={() => replaceDraft()} />
            </View>
          </View>}
          {!view.items.length && <Text style={styles.muted}>{`暂无${format.title}。`}</Text>}
          {view.items.map((item) => <View key={item.id} style={styles.message}>
            <Text style={styles.label}>{format.suffix} {item.id.slice(0, 8)}</Text>
            <Text style={styles.muted}>{states[item.state]}</Text>
            {kind === 'pdf' && item.state === 'approved' && 'approximateText' in item && item.approximateText === true
              && <Text accessibilityLiveRegion="polite" style={styles.label}>扫描件 OCR · 识别文本可能有误</Text>}
            {'audio' in item && item.audio && <Text style={styles.muted}>{describeFormat(item.audio)}</Text>}
            {preview?.id === item.id && 'text' in preview && <Text style={styles.body}>{preview.text}</Text>}
            {preview?.id === item.id && 'peaks' in preview && <View accessible accessibilityLabel="扫描通过的 WAV 波形" style={waveStyles.waveform}>
              {preview.peaks.map((peak, index) => <View key={index} style={[waveStyles.peak, { height: 2 + Math.round(peak * 48) }]} />)}
            </View>}
            <View style={styles.actions}>
              {item.state === 'approved' && canRead && <>
                <Action title={`${preview?.id === item.id ? '关闭' : '预览'}${kind === 'pdf' ? '提取文本' : '波形'}`}
                  disabled={!!busy || !!recording.state} onPress={() => previewAttachment(here, item)} />
                <Action title={kind === 'pdf' ? '保存提取文本到设备' : '保存 WAV 到设备'}
                  disabled={!!busy || !!recording.state || reviewOcrId === item.id} onPress={() => requestSave(here, item)} />
              </>}
              <Action title={`删除${format.name}`} disabled={!!busy || !!recording.state} onPress={() => remove(here, item.id)} />
            </View>
            {canRead && item.state === 'approved' && reviewOcrId === item.id && <View>
              <Text accessibilityLiveRegion="polite" style={styles.body}>OCR 文本可能有误。保存的文件会保留提示，请对照原件核对。</Text>
              <View style={styles.actions}>
                <Action title="取消保存" onPress={() => setReviewOcrId(undefined)} />
                <Action title="确认保存 OCR 文本" primary disabled={!!busy} onPress={() => save(here, item.id, true)} />
              </View>
            </View>}
          </View>)}
        </>}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

const waveStyles = StyleSheet.create({
  waveform: { flexDirection: 'row', alignItems: 'center', height: 56, gap: 2, backgroundColor: palette.canvas, paddingHorizontal: 8 },
  peak: { flex: 1, borderRadius: 2, backgroundColor: palette.brand },
});
