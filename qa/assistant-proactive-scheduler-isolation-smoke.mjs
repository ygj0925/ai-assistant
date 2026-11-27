import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [address, directory] = process.argv.slice(2);
const origin = new URL(address);
assert.ok(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
  && origin.port && !['18080', '18090'].includes(origin.port) && origin.pathname === '/' && !origin.username
  && !origin.password && !origin.search && !origin.hash, 'Use a dedicated synthetic loopback API.');
assert.ok(directory, 'Provide a new isolated evidence directory.');
const evidence = resolve(directory);
await mkdir(evidence, { recursive: true });

async function call(path, status, { actor, method = 'GET', body, key } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.token;
    headers['X-Workspace-Id'] = actor.workspaceId;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(new URL('/api/assistant/v1' + path, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  assert.equal(response.status, status, method + ' ' + path);
  return response.json();
}

async function register(label) {
  const { accessToken, user } = await call('/auth/register', 201, { method: 'POST',
    body: { username: 'qa-proactive-' + label + '-' + randomUUID().slice(0, 8),
      password: 'Qa.Scheduler-' + randomUUID() } });
  return { token: accessToken, accountId: user.id, workspaceId: user.workspaceId };
}

async function mark(name, value) {
  const path = join(evidence, name + '.json');
  await writeFile(path + '.tmp', JSON.stringify(value) + '\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

async function until(probe, check, label, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (check(value)) return value;
    await delay(125);
  }
  assert.fail(label);
}

function exists(name) {
  return access(join(evidence, name + '.json')).then(() => true, (error) => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
}

function list(actor) {
  return call('/automations/proactive/suggestions', 200, { actor });
}

const failing = await register('fault');
const healthy = await register('healthy');
await call('/automations/reminders', 201, { actor: healthy, method: 'POST', key: randomUUID(),
  body: { title: '独立调度故障合成对照',
    startsAtLocal: new Date(Date.now() + 90 * 60_000).toISOString().slice(0, 16),
    timeZone: 'UTC', cadence: 'once' } });
for (const actor of [failing, healthy]) {
  await call('/automations/proactive/preferences', 200, { actor, method: 'PUT',
    body: { enabled: true, role: 'schedule_planner', notification: 'silent', timeZone: 'UTC' } });
  assert.deepEqual(await list(actor), { items: [] });
}
await mark('fixture-ready', {
  badAccountId: failing.accountId, badWorkspaceId: failing.workspaceId,
  healthyAccountId: healthy.accountId, healthyWorkspaceId: healthy.workspaceId,
});
await until(() => exists('fault-armed'), Boolean, 'The isolated native fault was not armed.', 240_000);
const view = await until(() => list(healthy), ({ items }) => items.length === 1,
  'The healthy scheduler candidate did not issue within one bounded batch.', 15_000);
assert.equal(view.items[0].kind, 'review_upcoming');
assert.deepEqual(await list(failing), { items: [] });
await mark('summary', { healthyIssuanceAfterEarlierScopeFailure: true, failingScopeHasNoSuggestion: true });
