import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const base = new URL(process.argv[2] ?? 'http://127.0.0.1:18080');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
  throw new Error('Use an isolated local test server.');
}
const prefix = '/api/assistant/v1';
const password = `Q-a${randomUUID()}`;

async function request(path, status, { method = 'GET', token, body, workspace, upstream = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body) headers['Content-Type'] = 'application/json';
  if (workspace) headers['X-Workspace-Id'] = workspace;
  const response = await fetch(new URL((upstream ? '' : prefix) + path, base), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  assert.equal(response.status, status, `${method} ${path}`);
  return status === 204 ? undefined : response.json();
}

async function register() {
  const username = `qa-${randomUUID().slice(0, 12)}`;
  const session = await request('/auth/register', 201, { method: 'POST', body: { username, password } });
  assert.equal(session.user.username, username);
  assert.match(session.accessToken, /^as_[A-Za-z0-9_-]{43}$/);
  assert.ok(Date.parse(session.expiresAt) > Date.now());
  return session;
}

assert.equal((await request('/auth/me', 401)).code, 'UNAUTHENTICATED');
const guest = await request('/capabilities', 200);
assert.equal(guest.capabilities.find((item) => item.id === 'account_preferences')?.reason, 'SIGN_IN_REQUIRED');
const account = await register();
const other = await register();
const originalToken = account.accessToken;
assert.notEqual(account.user.workspaceId, other.user.workspaceId);

const nonAscii = await request('/auth/register', 400, {
  method: 'POST', body: { username: 'K-account', password },
});
assert.equal(nonAscii.code, 'VALIDATION_ERROR');

const duplicate = await request('/auth/register', 409, {
  method: 'POST',
  body: { username: account.user.username.toUpperCase(), password },
});
assert.equal(duplicate.code, 'CONFLICT');

const denied = await request('/auth/login', 401, {
  method: 'POST',
  body: { username: account.user.username, password: 'wrong-password' },
});
assert.equal(denied.code, 'UNAUTHENTICATED');

const moved = await request('/auth/login', 200, {
  method: 'POST',
  body: { username: account.user.username.toUpperCase(), password },
});
assert.notEqual(moved.accessToken, originalToken);
assert.equal(moved.user.id, account.user.id);
const currentToken = moved.accessToken;

assert.equal((await request('/auth/me', 403, {
  token: currentToken, workspace: other.user.workspaceId,
})).code, 'FORBIDDEN');
assert.equal((await request('/auth/me', 200, { token: currentToken })).id, account.user.id);
assert.deepEqual((await request('/auth/me/preferences', 200, {
  method: 'PATCH', token: currentToken, body: { theme: 'dark' },
})).preferences, { locale: 'zh-CN', theme: 'dark' });
assert.equal((await request('/auth/me', 200, { token: originalToken })).preferences.theme, 'dark');
assert.equal((await request('/auth/me', 200, {
  token: other.accessToken,
})).preferences.theme, 'system');

const devices = await request('/auth/devices', 200, { token: currentToken });
assert.equal(devices.length, 2);
assert.equal(devices.filter((device) => device.current).length, 1);
const oldDevice = devices.find((device) => !device.current);
assert.equal((await request(`/auth/devices/${oldDevice.id}`, 404, {
  token: other.accessToken, method: 'DELETE',
})).code, 'NOT_FOUND');
await request(`/auth/devices/${oldDevice.id}`, 204, { token: currentToken, method: 'DELETE' });
assert.equal((await request('/auth/me', 401, { token: originalToken })).code, 'UNAUTHENTICATED');
await request('/auth/user/info', 401, { token: currentToken, upstream: true });
if (process.env.ASSISTANT_TEST_ADMIN_TOKEN) {
  const upstreamToken = process.env.ASSISTANT_TEST_ADMIN_TOKEN;
  await request('/auth/user/info', 200, { token: upstreamToken, upstream: true });
  assert.equal((await request('/auth/me', 401, { token: upstreamToken })).code, 'UNAUTHENTICATED');
}

for (const token of [currentToken, other.accessToken]) {
  await request('/auth/logout', 204, { token, method: 'POST' });
  assert.equal((await request('/auth/me', 401, { token })).code, 'UNAUTHENTICATED');
}
console.log(JSON.stringify({
  suite: 'assistant-account',
  status: 'passed',
  includedAdminTokenCheck: Boolean(process.env.ASSISTANT_TEST_ADMIN_TOKEN),
}));
