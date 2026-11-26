import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:18080');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
  throw new Error('Use an isolated local test server.');
}
const prefix = '/api/assistant/v1';
const password = `R-a${randomUUID()}`;
const sessions = [];
const terminal = new Set(['completed', 'cancelled', 'failed']);

function runRoute(id) {
  return `/runs/${encodeURIComponent(id)}`;
}

async function send(path, { method = 'GET', token, body, headers = {}, timeout = 10_000 } = {}) {
  const requestHeaders = { Accept: 'application/json', ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;
  if (body) requestHeaders['Content-Type'] = 'application/json';
  return fetch(new URL(prefix + path, base), {
    method,
    headers: requestHeaders,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeout),
    redirect: 'error',
  });
}

async function request(path, status, options) {
  const response = await send(path, options);
  assert.equal(response.status, status, `${options?.method ?? 'GET'} ${path}`);
  return status === 204 ? undefined : response.json();
}

async function register() {
  const input = { username: `qa-run-${randomUUID().slice(0, 12)}`, password };
  const session = await request('/auth/register', 201, { method: 'POST', body: input });
  sessions.push(session.accessToken);
  return { input, ...session };
}

async function newConversation(token) {
  return request('/conversations', 201, { method: 'POST', body: { title: 'QA run' }, token });
}

async function startRun(conversationId, token, body, key = randomUUID(), status = 202) {
  return request(`/conversations/${conversationId}/runs`, status, {
    method: 'POST', body, token, headers: { 'Idempotency-Key': key },
  });
}

async function awaitTerminal(runId, token) {
  const deadline = Date.now() + 20_000;
  do {
    const snapshot = await request(runRoute(runId), 200, { token });
    if (terminal.has(snapshot.state)) return snapshot;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail('Run did not reach a terminal state.');
}

function parseFrame(frame, runId) {
  const fields = frame.split(/\r?\n/);
  const data = fields.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart());
  if (data.length === 0) return undefined;
  const event = JSON.parse(data.join('\n'));
  assert.equal(event.runId, runId);
  assert.equal(fields.find((line) => line.startsWith('id:'))?.slice(3).trim(), String(event.sequence));
  assert.equal(fields.find((line) => line.startsWith('event:'))?.slice(6).trim(), event.type);
  return event;
}

