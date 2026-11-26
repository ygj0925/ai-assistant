import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const prefix = '/api/assistant/v1';

async function send(origin, path, { method = 'GET', token, workspace, body, key,
  accept = 'application/json', lastEventId } = {}) {
  const target = new URL(prefix + path, origin);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname), 'isolated loopback required');
  const headers = { Accept: accept };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (workspace) headers['X-Workspace-Id'] = workspace;
  if (key) headers['Idempotency-Key'] = key;
  if (lastEventId !== undefined) headers['Last-Event-ID'] = String(lastEventId);
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(target, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
}

async function request(origin, path, status, options) {
  const response = await send(origin, path, options);
  assert.equal(response.status, status, `${options?.method ?? 'GET'} ${path}`);
  return status === 204 ? undefined : response.json();
}

async function runEvents(origin, actor, runId, lastEventId, status = 200) {
  const response = await send(origin, `/runs/${runId}/events`, {
    ...actor, accept: 'text/event-stream', lastEventId,
  });
  assert.equal(response.status, status, 'run event HTTP status');
  if (status !== 200) {
    const error = await response.json();
    assert.equal(error.code, status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN');
    return [];
  }
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/i);
  const events = [];
  for (const frame of (await response.text()).split(/\r?\n\r?\n/)) {
    const lines = frame.split(/\r?\n/);
    const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart());
    if (data.length === 0) continue;
    const event = JSON.parse(data.join('\n'));
    assert.equal(event.runId, runId);
    assert.equal(event.sequence, (lastEventId ?? 0) + events.length + 1);
    assert.equal(lines.find((line) => line.startsWith('id:'))?.slice(3).trim(), String(event.sequence));
    events.push(event);
  }
  return events;
}

async function assertIdentity(origin, actor) {
  const user = await request(origin, '/auth/me', 200, { ...actor, workspace: actor.user.workspaceId });
  assert.equal(user.id, actor.user.id);
  assert.equal(user.username, actor.credentials.username);
  assert.equal(user.workspaceId, actor.user.workspaceId);
}

async function erasureCapability(origin, actor) {
  const body = await request(origin, '/capabilities', 200, actor);
  const capability = body.capabilities.find(({ id }) => id === 'account-erasure');
  assert.ok(capability, 'account-erasure capability present');
  return capability;
}

async function register(origin) {
  const credentials = { username: `qa-erase-${randomUUID().slice(0, 12)}`, password: `Qa.Erasure-${randomUUID()}` };
  const session = await request(origin, '/auth/register', 201, { method: 'POST', body: credentials });
  return { credentials, token: session.accessToken, user: session.user };
}

