import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18090');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Use an isolated loopback API.');
const api = '/api/assistant/v1';
const sessions = [];

async function request(path, status, { method = 'GET', token, workspace, body, key } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (workspace) headers['X-Workspace-Id'] = workspace;
  if (key) headers['Idempotency-Key'] = key;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(api + path, origin), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, status, `${method} ${path}`);
  return status === 204 ? undefined : response.json();
}

async function register() {
  const credentials = { username: `qa-proj-${randomUUID().slice(0, 12)}`, password: `Qa.Project-${randomUUID()}` };
  const session = await request('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { token: session.accessToken, workspace: session.user.workspaceId, credentials };
  sessions.push(actor);
  return actor;
}

function createProject(actor, name, description) {
  return request('/projects', 201, { ...actor, method: 'POST', body: { name, description } });
}

function createChat(actor, title, projectId) {
  return request('/conversations', 201, { ...actor, method: 'POST', body: { title, projectId } });
}

function moveChat(actor, conversation, projectId, status = 200) {
  return request(`/conversations/${conversation}/project`, status, {
    ...actor, method: 'PUT', body: { projectId },
  });
}

async function chatIds(actor, filters = {}) {
  return (await request('/conversations?' + new URLSearchParams(filters), 200, actor))
    .items.map(({ id }) => id);
}

async function complete(actor, conversation, content) {
  const { runId } = await request(`/conversations/${conversation}/runs`, 202, {
    ...actor, method: 'POST', key: randomUUID(), body: { action: 'send', modelId: 'local-echo', content },
  });
  const deadline = Date.now() + 18_000;
  do {
    const result = await request(`/runs/${runId}`, 200, actor);
    if (result.state === 'completed') {
      assert.equal(result.content, '本地模拟回复：' + content);
      return result;
    }
    assert.ok(['queued', 'running'].includes(result.state), 'fixture run failed');
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail('fixture generation timed out');
}

try {
  const visitor = await request('/capabilities', 200);
  assert.equal(visitor.capabilities.find(({ id }) => id === 'projects').reason, 'SIGN_IN_REQUIRED');
  await request('/projects', 401);
  const owner = await register();
  const other = await register();
  const capabilities = await request('/capabilities', 200, owner);
  assert.equal(capabilities.capabilities.find(({ id }) => id === 'projects').available, true);

  const alpha = await createProject(owner, '  合成项目甲  ', '第一行\n合成内容🦀');
  const beta = await createProject(owner, '合成项目乙');
  const external = await createProject(other, '合成外部项目', 'limited visibility');
  assert.equal(alpha.name, '合成项目甲');
  assert.equal(alpha.description, '第一行\n合成内容🦀');
  assert.equal(beta.description, '');
  await request('/projects', 400, { ...owner, method: 'POST', body: { name: ' ' } });
  await request('/projects', 400, { ...owner, method: 'POST', body: { name: 'over budget', description: '🦀'.repeat(4001) } });
  await request(`/projects/${alpha.id}`, 404, other);
  await request('/projects', 403, { ...owner, workspace: other.workspace });
  await request(`/projects/${external.id}`, 404, {
    ...owner, method: 'PATCH', body: { description: 'forbidden edit' },
  });

  const first = await request('/projects?limit=1', 200, owner);
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const continuation = '/projects?limit=1&cursor=' + encodeURIComponent(first.nextCursor);
  const second = await request(continuation, 200, owner);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(new Set([...first.items, ...second.items].map(({ id }) => id)), new Set([alpha.id, beta.id]));
  await request(continuation, 400, other);

  const renamed = await request(`/projects/${alpha.id}`, 200, {
    ...owner, method: 'PATCH', body: { name: '甲项目更新' },
  });
  assert.equal(renamed.id, alpha.id);
  assert.equal(renamed.createdAt, alpha.createdAt);
  assert.equal(renamed.description, alpha.description);
  const cleared = await request(`/projects/${alpha.id}`, 200, {
    ...owner, method: 'PATCH', body: { description: '' },
  });
  assert.equal(cleared.name, renamed.name);
  assert.equal(cleared.description, '');

  const legacy = await createChat(owner, '未归类历史会话');
  const chat = await createChat(owner, '测试迁移会话', alpha.id);
  const sibling = await createChat(owner, '同项目独立会话', beta.id);
  assert.equal(legacy.projectId, undefined);
  assert.equal(chat.projectId, alpha.id);
  assert.deepEqual(await chatIds(owner, { projectId: alpha.id }), [chat.id]);
  assert.deepEqual(await chatIds(owner, { unfiled: true }), [legacy.id]);
  assert.deepEqual(new Set(await chatIds(owner)), new Set([legacy.id, chat.id, sibling.id]));
  await request(`/conversations?projectId=${external.id}`, 404, owner);
  await request(`/conversations?projectId=${alpha.id}&unfiled=true`, 400, owner);
  await request('/conversations', 404, { ...owner, method: 'POST', body: { projectId: external.id } });

  const firstRun = await complete(owner, chat.id, '原项目合成分支');
  const siblingRun = await complete(owner, sibling.id, '另一条会话的合成分支');
  const secondLogin = await request('/auth/login', 200, { method: 'POST', body: owner.credentials });
  const otherDevice = { ...owner, token: secondLogin.accessToken };
  sessions.push(otherDevice);
  await moveChat(other, chat.id, external.id, 404);
  await moveChat(owner, chat.id, external.id, 404);
  await request(`/conversations/${chat.id}/project`, 400, { ...owner, method: 'PUT', body: {} });
  const moves = await Promise.all([moveChat(owner, chat.id, beta.id), moveChat(otherDevice, chat.id, beta.id)]);
  assert.deepEqual(moves[0], moves[1]);
  assert.equal(moves[0].id, chat.id);
  assert.equal(moves[0].title, chat.title);
  assert.equal(moves[0].projectId, beta.id);
  assert.deepEqual(await chatIds(owner, { projectId: alpha.id }), []);
  assert.deepEqual(new Set(await chatIds(owner, { projectId: beta.id })), new Set([chat.id, sibling.id]));
  assert.deepEqual(await chatIds(owner, { projectId: beta.id, q: '原项目合成分支' }), [chat.id]);
  assert.equal((await request(`/runs/${firstRun.runId}`, 200, owner)).messageId, firstRun.messageId);
  await request(`/conversations/${chat.id}/runs`, 404, { ...owner, method: 'POST', key: randomUUID(),
    body: { action: 'send', modelId: 'local-echo', content: 'synthetic', parentId: siblingRun.messageId } });
  const followed = await complete(owner, chat.id, '迁移后继续');
  assert.equal(followed.context.turns, 3);

  const unfiled = await moveChat(otherDevice, chat.id, null);
  assert.equal(unfiled.projectId, undefined);
  assert.deepEqual(new Set(await chatIds(owner, { unfiled: true })), new Set([legacy.id, chat.id]));
  assert.deepEqual(await chatIds(owner, { projectId: beta.id }), [sibling.id]);
  const exported = await request('/privacy/export', 200, owner);
  assert.deepEqual(new Set(exported.projects.map(({ id }) => id)), new Set([alpha.id, beta.id]));
  assert.equal(exported.conversations.find(({ id }) => id === sibling.id).projectId, beta.id);
  assert.equal(exported.conversations.find(({ id }) => id === chat.id).projectId, undefined);
  assert.equal(exported.nextCursor, null);
  console.log(JSON.stringify({ privateProjectScope: 'passed', conversationMoveAndUnfile: 'passed',
    branchIsolation: 'passed', ownedProjectExport: 'passed' }));
} finally {
  await Promise.all(sessions.map((actor) => request('/auth/logout', 204, { ...actor, method: 'POST' }).catch(() => {})));
}

