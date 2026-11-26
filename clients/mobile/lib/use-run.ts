import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { AssistantApiError, type AssistantClient, type components } from '../../../packages/contracts/dist/index.js';
import { isActive, type Run } from './assistant';

const retryDelays = [400, 1000, 2000, 4000];

function applyEvent(run: Run, event: components['schemas']['RunEvent']): Run {
  const next = { ...run, lastSequence: event.sequence };
  switch (event.type) {
    case 'run.started': return { ...next, state: 'running' };
    case 'message.delta': return { ...next, content: next.content + event.delta };
    case 'run.completed': return { ...next, state: 'completed', messageId: event.messageId };
    case 'run.cancelled': return { ...next, state: 'cancelled' };
    case 'run.failed': return { ...next, state: 'failed', error: event.error };
  }
}

function sleep(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return; }
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export function useRun(client: AssistantClient, onFinished: (run: Run) => void, onUnauthorized: () => void,
  onUnavailable: (conversationId: string, locked: boolean) => void) {
  const [run, setRun] = useState<Run | null>(null);
  const [paused, setPaused] = useState(false);
  const state = useRef<Run | null>(null);
  const stream = useRef<AbortController | null>(null);
  const paint = useRef<ReturnType<typeof requestAnimationFrame> | null>(null);
  const callbacks = useRef({ onFinished, onUnauthorized, onUnavailable });
  callbacks.current = { onFinished, onUnauthorized, onUnavailable };

  const cancelPaint = useCallback(() => {
    if (paint.current !== null) cancelAnimationFrame(paint.current);
    paint.current = null;
  }, []);

  const publish = useCallback((snapshot: Run, deferText = false) => {
    // Keep the replay cursor current even when several text fragments share one display update.
    state.current = snapshot;
    if (!deferText) {
      cancelPaint();
      setRun(snapshot);
    } else if (paint.current === null) {
      paint.current = requestAnimationFrame(() => {
        paint.current = null;
        setRun(state.current);
      });
    }
  }, [cancelPaint]);

  const reset = useCallback(() => {
    stream.current?.abort();
    stream.current = null;
    state.current = null;
    cancelPaint();
    setRun(null);
    setPaused(false);
  }, [cancelPaint]);

  const discardConversation = useCallback((id: string) => {
    if (state.current?.conversationId === id) reset();
  }, [reset]);

  const observe = useCallback((initial: Run, reconnect = false) => {
    const current = state.current;
    if (current?.runId === initial.runId && current.lastSequence > initial.lastSequence) return;
    stream.current?.abort();
    const scope = new AbortController();
    stream.current = scope;
    publish(initial);
    setPaused(reconnect);
    if (!isActive(initial) || AppState.currentState === 'background') return;

    void (async () => {
      let attempt = 0;
      let snapshot = initial;
      let readSnapshot = reconnect;
      while (!scope.signal.aborted && isActive(snapshot)) {
        try {
          if (readSnapshot) {
            snapshot = await client.getRunSnapshot(initial.runId);
            if (scope.signal.aborted) return;
            publish(snapshot);
            if (!isActive(snapshot)) {
              setPaused(false);
              callbacks.current.onFinished(snapshot);
              return;
            }
          }
          for await (const event of client.openRunEvents(initial.runId, {
            afterSequence: snapshot.lastSequence,
            signal: scope.signal,
          })) {
            if (scope.signal.aborted) return;
            snapshot = applyEvent(snapshot, event);
            publish(snapshot, event.type === 'message.delta');
            if (readSnapshot) {
              readSnapshot = false;
              setPaused(false);
            }
            attempt = 0;
            if (!isActive(snapshot)) {
              callbacks.current.onFinished(snapshot);
              return;
            }
          }
        } catch (error) {
          if (scope.signal.aborted) return;
          if (error instanceof AssistantApiError && error.status === 401) {
            callbacks.current.onUnauthorized();
            return;
          }
          if (error instanceof AssistantApiError && (error.status === 403 || error.status === 404 || error.status === 423)) {
            reset();
            callbacks.current.onUnavailable(initial.conversationId, error.status === 423);
            return;
          }
        }
        readSnapshot = true;
        setPaused(true);
        const wait = retryDelays[Math.min(attempt, retryDelays.length - 1)];
        attempt += 1;
        await sleep(wait, scope.signal);
      }
    })();
  }, [client, publish, reset]);

  useEffect(() => {
    const listener = AppState.addEventListener('change', (next) => {
      if (next !== 'active') {
        stream.current?.abort();
        cancelPaint();
      }
      else if (state.current && isActive(state.current)) observe(state.current, true);
    });
    return () => {
      listener.remove();
      stream.current?.abort();
      cancelPaint();
    };
  }, [cancelPaint, observe]);

  return { run, paused, observe, discardConversation };
}
