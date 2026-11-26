import { randomUUID } from 'expo-crypto';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AppState, type ViewToken } from 'react-native';
import { localReadAloud, type LocalSpeechLanguage, type SpeechAvailability } from '../modules/local-read-aloud';
import type { Message } from './assistant';

type Playback = { id: string; messageId: string; text: string; scope: string; started: boolean };
const unavailable: SpeechAvailability = { languages: [], maxInputLength: 0 };
export const readAloudViewability = { itemVisiblePercentThreshold: 1 };

function languageOf(text: string): LocalSpeechLanguage | undefined {
  if (/[\u3040-\u30ff\uac00-\ud7af]/.test(text)) return;
  const han = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  const latin = text.match(/[a-z]/gi)?.length ?? 0;
  if (han > 0 && han >= latin) return 'zh';
  if (latin > 0) return 'en';
}

export function useReadAloud(messages: Message[], scope: string, enabled: boolean, pendingMessageId?: string) {
  const [availability, setAvailability] = useState(unavailable);
  const [playback, setPlayback] = useState<Playback>();
  const [error, setError] = useState('');
  const current = useRef<Playback | undefined>(undefined);
  const viewable = useRef(new Set<string>());

  const stop = useCallback((update = true) => {
    const request = current.current;
    current.current = undefined;
    if (update) setPlayback(undefined);
    if (request) void localReadAloud?.stop(request.id).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!localReadAloud) return;
    const native = localReadAloud;
    let mounted = true;
    const updateAvailability = (next: SpeechAvailability) => { if (mounted) setAvailability(next); };
    const refresh = () => void native.getAvailability().then(updateAvailability, () => updateAvailability(unavailable));
    const speechSubscription = native.addListener('onPlayback', ({ id, phase }) => {
      const request = current.current;
      if (request?.id !== id) return;
      if (phase === 'started') {
        current.current = { ...request, started: true };
        setPlayback(current.current);
      } else {
        current.current = undefined;
        setPlayback(undefined);
        if (phase === 'failed') setError('本机朗读中断。仍可查看文字回复。');
      }
    });
    const voiceSubscription = native.addListener('onAvailability', updateAvailability);
    const appSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
      else stop();
    });
    refresh();
    return () => {
      mounted = false;
      stop(false);
      speechSubscription.remove();
      voiceSubscription.remove();
      appSubscription.remove();
    };
  }, [stop]);

  useLayoutEffect(() => {
    const request = current.current;
    if (request && (!enabled || request.scope !== scope || request.messageId === pendingMessageId ||
      !messages.some((message) => message.id === request.messageId && message.content === request.text))) stop();
  }, [enabled, messages, pendingMessageId, scope, stop]);

  useLayoutEffect(() => { setError(''); }, [scope]);

  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: ViewToken<Message>[] }) => {
    viewable.current = new Set(viewableItems.filter(({ isViewable }) => isViewable).map(({ item }) => item.id));
    if (current.current && !viewable.current.has(current.current.messageId)) stop();
  }, [stop]);

  const canRead = useCallback((message: Message) => {
    if (!enabled || message.role !== 'assistant' || message.id === pendingMessageId ||
      message.content.length > availability.maxInputLength) return false;
    const language = languageOf(message.content);
    return language !== undefined && availability.languages.includes(language);
  }, [availability, enabled, pendingMessageId]);

  const toggle = useCallback((message: Message) => {
    if (current.current?.messageId === message.id) { stop(); return; }
    const native = localReadAloud;
    if (!native || !canRead(message) || AppState.currentState !== 'active' || !viewable.current.has(message.id)) return;
    const language = languageOf(message.content);
    if (!language) return;
    stop();
    const request = { id: randomUUID(), messageId: message.id, text: message.content, scope, started: false };
    current.current = request;
    setPlayback(request);
    setError('');
    const failed = () => {
      if (current.current?.id !== request.id) return;
      stop();
      setError('当前设备无法本机朗读。仍可查看文字回复。');
    };
    void native.speak(request.id, request.text, language).then((accepted) => { if (!accepted) failed(); }, failed);
  }, [canRead, scope, stop]);

  return { canRead, toggle, stop, playback, error, onViewableItemsChanged };
}