async function conversation(origin, actor, title, content) {
  const chat = await request(origin, '/conversations', 201, { ...actor, method: 'POST', body: { title } });
  const run = await enqueue(origin, actor, chat.id, content);
  const deadline = Date.now() + 19_000;
  do {
    const snapshot = await request(origin, `/runs/${run.runId}`, 200, actor);
    if (snapshot.state === 'completed') {
      assert.equal(snapshot.modelId, 'local-echo');
      assert.equal(snapshot.modelVersion, 'synthetic-v1');
      assert.equal(snapshot.content, `本地模拟回复：${content}`);
      return { id: chat.id, runId: snapshot.runId, content: snapshot.content };
    }
    assert.ok(['queued', 'running'].includes(snapshot.state));
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail('Synthetic reply failed to complete.');
}

function enqueue(origin, actor, chat, content) {
  return request(origin, `/conversations/${chat}/runs`, 202, {
    ...actor, method: 'POST', key: randomUUID(), body: { action: 'send', modelId: 'local-echo', content },
  });
}

// The fixture runner takes a database snapshot after this step while the application is running.
export async function prepareErasureFixture(origin) {
  const guest = await erasureCapability(origin);
  assert.equal(guest.available, false);
  assert.equal(guest.reason, 'SIGN_IN_REQUIRED');
  const owner = await register(origin);
  const observer = await register(origin);
  const otherDevice = await request(origin, '/auth/login', 200, { method: 'POST', body: owner.credentials });
  assert.ok(owner.token !== otherDevice.accessToken, 'two independent fixture sessions');
  assert.notEqual(owner.user.workspaceId, observer.user.workspaceId);
  assert.notEqual(owner.user.id, observer.user.id);
  await assertIdentity(origin, owner);
  await assertIdentity(origin, { ...owner, token: otherDevice.accessToken });
  await assertIdentity(origin, observer);
  for (const actor of [owner, observer]) {
    assert.equal((await erasureCapability(origin, actor)).available, true);
  }
  const foreignWorkspace = { ...owner, workspace: observer.user.workspaceId };
  assert.equal((await request(origin, '/auth/me', 403, foreignWorkspace)).code, 'FORBIDDEN');
  assert.equal((await request(origin, '/privacy/export', 403, foreignWorkspace)).code, 'FORBIDDEN');
  const eraseChat = await conversation(origin, owner, 'Synthetic account to erase', '账户擦除合成证据');
  const hideChat = await conversation(origin, observer, 'Synthetic conversation to delete', '会话恢复合成证据');
  const keepChat = await conversation(origin, observer, 'Synthetic conversation to retain', '未删除合成证据');
  await request(origin, `/runs/${eraseChat.runId}`, 404, observer);
  await request(origin, `/runs/${keepChat.runId}`, 404, owner);
  await runEvents(origin, foreignWorkspace, eraseChat.runId, 0, 403);
  const originalEvents = await runEvents(origin, owner, eraseChat.runId, 0);
  assert.equal(originalEvents[0]?.type, 'run.started');
  assert.equal(originalEvents[1]?.type, 'message.delta');
  assert.equal(originalEvents.at(-1)?.type, 'run.completed');
  assert.equal(originalEvents.filter(({ type }) => type === 'message.delta').map(({ delta }) => delta).join(''),
    eraseChat.content);
  const resumeCursor = originalEvents[1].sequence;
  const resumedEvents = await runEvents(origin, { ...owner, token: otherDevice.accessToken },
    eraseChat.runId, resumeCursor);
  assert.deepEqual(resumedEvents, originalEvents.slice(2), 'second device resumed the exact remaining frames');
  const active = await enqueue(origin, owner, eraseChat.id, '长'.repeat(1200));
  assert.ok(['queued', 'running'].includes(active.state));
  return { owner, observer, otherDevice, eraseChat, hideChat, keepChat, active, resumeCursor };
}

export async function eraseFixture(origin, fixture) {
  const { owner, observer, eraseChat, hideChat } = fixture;
  const endpoint = '/privacy/account-erasure';
  const credentials = { currentPassword: owner.credentials.password, confirmation: 'DELETE' };
  await request(origin, endpoint, 400, { ...owner, method: 'POST', body: { ...credentials, confirmation: 'delete' } });
  const passwordError = await request(origin, endpoint, 401, { ...owner, method: 'POST',
    body: { ...credentials, currentPassword: 'IncorrectFixturePassword' } });
  assert.equal(passwordError.code, 'INVALID_CURRENT_PASSWORD');
  await assertIdentity(origin, owner);
  await request(origin, `/conversations/${eraseChat.id}`, 404, { ...observer, method: 'DELETE' });
  await request(origin, `/conversations/${hideChat.id}`, 204, { ...observer, method: 'DELETE' });
  await request(origin, endpoint, 204, { ...owner, method: 'POST', body: credentials });
  await verifyErasure(origin, fixture);
}

// Run again after restoring the pre-deletion snapshot and starting the application with the same independent journal.
export async function verifyErasure(origin, fixture) {
  const { owner, observer, otherDevice, eraseChat, hideChat, keepChat, resumeCursor } = fixture;
  for (const actor of [owner, { token: otherDevice.accessToken }]) {
    await request(origin, '/auth/me', 401, actor);
    await request(origin, '/privacy/export', 401, actor);
    await request(origin, `/runs/${eraseChat.runId}`, 401, actor);
    await runEvents(origin, actor, eraseChat.runId, resumeCursor, 401);
  }
  await request(origin, '/auth/login', 401, { method: 'POST', body: owner.credentials });
  await request(origin, `/conversations/${hideChat.id}`, 404, observer);
  await request(origin, `/conversations/${hideChat.id}/messages`, 404, observer);
  await request(origin, `/runs/${hideChat.runId}`, 404, observer);
  await request(origin, `/conversations/${keepChat.id}`, 200, observer);
  await assertIdentity(origin, observer);
  const visibleRun = await request(origin, `/runs/${keepChat.runId}`, 200, observer);
  assert.equal(visibleRun.modelId, 'local-echo');
  assert.equal(visibleRun.content, keepChat.content);
  const remaining = await request(origin, '/conversations?q=' + encodeURIComponent('会话恢复合成证据'), 200, observer);
  assert.deepEqual(remaining.items, []);
  const exported = await request(origin, '/privacy/export', 200, observer);
  assert.deepEqual(exported.conversations.map(({ id }) => id), [keepChat.id]);
  assert.deepEqual(exported.runs.map(({ id }) => id), [keepChat.runId]);
}

