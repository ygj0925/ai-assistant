import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const origin = isolated(process.argv[2]);
const replayIndex = process.argv.indexOf('--replay');
const evidence = replayIndex < 0 ? undefined : process.argv[replayIndex + 1];
const restored = replayIndex < 0 ? undefined : isolated(process.argv[replayIndex + 2]);
const actors = [];
const base = '/automations/reminders';
const notices = '/automations/reminder-occurrences';
let api = origin;

function isolated(url) {
  const target = new URL(url);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && target.port,
    'Use an isolated loopback service with synthetic accounts.');
  assert.notEqual(target.port, '18080');
  return target;
}

async function request(path, expected, options = {}) {
  const headers = { Accept: 'application/json' };
  if (options.actor) headers.Authorization = `Bearer ${options.actor.token}`;
  if (options.workspace ?? options.actor?.workspace) {
    headers['X-Workspace-Id'] = options.workspace ?? options.actor.workspace;
  }
  if (options.key) headers['Idempotency-Key'] = options.key;
  if (options.body) headers['Content-Type'] = 'application/json';
  const method = options.method ?? 'GET';
  const response = await fetch(new URL(`/api/assistant/v1${path}`, api), {
    method, headers, body: options.body ? JSON.stringify(options.body) : undefined,
    redirect: 'error', signal: AbortSignal.timeout(12_000),
  });
  const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  assert.equal(response.status, expected, `${method} ${path} ${body?.code ?? ''}`);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
  return body;
}

async function register() {
  const credentials = { username: `qa-rem-${randomUUID().slice(0, 12)}`, password: `Qa!Rem${randomUUID()}` };
  const session = await request('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { token: session.accessToken, workspace: session.user.workspaceId,
    accountId: session.user.id, credentials };
  actors.push(actor);
  return actor;
}

function schedule(title, millis, extra = {}) {
  return { title, startsAtLocal: new Date(millis).toISOString().slice(0, 16), timeZone: 'UTC',
    cadence: 'once', ...extra };
}

function create(actor, input, key = randomUUID(), status = 201) {
  return request(base, status, { actor, method: 'POST', body: input, key });
}

function scope(id) {
  return `${notices}?reminderId=${id}`;
}

