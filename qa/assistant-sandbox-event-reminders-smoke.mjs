import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [source, mode, folder, target] = process.argv.slice(2);
assert.ok(['enabled', 'disabled', 'restore'].includes(mode));
assert.equal(Boolean(folder && target), mode === 'restore');

function loopback(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.port && !['18080', '18090'].includes(url.port) && url.pathname === '/' && !url.username && !url.password
    && !url.search && !url.hash, 'Use the dedicated synthetic loopback instance.');
  return url;
}

let origin = loopback(source);
const restored = target && loopback(target);
const evidence = folder && resolve(folder);
if (evidence) await mkdir(evidence, { recursive: true });
const base = '/automations/event-reminders';
const connector = '/automations/sandbox-connector';

async function request(path, expected, { actor, method = 'GET', body, key } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.token;
    headers['X-Workspace-Id'] = actor.workspace;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key !== undefined) headers['Idempotency-Key'] = key;
  const response = await fetch(new URL('/api/assistant/v1' + path, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(12_000),
  });
  const data = response.status === 204 ? undefined : await response.json().catch(() => null);
  assert.equal(response.status, expected, method + ' ' + path + ' → ' + (data?.code ?? ''));
  if (path.startsWith(base)) assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  return data;
}

async function register() {
  const credentials = {
    username: 'qa-event-' + randomUUID().slice(0, 10),
    password: 'Qa.Event-' + randomUUID(),
  };
  const { accessToken, user } = await request('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { token: accessToken, workspace: user.workspaceId };
  const { authorizationId } = await request(connector + '/authorization', 200, {
    actor, method: 'POST', body: { confirm: true },
  });
  return { ...actor, authorizationId };
}

function subscribe(actor, title, quietHours, expected = 201, timeZone = 'UTC') {
  return request(base, expected, { actor, method: 'POST',
    body: { title, authorizationId: actor.authorizationId, eventKind: 'fixture_notice_recorded',
      timeZone, quietHours } });
}

function receive(actor, operationId, expected = 200) {
  return request(base + '/receive', expected, { actor, method: 'POST',
    body: { authorizationId: actor.authorizationId, operationId } });
}

function occurrences(actor, reminder, expected = 200) {
  return request(base + '/' + reminder.id + '/occurrences', expected, { actor });
}

function change(actor, reminder, active, expected = 200) {
  return request(base + '/' + reminder.id + '/state', expected, { actor, method: 'PATCH', body: { active } });
}

function remove(actor, reminder, expected = 204) {
  return request(base + '/' + reminder.id, expected, { actor, method: 'DELETE' });
}

function revoke(actor) {
  return request(connector + '/authorization/' + actor.authorizationId, 204, { actor, method: 'DELETE' });
}

function read(actor, reminder, occurrence, expected = 200) {
  return request(base + '/' + reminder.id + '/occurrences/' + occurrence.id + '/read', expected,
    { actor, method: 'POST' });
}

async function poll(probe, accept, label) {
  const deadline = Date.now() + 18_000;
  while (Date.now() < deadline) {
    const value = await probe();
    if (accept(value)) return value;
    await delay(80);
  }
  assert.fail(label);
}

async function simulate(actor) {
  const action = await request(connector + '/actions', 201, { actor, method: 'POST', key: randomUUID(),
    body: { authorizationId: actor.authorizationId, kind: 'fixture_notice', simulation: 'acknowledged' } });
  await request(connector + '/actions/' + action.id + '/approve', 202, { actor, method: 'POST',
    body: { confirm: true, approvalRevision: action.approvalRevision } });
  const final = await poll(() => request(connector + '/actions/' + action.id, 200, { actor }),
    ({ state }) => state === 'completed', 'Synthetic action did not publish its verified result.');
  assert.equal(final.result.kind, 'fixture_receipt');
  return final.id;
}

function currentQuietWindow() {
  const minutes = Math.floor(Date.now() / 60_000) % 1440;
  const format = (value) => {
    const day = (value + 1440) % 1440;
    return String(Math.floor(day / 60)).padStart(2, '0') + ':' + String(day % 60).padStart(2, '0');
  };
  return { start: format(minutes - 20), end: format(minutes + 20) };
}

async function mark(name, data) {
  const path = join(evidence, name + '.json');
  await writeFile(path + '.tmp', JSON.stringify(data) + '\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

async function waitForMark(name) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try {
      await access(join(evidence, name + '.json'));
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(125);
  }
  assert.fail('Missing synthetic marker ' + name);
}

function exactCounts(receipt, operationId, counts) {
  assert.deepEqual(receipt, { operationId, ...counts });
}

await request(base, 401);
const owner = await register();
const { capabilities } = await request('/capabilities', 200, { actor: owner });
assert.equal(capabilities.find(({ id }) => id === 'sandbox_event_reminders')?.available, mode !== 'disabled');
assert.deepEqual(await request(base, 200, { actor: owner }), { items: [] });
if (mode === 'disabled') {
  assert.equal((await subscribe(owner, '启用开关关闭', undefined, 403)).code, 'CAPABILITY_UNAVAILABLE');
  assert.equal((await receive(owner, randomUUID(), 403)).code, 'CAPABILITY_UNAVAILABLE');
  assert.deepEqual(await request(base, 200, { actor: owner }), { items: [] });
  console.log(JSON.stringify({ featureOffDeniesCreationAndIntake: true, currentScopeReadsSafe: true }));
} else if (mode === 'restore') {
  const other = await register();
  const quiet = currentQuietWindow();
  const paused = await subscribe(owner, '恢复后仍暂停', quiet);
  const deleted = await subscribe(owner, '恢复后仍删除', quiet);
  const revoked = await subscribe(other, '恢复后仍撤权', quiet);
  const first = await simulate(owner);
  const second = await simulate(other);
  exactCounts(await receive(owner, first), first, { scheduled: 2, duplicates: 0, skipped: 0 });
  exactCounts(await receive(other, second), second, { scheduled: 1, duplicates: 0, skipped: 0 });
  for (const [actor, row] of [[owner, paused], [owner, deleted], [other, revoked]]) {
    assert.equal((await occurrences(actor, row)).items[0].state, 'waiting');
  }
  await mark('snapshot-ready', { paused: paused.id, removed: deleted.id, revoked: revoked.id });
  await waitForMark('snapshot-done');
  assert.equal((await change(owner, paused, false)).state, 'paused');
  await remove(owner, deleted);
  await revoke(other);
  assert.equal((await occurrences(owner, paused)).items[0].state, 'withdrawn');
  await mark('revoke-ready', { paused: paused.id, removed: deleted.id, revoked: revoked.id });
  await waitForMark('database-switched');
  origin = restored;
  const listed = (await request(base, 200, { actor: owner })).items;
  assert.deepEqual(listed.map(({ id, state }) => [id, state]), [[paused.id, 'paused']]);
  await occurrences(owner, deleted, 404);
  assert.equal((await occurrences(owner, paused)).items[0].state, 'withdrawn');
  assert.equal((await request(base, 200, { actor: other })).items[0].state, 'authorization_revoked');
  const closed = (await occurrences(other, revoked)).items[0];
  assert.equal(closed.state, 'withdrawn');
  assert.equal(closed.operationId, undefined);
  assert.equal((await receive(other, second, 409)).code, 'CONNECTOR_AUTHORIZATION_CHANGED');
  assert.equal((await change(owner, paused, true)).state, 'active');
  exactCounts(await receive(owner, first), first, { scheduled: 0, duplicates: 1, skipped: 0 });
  assert.equal((await occurrences(owner, paused)).items.length, 1);
  assert.equal((await occurrences(owner, paused)).items[0].state, 'withdrawn');
  await mark('summary', { quietDeliveryNotRestoredAfterPause: true, deleteAndGrantRevocationReplayed: true,
    sourceIdHiddenAfterGrantLoss: true, duplicateAfterRestartAndResumeDoesNotRedeliver: true });
} else {
  const outsider = await register();
  assert.equal((await subscribe(owner, '非法时区', undefined, 400, 'Fixture/Wrong')).code, 'VALIDATION_ERROR');
  assert.equal((await subscribe(owner, '非法静默时间', { start: '99:50', end: '00:30' }, 400)).code, 'VALIDATION_ERROR');
  const beforeSubscription = await simulate(owner);
  const fast = await subscribe(owner, '立即送达');
  const quiet = await subscribe(owner, '静默到期再送达', currentQuietWindow());
  exactCounts(await receive(owner, beforeSubscription), beforeSubscription, { scheduled: 0, duplicates: 0, skipped: 0 });
  const operation = await simulate(owner);
  await occurrences(outsider, fast, 404);
  await receive(outsider, operation, 404);
  await receive(owner, randomUUID(), 404);
  const payload = await request(base + '/receive', 400, { actor: owner, method: 'POST',
    body: { authorizationId: owner.authorizationId, operationId: operation, content: '拒绝的合成任意事件正文' } });
  assert.equal(payload.code, 'VALIDATION_ERROR');
  const replies = await Promise.all(Array.from({ length: 5 }, () => receive(owner, operation)));
  assert.equal(replies.reduce((sum, row) => sum + row.scheduled, 0), 2);
  assert.equal(replies.reduce((sum, row) => sum + row.duplicates, 0), 8);
  const delivered = (await poll(() => occurrences(owner, fast),
    ({ items }) => items[0]?.state === 'delivered', 'Immediate in-app delivery did not occur.')).items[0];
  assert.equal(delivered.operationId, operation);
  assert.ok(Date.parse(delivered.deliveredAt) >= Date.parse(delivered.deliveryAt));
  const readReceipt = await read(owner, fast, delivered);
  assert.ok(readReceipt.readAt);
  assert.deepEqual(await read(owner, fast, delivered), readReceipt);
  const waiting = (await occurrences(owner, quiet)).items[0];
  assert.equal(waiting.state, 'waiting');
  assert.ok(Date.parse(waiting.deliveryAt) > Date.now());
  assert.equal((await read(owner, quiet, waiting, 409)).code, 'EVENT_REMINDER_NOT_DELIVERED');

  assert.equal((await change(owner, quiet, false)).state, 'paused');
  assert.equal((await occurrences(owner, quiet)).items[0].state, 'withdrawn');
  const later = await simulate(owner);
  exactCounts(await receive(owner, later), later, { scheduled: 1, duplicates: 0, skipped: 1 });
  assert.equal((await change(owner, quiet, true)).state, 'active');
  exactCounts(await receive(owner, later), later, { scheduled: 0, duplicates: 2, skipped: 0 });
  assert.deepEqual((await occurrences(owner, quiet)).items.map(({ state }) => state).sort(),
    ['skipped', 'withdrawn']);
  await revoke(owner);
  assert.equal((await request(base, 200, { actor: owner })).items.every(({ state }) => state === 'authorization_revoked'), true);
  assert.equal((await occurrences(owner, fast)).items.every(({ operationId }) => operationId === undefined), true);
  await remove(owner, quiet);
  await remove(owner, quiet);
  await occurrences(owner, quiet, 404);
  console.log(JSON.stringify({ receivesOnlyTrustedCompletedActions: true, concurrentDeduplication: true,
    deliveredAndReadRecorded: true, quietWindowAndPauseSuppression: true, revokedSourceHidden: true,
    deleteAndForeignScopeEnforced: true }));
}
