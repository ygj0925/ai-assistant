import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, PermissionsAndroid } from 'react-native';
import { localDictation } from '../modules/local-dictation';

type State = { id: string; scope: string; phase: 'permission' | 'starting' | 'listening' | 'finishing'; partial: string };
const microphone = PermissionsAndroid.PERMISSIONS.RECORD_AUDIO;
const permissionMessage = '麦克风权限未授予。可以继续输入文字。';
const unavailableMessage = '当前设备的本机听写不可用。可以继续输入文字。';

export function useLocalDictation(scope: string, enabled: boolean, onResult: (text: string) => void) {
  const current = useRef<State | undefined>(undefined);
  const result = useRef(onResult);
  const [language, setLanguage] = useState<string | null>(null);
  const [session, setSession] = useState<State>();
  const [error, setError] = useState('');

  const update = useCallback((next?: State) => {
    current.current = next;
    setSession(next);
  }, []);

  const cancel = useCallback((updateUi = true) => {
    const request = current.current;
    current.current = undefined;
    if (updateUi) setSession(undefined);
    if (request && request.phase !== 'permission') void localDictation?.cancel(request.id).catch(() => undefined);
  }, []);

  useLayoutEffect(() => { result.current = onResult; }, [onResult]);

  useLayoutEffect(() => {
    const request = current.current;
    if (request && (!enabled || request.scope !== scope)) cancel();
  }, [cancel, enabled, scope]);

  useLayoutEffect(() => { setError(''); }, [scope]);

  useEffect(() => {
    const native = localDictation;
    if (!native) return;
    let version = 0;
    const refresh = () => {
      const requested = ++version;
      void native.getLanguage().then((locale) => { if (requested === version) setLanguage(locale); },
        () => { if (requested === version) setLanguage(null); });
    };
    const subscription = native.addListener('onDictation', ({ id, phase, text }) => {
      const request = current.current;
      if (request?.id !== id) return;
      if (phase === 'listening' || phase === 'finishing') {
        update({ ...request, phase });
      } else if (phase === 'partial') {
        update({ ...request, partial: text ?? '' });
      } else {
        update();
        if (phase === 'result' && text && AppState.currentState === 'active') result.current(text);
        if (phase === 'permission') setError(permissionMessage);
        if (phase === 'unavailable') { setLanguage(null); setError(unavailableMessage); }
        if (phase === 'failed') setError('没有完成本机听写。可以重试或输入文字。');
      }
    });
    const app = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
      else if (current.current?.phase !== 'permission') cancel();
    });
    refresh();
    return () => {
      version++;
      cancel(false);
      subscription.remove();
      app.remove();
    };
  }, [cancel, update]);

  const start = useCallback(async () => {
    const native = localDictation;
    if (!native || !language || !enabled || current.current || AppState.currentState !== 'active') return;
    const request: State = { id: randomUUID(), scope, phase: 'permission', partial: '' };
    update(request);
    setError('');
    const stillRequested = () => current.current?.id === request.id;
    try {
      const allowed = await PermissionsAndroid.check(microphone) ||
        await PermissionsAndroid.request(microphone) === PermissionsAndroid.RESULTS.GRANTED;
      if (!stillRequested()) return;
      if (!allowed) { update(); setError(permissionMessage); return; }
      if (AppState.currentState !== 'active') {
        update();
        setError('麦克风已授权。请再次点按本机听写。');
        return;
      }
      update({ ...request, phase: 'starting' });
      if (!(await native.start(request.id, language)) && stillRequested()) {
        update();
        setError(unavailableMessage);
      }
    } catch {
      if (stillRequested()) { cancel(); setError(unavailableMessage); }
    }
  }, [cancel, enabled, language, scope, update]);

  const finish = useCallback(() => {
    const request = current.current;
    if (request?.phase !== 'listening') return;
    update({ ...request, phase: 'finishing' });
    void localDictation?.finish(request.id).catch(() => {
      if (current.current?.id === request.id) { cancel(); setError(unavailableMessage); }
    });
  }, [cancel, update]);

  return { available: enabled && !!language, session, error, start, finish, cancel };
}