async function readEvents(runId, token, { after = 0, limit = Infinity, onEvent } = {}) {
  const headers = { Accept: 'text/event-stream' };
  if (after) headers['Last-Event-ID'] = String(after);
  const response = await send(runRoute(runId) + '/events', { token, headers, timeout: 19_000 });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/i);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const events = [];
  let buffer = '';
  try {
    while (events.length < limit) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let boundary = /\r?\n\r?\n/.exec(buffer);
      while (boundary && events.length < limit) {
        const event = parseFrame(buffer.slice(0, boundary.index), runId);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (event) {
          assert.equal(event.sequence, after + events.length + 1);
          events.push(event);
          if (onEvent) await onEvent(event);
        }
        boundary = /\r?\n\r?\n/.exec(buffer);
      }
      if (chunk.done) {
        assert.equal(buffer, '', 'Stream ended with an incomplete frame.');
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return events;
}

const action = (content, parentId) => ({ action: 'send', content, parentId, modelId: 'local-echo' });
const terminalEvents = (events) => events.filter(({ type }) => type.startsWith('run.') && terminal.has(type.slice(4)));

async function checkExpiredCursor(owner, conversationId) {
  const prompt = '繁體續傳🌤️'.repeat(24);
  const queued = await startRun(conversationId, owner.accessToken, action(prompt));
  const snapshot = await awaitTerminal(queued.runId, owner.accessToken);
  assert.equal(snapshot.state, 'completed');
  assert.ok(snapshot.content.endsWith(prompt), 'Snapshot lost text while retaining fewer events.');
  assert.ok(snapshot.lastSequence > 3);
  const error = await request(runRoute(queued.runId) + '/events', 410, {
    token: owner.accessToken, headers: { Accept: 'text/event-stream', 'Last-Event-ID': '0' },
  });
  assert.equal(error.code, 'CURSOR_EXPIRED');
  assert.equal((await readEvents(queued.runId, owner.accessToken, { after: snapshot.lastSequence - 1 }))[0].type,
    'run.completed');
  assert.deepEqual(await readEvents(queued.runId, owner.accessToken, { after: snapshot.lastSequence }), []);
}

async function checkBranching(owner, secondToken, conversationId, original, prompt) {
  const token = owner.accessToken;
  const path = `/conversations/${conversationId}/messages?limit=100`;
  const firstHistory = await request(path, 200, { token });
  assert.equal(firstHistory.items.length, 2, 'An identical request must not duplicate the prompt or answer.');
  const originalUser = firstHistory.items.find((message) => message.role === 'user' && message.content === prompt);
  assert.ok(originalUser);
  assert.equal(firstHistory.items.find((message) => message.id === original.messageId)?.parentId, originalUser.id);

  const edits = ['设备一修改', '裝置二修改'];
  const edited = await Promise.all(edits.map((content, index) => startRun(conversationId,
    index === 0 ? token : secondToken, {
      action: 'edit', messageId: originalUser.id, content, modelId: 'local-echo',
    })));
  const regenerated = await startRun(conversationId, secondToken, {
    action: 'regenerate', messageId: original.messageId, modelId: 'local-echo',
  });
  const [first, second, retry] = await Promise.all([...edited, regenerated]
    .map(({ runId }) => awaitTerminal(runId, token)));
  for (const result of [first, second, retry]) assert.equal(result.state, 'completed');
  assert.ok(first.content.endsWith(edits[0]));
  assert.ok(second.content.endsWith(edits[1]));
  assert.equal(retry.content, original.content);
  assert.equal(new Set([original.messageId, first.messageId, second.messageId, retry.messageId]).size, 4);

  const history = (await request(path, 200, { token })).items;
  const byId = new Map(history.map((message) => [message.id, message]));
  assert.equal(byId.get(originalUser.id)?.content, prompt);
  assert.equal(byId.get(original.messageId)?.parentId, originalUser.id);
  assert.equal(byId.get(retry.messageId)?.parentId, originalUser.id);
  for (const [index, result] of [first, second].entries()) {
    const edit = byId.get(byId.get(result.messageId)?.parentId);
    assert.ok(edit && edit.id !== originalUser.id);
    assert.equal(edit.content, edits[index]);
    assert.equal(edit.parentId, originalUser.parentId);
  }

  const continuation = await startRun(conversationId, token, action('沿原分支继续', original.messageId));
  const continued = await awaitTerminal(continuation.runId, token);
  assert.equal(continued.state, 'completed');
  const updated = (await request(path, 200, { token })).items;
  const reply = updated.find(({ id }) => id === continued.messageId);
  assert.equal(updated.find(({ id }) => id === reply?.parentId)?.parentId, original.messageId);
}

async function observeActiveRun(runId, token) {
  const events = await readEvents(runId, token, { limit: 2 });
  assert.deepEqual(events.map(({ type }) => type), ['run.started', 'message.delta']);
  const snapshot = await request(runRoute(runId), 200, { token });
  assert.equal(snapshot.state, 'running', 'Set assistant.models.mock-delay-millis to 20–100 for active run checks.');
}

async function checkActiveCancellationAndRetry(conversationId, token, secondToken) {
  const prompt = '用于停止后重试'.repeat(80);
  const { runId } = await startRun(conversationId, token, action(prompt));
  const cancelRoute = runRoute(runId) + '/cancel';
  await observeActiveRun(runId, token);
  const cancelled = await request(cancelRoute, 200, { method: 'POST', token: secondToken });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.messageId, undefined);
  const events = await readEvents(runId, token);
  assert.deepEqual(terminalEvents(events).map(({ type }) => type), ['run.cancelled']);
  assert.equal(events.at(-1).sequence, cancelled.lastSequence);
  assert.equal(events.filter(({ type }) => type === 'message.delta').map(({ delta }) => delta).join(''),
    cancelled.content);

  const history = `/conversations/${conversationId}/messages`;
  const beforeRetry = (await request(history, 200, { token })).items;
  assert.equal(beforeRetry.length, 1);
  const [priorPrompt] = beforeRetry;
  assert.equal(priorPrompt.role, 'user');
  assert.equal(priorPrompt.content, prompt);

  const command = { action: 'regenerate', messageId: priorPrompt.id, modelId: 'local-echo' };
  const key = randomUUID();
  const retry = await startRun(conversationId, secondToken, command, key);
  assert.notEqual(retry.runId, runId);
  const completed = await awaitTerminal(retry.runId, token);
  assert.equal(completed.state, 'completed');
  assert.ok(completed.content.endsWith(prompt));
  assert.deepEqual(await startRun(conversationId, token, command, key), completed);
  assert.deepEqual(await request(cancelRoute, 200, { method: 'POST', token }), cancelled);
  const afterRetry = (await request(history, 200, { token })).items;
  assert.equal(afterRetry.length, 2);
  assert.deepEqual(afterRetry.find(({ id }) => id === priorPrompt.id), priorPrompt);
  assert.equal(afterRetry.find(({ id }) => id === completed.messageId)?.parentId, priorPrompt.id);
}

