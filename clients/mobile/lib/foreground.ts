import { AppState } from 'react-native';

export function waitForForeground(signal: AbortSignal) {
  if (AppState.currentState === 'active') return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const subscription = AppState.addEventListener('change', (state) => { if (state === 'active') finish(true); });
    const timeout = setTimeout(() => finish(false), 5_000);
    const cancelled = () => finish(false);
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) finish(false);
    function finish(active: boolean) {
      subscription.remove();
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancelled);
      if (active) resolve();
      else reject(new Error('The document picker did not return to the active app.'));
    }
  });
}
