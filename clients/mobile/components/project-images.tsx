import { randomUUID } from 'expo-crypto';
import type { CameraView } from 'expo-camera';
import { File } from 'expo-file-system';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Image, Keyboard, Modal, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AssistantApiError, type AssistantClient, type components } from '../../../packages/contracts/dist/index.js';
import { saveDownload } from '../lib/save-download';
import { discardAbandonedCameraPhotos, discardCameraPhoto, pngLimit, pngType, prepareProjectPhoto } from '../lib/project-camera';
import { Action, palette, styles } from './ui';

type Project = components['schemas']['Project'];
type Attachment = components['schemas']['ProjectAttachment'];
type Selection = { file: File; key: string; fromCamera?: boolean };
type CameraModule = typeof import('expo-camera');
const attachmentStates: Record<Attachment['state'], string> = {
  quarantined: '等待隔离扫描', approved: '扫描通过', rejected: '未通过检查',
};

export function ProjectImages({ client, close, onSessionExpired }: {
  client: AssistantClient;
  close: () => void;
  onSessionExpired: (failure: AssistantApiError) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [project, setProject] = useState<Project>();
  const [items, setItems] = useState<Attachment[]>([]);
  const [selection, setSelection] = useState<Selection>();
  const [camera, setCamera] = useState<CameraModule>();
  const [cameraReady, setCameraReady] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const active = useRef(false);
  const pending = useRef<AbortController | null>(null);
  const cameraView = useRef<CameraView>(null);
  const cameraDraft = useRef<File | undefined>(undefined);
  const projectName = name.trim();
  const nameTooLong = [...projectName].length > 120;
  const selectedName = selection?.file.name ?? '';

  const abort = useCallback(() => {
    const request = pending.current;
    pending.current = null;
    request?.abort();
  }, []);

  const replaceSelection = useCallback((next?: Selection) => {
    if (cameraDraft.current) discardCameraPhoto(cameraDraft.current);
    cameraDraft.current = next?.fromCamera ? next.file : undefined;
    setSelection(next);
  }, []);

  const closeCamera = useCallback(() => {
    abort();
    setBusy('');
    setCameraReady(false);
    setCamera(undefined);
  }, [abort]);

  const operate = useCallback(async (label: string, fallback: string, work: (signal: AbortSignal) => Promise<void>) => {
    if (!active.current || pending.current) return;
    const request = new AbortController();
    pending.current = request;
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await work(request.signal);
    } catch (failure) {
      if (request.signal.aborted) return;
      if (failure instanceof AssistantApiError && failure.status === 401) onSessionExpired(failure);
      else if (failure instanceof AssistantApiError && failure.status === 403) setError('当前账号或项目无法使用图像附件。');
      else if (failure instanceof AssistantApiError && failure.status === 404) setError('此项目或图像已不可访问。');
      else setError(fallback);
    } finally {
      if (pending.current === request) {
        pending.current = null;
        setBusy('');
      }
    }
  }, [onSessionExpired]);

  const loadProjects = useCallback(async (after?: string) => {
    await operate('正在读取项目…', '暂时无法读取项目。', async (signal) => {
      const page = await client.listProjects({ cursor: after, limit: 30 });
      if (signal.aborted) return;
      setProjects((current) => after ? [...current, ...page.items.filter(({ id }) => !current.some((item) => item.id === id))] : page.items);
      setCursor(page.nextCursor);
    });
  }, [client, operate]);

  useEffect(() => {
    active.current = true;
    void loadProjects();
    return () => { active.current = false; abort(); };
  }, [abort, loadProjects]);

  useEffect(() => {
    discardAbandonedCameraPhotos();
    return () => { if (cameraDraft.current) discardCameraPhoto(cameraDraft.current); };
  }, []);

  useEffect(() => {
    if (!camera) return;
    const listener = AppState.addEventListener('change', (next) => {
      if (next === 'background') closeCamera();
    });
    return () => listener.remove();
  }, [camera, closeCamera]);

  const refresh = (id: string) => operate('正在读取图像状态…', '暂时无法读取图像状态。', async (signal) => {
    const page = await client.listProjectAttachments(id, signal);
    if (!signal.aborted) setItems(page.items);
  });

  function openProject(item: Project) {
    setProject(item);
    setItems([]);
    void refresh(item.id);
  }

  function goBack() {
    if (camera) { closeCamera(); return; }
    abort();
    if (!project) { close(); return; }
    setProject(undefined);
    replaceSelection();
    setItems([]);
    setBusy('');
    setError('');
    setNotice('');
  }

  function createProject() {
    if (!projectName || nameTooLong) return;
    Keyboard.dismiss();
    void operate('正在创建项目…', '无法创建项目，请核对名称后再试。', async (signal) => {
      const created = await client.createProject({ name: projectName });
      if (signal.aborted) return;
      setProjects((current) => [created, ...current]);
      setName('');
    });
  }

  function choosePng() {
    void operate('正在选择文件…', '无法读取所选文件。', async (signal) => {
      const picked = await File.pickFileAsync({ mimeTypes: pngType });
      if (signal.aborted || picked.canceled) return;
      const file = picked.result;
      if (!(file.size > 0 && file.size <= pngLimit) || file.type.toLowerCase() !== pngType) {
        replaceSelection();
        setError('请选择系统识别为 PNG 的 1 MiB 以内文件。');
        return;
      }
      replaceSelection({ file, key: randomUUID() });
    });
  }

  function openCamera() {
    void operate('正在检查相机权限…', '当前安装无法使用相机。你仍可选择 PNG。', async (signal) => {
      const module = await import('expo-camera');
      if (signal.aborted) return;
      const permission = await module.Camera.requestCameraPermissionsAsync();
      if (signal.aborted) return;
      if (!permission.granted) {
        setError(permission.canAskAgain ? '相机权限未授予。你可以重新拍照授权，或选择 PNG。'
          : '请在系统设置中允许相机权限，或直接选择 PNG。');
        return;
      }
      setCameraReady(false);
      setCamera(module);
    });
  }

  function takePhoto() {
    const view = cameraView.current;
    if (!cameraReady || !view) return;
    void operate('正在处理照片…', '无法生成 1 MiB 以内的 PNG。请重新拍摄或选择 PNG。', async (signal) => {
      const picture = await view.takePictureAsync({ pictureRef: true });
      try {
        if (signal.aborted) return;
        const key = randomUUID();
        const file = await prepareProjectPhoto(picture, key, signal);
        if (!file) return;
        if (signal.aborted) { discardCameraPhoto(file); return; }
        replaceSelection({ file, key, fromCamera: true });
        setCameraReady(false);
        setCamera(undefined);
        setNotice('照片已在设备上转换为 PNG。确认后可上传到当前项目。');
      } finally {
        picture.release();
      }
    });
  }

  function upload() {
    if (!project || !selection) return;
    void operate('正在上传图像…', '暂时无法上传。可以使用同一文件重试。', async (signal) => {
      const item = await client.uploadProjectAttachment(project.id, selection.file, selection.key, signal);
      if (signal.aborted) return;
      setItems((current) => [item, ...current.filter(({ id }) => id !== item.id)]);
      replaceSelection();
      setNotice('已接收图像。请刷新状态查看扫描结果。');
    });
  }

  function stopWaiting() {
    abort();
    setBusy('');
    setNotice('已停止等待。可刷新核对服务器状态，或使用同一文件重试。');
  }

  function download(id: string) {
    if (!project) return;
    void operate('正在保存图像…', '无法保存图像。请刷新状态后重试，或选择另一个目录。', async (signal) => {
      const name = await saveDownload(() => client.downloadProjectAttachment(project.id, id, signal), {
        filename: `qingyu-${randomUUID()}.png`, contentType: pngType, maxBytes: pngLimit, signal,
      });
      if (name && !signal.aborted) setNotice(`已保存 ${name}。`);
    });
  }

  function remove(id: string) {
    if (!project) return;
    Alert.alert('删除图像', '删除后将撤回此图像的访问授权。', [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => void operate('正在撤回图像…', '无法撤回图像，请刷新后重试。', async (signal) => {
        await client.deleteProjectAttachment(project.id, id, signal);
        if (signal.aborted) return;
        setItems((current) => current.filter((item) => item.id !== id));
        setNotice('图像已撤回。');
      }) },
    ]);
  }

  return <Modal visible onRequestClose={goBack}>
    <SafeAreaView style={styles.safe} accessibilityViewIsModal>
      <View style={styles.toolbar}>
        <Text accessibilityRole="header" style={[styles.heading, styles.flexibleHeading]}>{camera ? '拍摄项目图像' : '项目图像'}</Text>
        <Action title={camera ? '取消拍照' : project ? '返回项目' : '关闭项目图像'} onPress={goBack} />
      </View>
      {camera ? <>
        <camera.CameraView ref={cameraView} mode="picture" facing="back" style={cameraStyles.preview}
          onCameraReady={() => setCameraReady(true)} onMountError={() => {
            closeCamera();
            setError('无法启动相机。你仍可选择 PNG。');
          }} />
        <View style={cameraStyles.footer}>
          <Action title="拍摄照片" primary disabled={!cameraReady || !!busy} onPress={takePhoto} />
          {busy ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{busy}</Text> : null}
          {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
        </View>
      </> : <ScrollView contentContainerStyle={styles.thread} keyboardShouldPersistTaps="handled">
        {project ? <>
          <Text accessibilityRole="header" style={styles.label}>{project.name}</Text>
          <Text style={styles.body}>拍照或选择 1 MiB 以内的 PNG，扫描通过后可保存。</Text>
          {selection && <Text style={styles.muted}>{selection.fromCamera ? '待上传的拍摄照片'
            : /\.png$/i.test(selectedName) ? selectedName : '已选择 PNG 文件'}</Text>}
          {selection?.fromCamera && <Image source={{ uri: selection.file.uri }} resizeMode="contain"
            accessibilityLabel="照片预览" style={cameraStyles.thumbnail} />}
          <View style={styles.actions}>
            <Action title="选择 PNG" disabled={!!busy} onPress={choosePng} />
            <Action title="拍照" disabled={!!busy} onPress={openCamera} />
            <Action title="上传 PNG" primary disabled={!selection || !!busy} onPress={upload} />
            {selection && <Action title="清除已选" disabled={!!busy} onPress={() => replaceSelection()} />}
            <Action title="刷新状态" disabled={!!busy} onPress={() => void refresh(project.id)} />
            {(busy === '正在上传图像…' || busy === '正在保存图像…') && <Action title="取消等待" onPress={stopWaiting} />}
          </View>
          {!items.length && !busy && <Text style={styles.muted}>暂无图像附件。</Text>}
          {items.map((item) => <View key={item.id} style={styles.message}>
            <Text style={styles.label}>{attachmentStates[item.state]} · {Math.ceil(item.size / 1024)} KiB</Text>
            {item.state === 'approved' && <Text style={styles.muted}>{item.width} × {item.height} 像素</Text>}
            <View style={styles.actions}>
              {item.state === 'approved' && <Action title="保存 PNG" disabled={!!busy} onPress={() => download(item.id)} />}
              <Action title="删除图像" disabled={!!busy} onPress={() => remove(item.id)} />
            </View>
          </View>)}
        </> : <>
          <Text style={styles.label}>项目名称</Text>
          <TextInput accessibilityLabel="项目名称" placeholder="输入项目名称" placeholderTextColor={palette.muted}
            style={styles.input} maxLength={240} editable={!busy} value={name} onChangeText={setName} />
          {nameTooLong && <Text accessibilityLiveRegion="polite" style={styles.error}>项目名称最多 120 个字符。</Text>}
          <View style={styles.actions}>
            <Action title="创建项目" primary disabled={!!busy || !projectName || nameTooLong} onPress={createProject} />
            <Action title="刷新项目" disabled={!!busy} onPress={() => void loadProjects()} />
          </View>
          {!projects.length && !busy && <Text style={styles.muted}>暂无项目。</Text>}
          {projects.map((item) => <View key={item.id} style={styles.historyRow}>
            <Action title={item.name} disabled={!!busy} onPress={() => openProject(item)} />
          </View>)}
          {cursor && <Action title="加载更多项目" disabled={!!busy} onPress={() => void loadProjects(cursor)} />}
        </>}
        {busy ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{busy}</Text> : null}
        {notice ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{notice}</Text> : null}
        {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
      </ScrollView>}
    </SafeAreaView>
  </Modal>;
}

const cameraStyles = StyleSheet.create({
  preview: { flex: 1, backgroundColor: palette.ink },
  footer: { alignItems: 'center', gap: 8, padding: 12 },
  thumbnail: { height: 200, width: '100%' },
});