async function checkCancellationRace(token, secondToken) {
  const conversation = await newConversation(token);
  const prompt = '停止与模型完成竞态'.repeat(28);
  const { runId } = await startRun(conversation.id, token, action(prompt));
  const cancelRoute = runRoute(runId) + '/cancel';
  const stop = (accessToken) => request(cancelRoute, 200, { method: 'POST', token: accessToken });
  let content = '';
  let outcomes;
  const events = await readEvents(runId, token, {
    onEvent: async ({ type, delta }) => {
      if (type !== 'message.delta') return;
      content += delta;
      if (content.endsWith(prompt)) {
        outcomes = await Promise.all([stop(token), stop(secondToken)]);
      }
    },
  });
  assert.ok(outcomes, 'Cancellation must be submitted after the final provider fragment.');
  const final = await awaitTerminal(runId, token);
  assert.ok(['cancelled', 'completed'].includes(final.state));
  assert.deepEqual(outcomes, [final, final]);
  assert.deepEqual(terminalEvents(events).map(({ type }) => type), [`run.${final.state}`]);
  assert.equal(events.at(-1).sequence, final.lastSequence);
}

async function checkActiveDeletion(token, secondToken) {
  const conversation = await newConversation(token);
  const conversationRoute = `/conversations/${conversation.id}`;
  const prompt = '生成中删除会话'.repeat(80);
  const { runId } = await startRun(conversation.id, token, action(prompt));
  await observeActiveRun(runId, token);
  await request(conversationRoute, 204, { method: 'DELETE', token: secondToken });
  for (const route of [conversationRoute, `${conversationRoute}/messages`, runRoute(runId)]) {
    assert.equal((await request(route, 404, { token })).code, 'NOT_FOUND');
  }
  assert.equal((await request(runRoute(runId) + '/cancel', 404, {
    method: 'POST', token,
  })).code, 'NOT_FOUND');
  assert.equal((await request(runRoute(runId) + '/events', 404, {
    token, headers: { Accept: 'text/event-stream', 'Last-Event-ID': '2' },
  })).code, 'NOT_FOUND');
}

