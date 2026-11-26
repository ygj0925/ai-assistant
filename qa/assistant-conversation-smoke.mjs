import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:18080');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
  throw new Error('Use an isolated local test server.');
}
const prefix = '/api/assistant/v1';
const serial = randomUUID().slice(0, 12);
const password = `C-a${randomUUID()}`;

async function request(path, status, { method = 'GET', token, body, workspace, query } = {}) {
  const url = new URL(prefix + path, base);
  if (query) url.search = new URLSearchParams(query).toString();
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  if (workspace) headers['X-Workspace-Id'] = workspace;
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  assert.equal(response.status, status, `${method} ${path}`);
  return status === 204 ? undefined : response.json();
}

async function register(suffix) {
  return request('/auth/register', 201, {
    method: 'POST',
    body: { username: `qa-c-${serial}-${suffix}`, password },
  });
}

const owner = await register('a');
const other = await register('b');
const token = owner.accessToken;
const catalog = (query = {}) => request('/conversations', 200, { token, query });
const create = (title) => request('/conversations', 201, { method: 'POST', token, body: { title } });
const route = (id) => `/conversations/${id}`;

assert.equal((await request('/conversations', 401)).code, 'UNAUTHENTICATED');
const simplified = await create(`${serial} 简体聊天`);
const traditional = await create(`${serial} 繁體會話`);
const english = await create(`${serial} ContiNew Report 100%`);
for (const item of [simplified, traditional, english]) {
  assert.equal(item.pinned, false);
  assert.equal(item.archived, false);
  assert.ok(Number.isFinite(Date.parse(item.updatedAt)));
  assert.equal((await request(route(item.id), 200, { token })).title, item.title);
}

for (const [q, id] of [['简体', simplified.id], ['繁體', traditional.id], ['continew', english.id],
  ['100%', english.id]]) {
  const result = await catalog({ q });
  assert.deepEqual(result.items.map((item) => item.id), [id], `search ${q}`);
  assert.equal(result.nextCursor, null);
}
assert.equal((await catalog({ q: '100_' })).items.length, 0);
assert.equal((await request('/conversations', 400, {
  token, query: { cursor: 'broken(cursor)' },
})).code, 'VALIDATION_ERROR');
assert.equal((await request('/conversations', 400, {
  token, query: { limit: '101' },
})).code, 'VALIDATION_ERROR');

const renamed = await request(route(simplified.id), 200, {
  method: 'PATCH',
  token,
  body: { pinned: true, title: `${serial} 更新后的简体聊天` },
});
assert.equal(renamed.pinned, true);
assert.match(renamed.title, /更新后/);
assert.equal((await catalog({ q: '更新后' })).items[0].id, simplified.id);
const pagedIds = [];
let nextCursor;
for (let page = 0; page < 3; page += 1) {
  const result = await catalog(nextCursor ? { limit: '1', cursor: nextCursor } : { limit: '1' });
  assert.equal(result.items.length, 1);
  pagedIds.push(result.items[0].id);
  nextCursor = result.nextCursor;
  assert.equal(typeof nextCursor, page < 2 ? 'string' : 'object');
}
assert.equal(pagedIds[0], simplified.id);
assert.deepEqual(new Set(pagedIds), new Set([simplified.id, traditional.id, english.id]));
assert.equal(nextCursor, null);

await request(route(traditional.id), 200, { method: 'PATCH', token, body: { archived: true } });
assert.deepEqual((await catalog({ archived: 'true' })).items.map((item) => item.id), [traditional.id]);
assert.equal((await catalog({ archived: 'false' })).items.length, 2);

const otherToken = other.accessToken;
assert.equal((await request('/conversations', 200, { token: otherToken })).items.length, 0);
assert.equal((await request('/conversations', 403, {
  token: otherToken, workspace: owner.user.workspaceId,
})).code, 'FORBIDDEN');
for (const method of ['GET', 'PATCH', 'DELETE']) {
  const result = await request(route(english.id), 404, {
    method,
    token: otherToken,
    body: method === 'PATCH' ? { pinned: true } : undefined,
  });
  assert.equal(result.code, 'NOT_FOUND');
}

await request(route(english.id), 204, { method: 'DELETE', token });
assert.equal((await request(route(english.id), 404, { token })).code, 'NOT_FOUND');
assert.equal((await catalog({ q: 'ContiNew' })).items.length, 0);

for (const id of [simplified.id, traditional.id]) {
  await request(route(id), 204, { method: 'DELETE', token });
}
for (const accessToken of [token, otherToken]) {
  await request('/auth/logout', 204, { token: accessToken, method: 'POST' });
}
console.log(JSON.stringify({ suite: 'assistant-conversations', status: 'passed' }));