async function marker(name) {
  const cutoff = Date.now() + 240_000;
  do {
    try {
      await access(join(evidence, name));
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(200);
  } while (Date.now() < cutoff);
  assert.fail(`Fixture did not publish ${name}.`);
}

async function main() {
  const owner = await register();
  const future = Date.now() + 3 * 86_400_000;
  const pausedInput = schedule('跨夜静默提醒 🦀', future,
    { cadence: 'weekly', quietHours: { start: '22:00', end: '07:00' } });
  const key = randomUUID();
  const scheduled = await create(owner, pausedInput, key);
  assert.equal(scheduled.state, 'active');
  assert.equal(scheduled.startsAtLocal, pausedInput.startsAtLocal);
  assert.deepEqual(scheduled.quietHours, pausedInput.quietHours);

  if (evidence) {
    assert.notEqual(origin.port, restored.port);
    const discardedInput = schedule('已取消的合成提醒', future);
    const discardedKey = randomUUID();
    const discarded = await create(owner, discardedInput, discardedKey);
    await writeFile(join(evidence, 'backup-ready.json'),
      JSON.stringify({ accountId: owner.accountId, workspaceId: owner.workspace, paused: scheduled.id,
        cancelled: discarded.id }), { flag: 'wx' });
    await marker('backup-done');
    const paused = await request(`${base}/${scheduled.id}`, 200, {
      actor: owner, method: 'PATCH', body: { active: false },
    });
    assert.equal(paused.state, 'paused');
    await request(`${base}/${discarded.id}`, 204, { actor: owner, method: 'DELETE' });
    await writeFile(join(evidence, 'deletion-ready.json'), '{}', { flag: 'wx' });
    await marker('restore-done');
    api = restored;
    const recovered = await request(`${base}/${scheduled.id}`, 200, { actor: owner });
    assert.equal(recovered.state, 'paused');
    assert.equal(recovered.nextDeliveryAt, undefined);
    await request(`${base}/${discarded.id}`, 404, { actor: owner });
    await create(owner, discardedInput, discardedKey, 404);
    const resumed = await request(`${base}/${scheduled.id}`, 200, {
      actor: owner, method: 'PATCH', body: { active: true },
    });
    assert.equal(resumed.state, 'active');
    console.log(JSON.stringify({ restoredPause: 'retained', restoredCancellation: 'retained',
      sameKeyRecreation: 'blocked', explicitResume: 'passed' }));
    return;
  }

  const outsider = await register();
  const { capabilities } = await request('/capabilities', 200, { actor: owner });
  assert.equal(capabilities.find(({ id }) => id === 'scheduled_reminders')?.available, true);
  assert.equal((await create(owner, pausedInput, key)).id, scheduled.id);
  await create(owner, { ...pausedInput, title: 'Changed title' }, key, 409);
  await create(owner, { ...pausedInput, timeZone: '+08:00' }, randomUUID(), 400);
  await request(base, 401);
  await request(`${base}/${scheduled.id}`, 404, { actor: outsider });
  await request(base, 403, { actor: owner, workspace: outsider.workspace });
  const paused = await request(`${base}/${scheduled.id}`, 200, {
    actor: owner, method: 'PATCH', body: { active: false },
  });
  assert.equal(paused.state, 'paused');
  assert.equal(paused.nextScheduledAt, undefined);
  const resumed = await request(`${base}/${scheduled.id}`, 200, {
    actor: owner, method: 'PATCH', body: { active: true },
  });
  assert.equal(resumed.state, 'active');
  assert.equal(resumed.nextScheduledAt, scheduled.nextScheduledAt);

  const starts = Math.ceil((Date.now() + 4_000) / 60_000) * 60_000;
  const activeInput = schedule('实测站内提醒', starts);
  const occurrenceKey = randomUUID();
  const active = await create(owner, activeInput, occurrenceKey);
  const firstPage = await request(`${base}?limit=1`, 200, { actor: owner });
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.nextCursor);
  const nextPage = await request(`${base}?cursor=${encodeURIComponent(firstPage.nextCursor)}`, 200, { actor: owner });
  assert.notEqual(firstPage.items[0].id, nextPage.items[0].id);
  await request(`${base}?cursor=${encodeURIComponent(firstPage.nextCursor)}`, 400, { actor: outsider });

  let occurrence;
  do {
    const page = await request(scope(active.id), 200, { actor: owner });
    if (page.items.length) {
      assert.equal(page.items.length, 1);
      occurrence = page.items[0];
      break;
    }
    await delay(250);
  } while (Date.now() < starts + 15_000);
  assert.ok(occurrence, 'One-time in-app reminder did not arrive.');
  assert.equal(occurrence.outcome, 'delivered');
  assert.equal(occurrence.scheduledLocalAt, activeInput.startsAtLocal);
  assert.equal(occurrence.title, activeInput.title);
  assert.ok(Date.parse(occurrence.occurredAt) >= starts);
  assert.equal(occurrence.readAt, undefined);
  assert.equal((await request(`${base}/${active.id}`, 200, { actor: owner })).state, 'completed');
  await request(`${base}/${active.id}`, 409, { actor: owner, method: 'PATCH', body: { active: true } });
  const readRoute = `${notices}/${occurrence.id}`;
  await request(readRoute, 404, { actor: outsider, method: 'PATCH', body: { read: true } });
  const read = await request(readRoute, 200, { actor: owner, method: 'PATCH', body: { read: true } });
  assert.ok(read.readAt);
  const readAgain = await request(readRoute, 200, { actor: owner, method: 'PATCH', body: { read: true } });
  assert.equal(read.readAt, readAgain.readAt);
  await delay(1_600);
  assert.deepEqual((await request(scope(active.id), 200, { actor: owner })).items.map(({ id }) => id), [occurrence.id]);
  await request(`${base}/${active.id}`, 204, { actor: owner, method: 'DELETE' });
  await request(readRoute, 404, { actor: owner, method: 'PATCH', body: { read: true } });
  await create(owner, activeInput, occurrenceKey, 404);
  assert.deepEqual((await request(notices, 200, { actor: owner })).items, []);

  await request('/privacy/account-erasure', 204, {
    actor: owner, method: 'POST', body: { currentPassword: owner.credentials.password, confirmation: 'DELETE' },
  });
  await request(base, 401, { actor: owner });
  console.log(JSON.stringify({ deliveredOccurrences: 1, duplicateTick: 'deduplicated',
    privateHistory: 'owner-only', markRead: 'idempotent', pauseResume: 'passed',
    cancellation: 'durable', accountErasure: 'passed' }));
}

try {
  await main();
} finally {
  for (const actor of actors) {
    await request('/privacy/account-erasure', 204, {
      actor, method: 'POST', body: { currentPassword: actor.credentials.password, confirmation: 'DELETE' },
    }).catch(() => {});
    await request('/auth/logout', 204, { actor, method: 'POST' }).catch(() => {});
  }
}
