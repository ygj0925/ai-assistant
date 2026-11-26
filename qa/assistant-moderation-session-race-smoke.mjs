import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [baseUrl, checkpointDir] = process.argv.slice(2);
const base = new URL(baseUrl);
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
  && base.port && base.port !== '18080' && base.pathname === '/' && !base.username && !base.password
  && !base.search && !base.hash && checkpointDir, 'Use a dedicated loopback QA fixture.');
const folder = resolve(checkpointDir);
await mkdir(folder, { recursive: true });
const accounts = [];

async function request(path, expected, { actor, method = 'GET', body, key } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) headers.Authorization = 'Bearer ' + actor.accessToken;
  if (key) headers['Idempotency-Key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL('/api/assistant/v1' + path, base), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(35_000),
  });
  const value = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  assert.equal(response.status, expected, `${method} ${path} ${value?.code ?? ''}`);
  return value;
}

async function register() {
  const credentials = { username: 'qa-report-lock-' + randomUUID().slice(0, 10), password: 'Qa.Review!' + randomUUID() };
  const session = await request('/auth/register', 201, { method: 'POST', body: credentials });
  accounts.push(session);
  return { ...session, credentials };
}

async function mark(name, data) {
  const path = join(folder, name);
  await writeFile(path + '.tmp', JSON.stringify(data) + '\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

async function wait(name, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  do {
    try { await access(join(folder, name)); return; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail('No database witness checkpoint ' + name);
}

try {
  const owner = await register();
  const reporter = await register();
  const room = await request('/conversations', 201, { actor: owner, method: 'POST', body: { title: 'Synthetic device race' } });
  const run = await request(`/conversations/${room.id}/runs`, 202, {
    actor: owner, method: 'POST', key: randomUUID(), body: { action: 'send', content: 'Synthetic race reply' },
  });
  const deadline = Date.now() + 15_000;
  let finished;
  while (Date.now() < deadline) {
    finished = await request(`/runs/${run.runId}`, 200, { actor: owner });
    if (finished.state === 'completed') break;
    await delay(100);
  }
  assert.equal(finished?.state, 'completed');
  const body = { sourceMessageId: finished.messageId, scope: 'reply', audience: 'link', includesAttachments: false };
  const draft = await request(`/conversations/${room.id}/share-previews`, 200, { actor: owner, method: 'POST', body });
  const published = await request(`/conversations/${room.id}/shares`, 201, {
    actor: owner, method: 'POST', body: { ...body, revision: draft.revision },
  });
  const shared = await request('/shares/read', 200, { actor: reporter, method: 'POST', body: { token: published.token } });
  const replyIndex = shared.messages.findIndex((message) => message.role === 'assistant');
  assert.ok(replyIndex >= 0);
  const claim = { targetType: 'shared_reply', shareToken: published.token, replyIndex, reason: 'safety' };
  await mark('reporter-ready', { reporterAccountId: reporter.user.id, workspaceId: owner.user.workspaceId, shareId: published.id });
  await wait('reporter-session-locked');
  const result = await request('/reports', 401, { actor: reporter, method: 'POST', body: claim });
  assert.equal(result.code, 'UNAUTHENTICATED');
  await mark('revoked-report-denied', {});
  await wait('denial-count-verified');

  const fresh = await request('/auth/login', 200, { method: 'POST', body: reporter.credentials });
  accounts.push(fresh);
  const received = await request('/reports', 201, { actor: fresh, method: 'POST', body: claim });
  assert.equal(received.targetId, published.id);
  assert.equal(received.targetType, 'shared_reply');
  console.log(JSON.stringify({ revokedInFlightReport: 401, zeroStaleReceipts: true, freshSessionControl: 201 }));
} finally {
  await Promise.allSettled(accounts.map((actor) => request('/auth/logout', 204, { actor, method: 'POST' })));
}
