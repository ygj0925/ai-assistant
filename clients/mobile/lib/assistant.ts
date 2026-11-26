import { fetch as expoFetch } from 'expo/fetch';
import * as SecureStore from 'expo-secure-store';
import { AssistantApiError, AssistantClient, type components } from '../../../packages/contracts/dist/index.js';

type Schemas = components['schemas'];
export type Session = Schemas['AccountSession'];
export type Conversation = Schemas['Conversation'];
export type Message = Schemas['Message'];
export type Run = Schemas['RunSnapshot'];
export type RunRequest = Schemas['RunRequest'];
export type Model = Schemas['TextModel'];

export type RunBookmark = { runId: string; conversationId: string; userId: string };

const sessionKey = 'assistant.session.v1';
const bookmarkKey = 'assistant.run.v1';
const storage = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
let bookmarkWrite = Promise.resolve();

function writeBookmark(action: () => Promise<void>) {
  const pending = bookmarkWrite.then(action);
  bookmarkWrite = pending.catch(() => undefined);
  return pending;
}

async function* readStream(response: Response) {
  if (!response.body) throw new Error('回复流不可用');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createClient(): AssistantClient | null {
  try {
    const address = process.env.EXPO_PUBLIC_ASSISTANT_API_ORIGIN || (__DEV__ ? 'http://127.0.0.1:18080' : '');
    const origin = new URL(address);
    if (origin.protocol !== 'https:' && !(__DEV__ && ['127.0.0.1', 'localhost'].includes(origin.hostname))) {
      return null;
    }
    return new AssistantClient({ origin: address, fetch: expoFetch as unknown as typeof fetch, readStream });
  } catch {
    return null;
  }
}

async function read<T>(key: string): Promise<T | null> {
  const saved = await SecureStore.getItemAsync(key, storage);
  if (!saved) return null;
  try {
    return JSON.parse(saved) as T;
  } catch {
    await SecureStore.deleteItemAsync(key, storage);
    return null;
  }
}

export async function readSession() {
  const saved = await read<Session>(sessionKey);
  if (saved && (!saved.accessToken || !saved.user?.id || !(Date.parse(saved.expiresAt) > Date.now()))) {
    await clearLocalSession();
    return null;
  }
  return saved;
}

export function saveSession(session: Session) {
  return SecureStore.setItemAsync(sessionKey, JSON.stringify(session), storage);
}

export async function clearLocalSession() {
  await SecureStore.deleteItemAsync(sessionKey, storage);
  await clearBookmark();
}

export async function readBookmark(userId: string): Promise<RunBookmark | null> {
  await bookmarkWrite;
  const saved = await read<RunBookmark>(bookmarkKey);
  return saved?.userId === userId && saved.runId && saved.conversationId ? saved : null;
}

export function saveBookmark(bookmark: RunBookmark) {
  return writeBookmark(() => SecureStore.setItemAsync(bookmarkKey, JSON.stringify(bookmark), storage));
}

export function clearBookmark(conversationId?: string) {
  return writeBookmark(async () => {
    if (conversationId && (await read<RunBookmark>(bookmarkKey))?.conversationId !== conversationId) return;
    await SecureStore.deleteItemAsync(bookmarkKey, storage);
  });
}

export function isActive(run: Run) {
  return run.state === 'queued' || run.state === 'running';
}

export function messageText(error: unknown) {
  if (error instanceof AssistantApiError) {
    if (error.status === 401) return '登录已失效，请重新登录。';
    if (error.status === 404) return '对话已删除或无权访问。';
    if (error.status === 429) return '请求过于频繁，请稍后再试。';
    if (error.status === 503) return '当前模型暂时不可用。';
    return error.message;
  }
  return '连接失败，请检查网络后重试。';
}

export async function listMessages(client: AssistantClient, conversationId: string) {
  const messages: Message[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listMessages(conversationId, { limit: 100, cursor });
    messages.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return messages;
}