async function checkStandardDelivery(owner, conversationId) {
  const token = owner.accessToken;
  const other = await register();
  const second = await request('/auth/login', 200, { method: 'POST', body: owner.input });
  sessions.push(second.accessToken);
  const prompt = '测试 SSE，繁體重連 🐦\n' + '重复片段'.repeat(22);
  const key = randomUUID();
  const body = action(prompt);
  const [initial, same] = await Promise.all([
    startRun(conversationId, token, body, key),
    startRun(conversationId, second.accessToken, body, key),
  ]);
  assert.equal(initial.runId, same.runId, 'Simultaneous identical requests must share one run.');
  assert.equal(initial.conversationId, conversationId);
  assert.equal((await startRun(conversationId, token, action('不同输入'), key, 409)).code, 'CONFLICT');
  const another = await newConversation(token);
  assert.equal((await startRun(another.id, token, body, key, 409)).code, 'CONFLICT');

  const runId = initial.runId;
  const route = runRoute(runId);
  assert.equal((await request(route, 404, { token: other.accessToken })).code, 'NOT_FOUND');
  assert.equal((await request(route + '/cancel', 404, {
    method: 'POST', token: other.accessToken,
  })).code, 'NOT_FOUND');
  assert.equal((await request(route + '/events', 404, {
    token: other.accessToken, headers: { Accept: 'text/event-stream' },
  })).code, 'NOT_FOUND');
  assert.equal((await request(route + '/events', 403, {
    token, headers: { Accept: 'text/event-stream', 'X-Workspace-Id': other.user.workspaceId },
  })).code, 'FORBIDDEN');
  assert.equal((await request(route + '/events', 400, {
    token, headers: { Accept: 'text/event-stream', 'Last-Event-ID': '1.5' },
  })).code, 'VALIDATION_ERROR');

  const head = await readEvents(runId, token, { limit: 1 });
  assert.equal(head.length, 1);
  assert.equal(head[0].type, 'run.started');
  const tail = await readEvents(runId, second.accessToken, { after: head[0].sequence });
  const all = [...head, ...tail];
  const snapshot = await awaitTerminal(runId, token);
  assert.equal(snapshot.state, 'completed');
  assert.ok(snapshot.content.endsWith(prompt));
  assert.equal(all.at(-1)?.type, 'run.completed');
  assert.equal(all.at(-1)?.messageId, snapshot.messageId);
  assert.equal(all.length, snapshot.lastSequence);
  assert.equal(all.filter(({ type }) => type === 'message.delta').map(({ delta }) => delta).join(''),
    snapshot.content);
  assert.deepEqual(await readEvents(runId, token, { after: snapshot.lastSequence }), []);
  const sameAfterCompletion = await startRun(conversationId, token, body, key);
  assert.deepEqual(sameAfterCompletion, snapshot);

  await checkBranching(owner, second.accessToken, conversationId, snapshot, prompt);

  await checkActiveCancellationAndRetry(another.id, token, second.accessToken);
  await checkCancellationRace(token, second.accessToken);
  await checkActiveDeletion(token, second.accessToken);

  if (process.env.ASSISTANT_QA_EXPECT_SESSION_REVOCATION === 'true') {
    await checkSessionRevocation(owner, second.accessToken, conversationId, snapshot.messageId);
  }
}

async function checkSessionRevocation(owner, secondToken, conversationId, parentId) {
  const prompt = '权限撤销后服务器继续生成'.repeat(42);
  const { runId } = await startRun(conversationId, owner.accessToken, action(prompt, parentId));
  const received = await readEvents(runId, secondToken, {
    onEvent: async ({ type, sequence }) => {
      if (sequence === 1) {
        assert.equal(type, 'run.started');
        await request('/auth/logout', 204, { method: 'POST', token: secondToken });
      }
    },
  });
  assert.ok(received.length > 0, 'The second device must receive an event before its session is revoked.');
  assert.ok(!received.some(({ type }) => type === 'run.completed'),
    'The event stream remained authorized after logout. Configure a nonzero mock delay for this check.');
  assert.equal((await request(runRoute(runId) + '/events', 401, {
    token: secondToken,
    headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(received.at(-1).sequence) },
  })).code, 'UNAUTHENTICATED');
  const snapshot = await awaitTerminal(runId, owner.accessToken);
  assert.equal(snapshot.state, 'completed');
  assert.ok(snapshot.content.endsWith(prompt));
  assert.equal((await readEvents(runId, owner.accessToken, { after: received.at(-1).sequence })).at(-1).type,
    'run.completed');
}

try {
  const owner = await register();
  const conversation = await newConversation(owner.accessToken);
  const checkExpiry = process.env.ASSISTANT_QA_EXPECT_EXPIRED_CURSOR === 'true';
  if (checkExpiry) {
    await checkExpiredCursor(owner, conversation.id);
  } else {
    await checkStandardDelivery(owner, conversation.id);
  }
  console.log(JSON.stringify({ suite: checkExpiry ? 'assistant-run-expired-cursor' : 'assistant-run', status: 'passed' }));
} finally {
  await Promise.allSettled(sessions.map((token) => request('/auth/logout', 204, { method: 'POST', token })));
}
