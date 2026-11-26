import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, PermissionsAndroid } from 'react-native';
import { AssistantApiError } from '../../../packages/contracts/dist/index.js';
import { localProjectRecording } from '../modules/local-project-recording';
import { BinaryUpload } from './binary-upload';
import { waitForForeground } from './foreground';
import { inspectWave, waveMime } from './project-wave';

type State = { id: string; project: string; phase: 'permission' | 'starting' | 'recording' | 'finishing' }
  | { id: string; project: string; phase: 'ready' | 'playing'; frames: number };
type Session = { state: State; request: AbortController; lease?: AbortController };
const microphone = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
const issues: Record<string, string> = {
  permission: '麦克风未授权。可以选择 WAV 文件。',
  offline: '连接已断开，本机录音已清除。',
  unavailable: '暂时无法录音。可以选择 WAV 文件。',
  empty: '没有录到音频。请重试或选择 WAV 文件。',
};

export function useProjectRecording(project: string | undefined, enabled: boolean,
  authorize: (project: string, signal: AbortSignal) => Promise<unknown>, onSessionExpired: (error: AssistantApiError) => void) {
  const native = localProjectRecording;
  const current = useRef<Session | undefined>(undefined);
  const [state, setState] = useState<State>();
  const [error, setError] = useState('');
  const available = enabled && native?.supported() === true;

  const update = useCallback((session: Session, next: State) => {
    if (current.current !== session) return false;
    session.state = next;
    setState(next);
    return true;
  }, []);

  const discard = useCallback((render = true) => {
    const previous = current.current;
    current.current = undefined;
    previous?.request.abort();
    previous?.lease?.abort();
    if (previous) void native?.discard(previous.state.id).catch(() => undefined);
    if (render) { setState(undefined); setError(''); }
  }, [native]);

  const reportLoss = useCallback((session: Session, failure: unknown) => {
    if (current.current !== session) return;
    discard();
    if (failure instanceof AssistantApiError && failure.status === 401) onSessionExpired(failure);
    else if (failure instanceof AssistantApiError && [403, 404].includes(failure.status)) setError('此项目已不可访问，本机录音已清除。');
    else setError(issues.offline);
  }, [discard, onSessionExpired]);

  const verifyCurrentProject = useCallback(async (session: Session) => {
    if (session.lease || current.current !== session) return false;
    const lease = new AbortController();
    session.lease = lease;
    const timeout = setTimeout(() => { reportLoss(session, new Error('Project authorization timeout')); }, 2_500);
    try {
      await authorize(session.state.project, lease.signal);
      return current.current === session && AppState.currentState === 'active';
    } catch (error) {
      if (!lease.signal.aborted) reportLoss(session, error);
      return false;
    } finally {
      clearTimeout(timeout);
      session.lease = undefined;
    }
  }, [authorize, reportLoss]);

  useLayoutEffect(() => {
    if (!available || current.current && current.current.state.project !== project) discard();
  }, [available, discard, project]);

  useEffect(() => {
    if (!native || !available) return;
    const subscription = native.addListener('onProjectRecording', ({ id, phase, frames }) => {
      const session = current.current;
      if (!session || session.state.id !== id) return;
      const previous = session.state;
      if (phase === 'recording') {
        if (previous.phase === 'starting') update(session, { ...previous, phase });
      } else if (phase === 'ready' && typeof frames === 'number' && Number.isInteger(frames) && frames > 0 && frames <= 480_000) {
        if (AppState.currentState === 'active') update(session, { ...previous, phase, frames });
        else discard();
      } else if ((phase === 'playing' || phase === 'playback_finished') && 'frames' in previous) {
        update(session, { ...previous, phase: phase === 'playing' ? 'playing' : 'ready' });
      } else {
        discard();
        if (issues[phase]) setError(issues[phase]);
      }
    });
    const visibility = AppState.addEventListener('change', (next) => {
      if (next !== 'active' && current.current?.state.phase !== 'permission') discard();
    });
    const checks = setInterval(() => {
      const session = current.current;
      if (session && session.state.phase !== 'permission') void verifyCurrentProject(session);
    }, 3_000);
    return () => {
      subscription.remove();
      visibility.remove();
      clearInterval(checks);
      discard(false);
    };
  }, [available, discard, native, update, verifyCurrentProject]);

  async function start() {
    if (!available || !native || !project || current.current || AppState.currentState !== 'active') return;
    const session: Session = { state: { id: randomUUID(), project, phase: 'permission' }, request: new AbortController() };
    current.current = session;
    setState(session.state);
    setError('');
    try {
      const allowed = await PermissionsAndroid.check(microphone)
        || await PermissionsAndroid.request(microphone) === PermissionsAndroid.RESULTS.GRANTED;
      if (current.current !== session) return;
      if (!allowed) { discard(); setError(issues.permission); return; }
      await waitForForeground(session.request.signal);
      if (!update(session, { id: session.state.id, project, phase: 'starting' })) return;
      if (!await verifyCurrentProject(session)) return;
      const problem = await native.start(session.state.id);
      if (problem && current.current === session) { discard(); setError(issues[problem] ?? issues.unavailable); }
    } catch {
      if (current.current === session) { discard(); setError(issues.unavailable); }
    }
  }

  function finish() {
    const session = current.current;
    if (!native || session?.state.phase !== 'recording') return;
    update(session, { ...session.state, phase: 'finishing' });
    void native.finish(session.state.id).catch(() => {
      if (current.current === session) { discard(); setError(issues.unavailable); }
    });
  }

  function togglePlayback() {
    const session = current.current;
    if (!native || !session || (session.state.phase !== 'ready' && session.state.phase !== 'playing')) return;
    if (session.state.phase === 'playing') { void native.stopPlayback(session.state.id).catch(() => undefined); return; }
    const unavailable = () => { if (current.current === session) setError('暂时无法试听。'); };
    void native.play(session.state.id).then((ok) => { if (!ok) unavailable(); }, unavailable);
  }

  async function readClip(id: string, signal: AbortSignal) {
    const session = current.current;
    if (!native || session?.state.id !== id || session.state.phase !== 'ready' || signal.aborted) throw new Error('Recording unavailable');
    const { frames } = session.state;
    const bytes = await native.copyClip(id);
    if (!bytes || signal.aborted || current.current !== session) throw new Error('Recording unavailable');
    const layout = inspectWave(bytes, true);
    if (layout.frames !== frames || layout.sampleRate !== 16_000 || layout.channels !== 1) throw new Error('Invalid recorded WAV');
    return new BinaryUpload(bytes, waveMime);
  }

  function ready(id: string) { return current.current?.state.id === id && current.current.state.phase === 'ready'; }

  return { available, state, error, start, finish, togglePlayback, discard, ready, readClip };
}
