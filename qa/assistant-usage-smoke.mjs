import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18090');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Use isolated loopback only');
const sessions = [];

async function request(path, status, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(new URL('/api/assistant/v1' + path, origin), {
    method,
    headers: {
      ...headers,
      ...(token && { Authorization: `Bearer ${token}` }),
      ...(body && { 'Content-Type': 'application/json' }),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(5000),
    redirect: 'error',
  });
  assert.equal(response.status, status, `${method} ${path}`);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/, `${method} ${path}`);
  return status === 204 ? undefined : response.json();
}

async function register() {
  const session = await request('/auth/register', 201, { method: 'POST', body: {
    username: `usage-${randomUUID().slice(0, 12)}`,
    password: `Qa-${randomUUID()}`,
  } });
  sessions.push(session.accessToken);
  return session;
}

try {
  const { accessToken: token } = await register();
  const independent = await register();
  const before = await request('/usage', 200, { token });
  assert.deepEqual(before, { limit: 1_000_000, reserved: 0, used: 0, available: 1_000_000, unit: 'output_code_points' });
  await request('/usage', 401);
  await request('/usage', 403, { token, headers: { 'X-Workspace-Id': independent.user.workspaceId } });

  const { id } = await request('/conversations', 201, { method: 'POST', token, body: { title: 'QA usage' } });
  const start = (content) => request(`/conversations/${id}/runs`, 202, {
    method: 'POST', token, body: { action: 'send', content, modelId: 'local-echo' },
    headers: { 'Idempotency-Key': randomUUID() },
  });
  const long = await start('预留额度测试🌱'.repeat(60));
  const during = await request('/usage', 200, { token });
  assert.ok(during.reserved > 0);
  assert.equal(during.available, before.limit - during.reserved);
  const cancelled = await request(`/runs/${long.runId}/cancel`, 200, { method: 'POST', token });
  assert.equal(cancelled.state, 'cancelled');
  const afterCancel = await request('/usage', 200, { token });
  assert.equal(afterCancel.reserved, 0);
  assert.equal(afterCancel.used, [...cancelled.content].length);
  assert.equal(afterCancel.available, before.limit - afterCancel.used);

  const short = await start('收到 🌱');
  const deadline = Date.now() + 8000;
  let snapshot = short;
  while (['queued', 'running'].includes(snapshot.state) && Date.now() < deadline) {
    await delay(90);
    snapshot = await request(`/runs/${short.runId}`, 200, { token });
  }
  assert.equal(snapshot.state, 'completed');
  const after = await request('/usage', 200, { token });
  assert.equal(after.reserved, 0);
  assert.equal(after.used, afterCancel.used + [...snapshot.content].length);
  assert.equal(after.available, before.limit - after.used);
  assert.deepEqual(await request('/usage', 200, { token: independent.accessToken }), before);
  console.log(JSON.stringify({ suite: 'assistant-usage', status: 'passed' }));
} finally {
  await Promise.allSettled(sessions.map((token) => request('/auth/logout', 204, { method: 'POST', token })));
}
