import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [source, mode = 'enabled', directory, target] = process.argv.slice(2);
function loopback(address) {
  const value = new URL(address);
  assert.ok(['http:', 'https:'].includes(value.protocol)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname)
    && value.port && value.port !== '18080' && value.pathname === '/'
    && !value.username && !value.password && !value.search && !value.hash,
  'Use a dedicated loopback fixture.');
  return value;
}
let origin = loopback(source);
const restored = target && loopback(target);
assert.ok(['enabled', 'quota', 'restore', 'disabled'].includes(mode));
assert.equal(Boolean(directory) && Boolean(target), mode === 'restore');
const evidence = directory && resolve(directory);
const prefix = '/api/assistant/v1';
const reminders = '/automations/reminders';
const shares = '/automations/reminder-shares';
const sessions = [];

async function call(path, expected, { actor, method = 'GET', body, key } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.accessToken;
    headers['X-Workspace-Id'] = actor.user.workspaceId;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(new URL(prefix + path, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  assert.equal(response.status, expected, method + ' ' + path + ' got ' + response.status + ' ' + (payload?.code ?? ''));
  if (path.includes('/share') || path.startsWith(shares)) {
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
  }
  if (response.status !== 204) assert.ok(payload);
  return payload;
}

async function register() {
  const credentials = { username: 'qa-rshare-' + randomUUID().slice(0, 10), password: 'Qa.RShare-' + randomUUID() };
  const actor = await call('/auth/register', 201, { method: 'POST', body: credentials });
  sessions.push(actor);
  return { ...actor, credentials };
}

function make(actor, request) {
  return call(reminders, 201, { actor, method: 'POST', body: request, key: randomUUID() });
}

function preview(actor, id, expected = 200) {
  return call(reminders + '/' + id + '/share-preview', expected, { actor, method: 'POST' });
}

function publish(actor, id, revision, expected = 201) {
  return call(reminders + '/' + id + '/shares', expected, { actor, method: 'POST', body: { revision } });
}

async function prepare(actor, reminder) {
  const checked = await preview(actor, reminder.id);
  const shared = await publish(actor, reminder.id, checked.revision);
  assert.match(shared.token, /^rt_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(shared).sort(), ['createdAt', 'expiresAt', 'id', 'token']);
  assert.ok(Date.parse(shared.expiresAt) <= Date.parse(checked.firstPlannedAt));
  assert.ok(Date.parse(shared.expiresAt) - Date.parse(shared.createdAt) <= 7 * 86_400_000);
  return { checked, shared };
}

function read(actor, token, expected = 200) {
  return call(shares + '/read', expected, { actor, method: 'POST', body: { token } });
}

function apply(actor, token, revision, confirm = true, expected = 201) {
  return call(shares + '/apply', expected, { actor, method: 'POST', body: { token, revision, confirm } });
}

function revoke(actor, id, expected = 204) {
  return call(shares + '/' + id, expected, { actor, method: 'DELETE' });
}

async function feature(actor, expected) {
  const { capabilities } = await call('/capabilities', 200, { actor });
  assert.equal(capabilities.find(({ id }) => id === 'reminder_templates')?.available, expected);
}

const sample = { title: '本机合成提醒 🧪', startsAtLocal: '2030-06-15T22:10',
  timeZone: 'Asia/Shanghai', cadence: 'once', quietHours: { start: '21:00', end: '08:00' } };

async function enabled(owner) {
  const receiver = await register();
  const bystander = await register();
  const initial = await make(owner, sample);
  await preview(receiver, initial.id, 404);
  const { checked, shared } = await prepare(owner, initial);
  assert.deepEqual(checked.template, sample);
  assert.equal(Date.parse(checked.firstPlannedAt), Date.parse('2030-06-15T14:10:00Z'));
  assert.equal(Date.parse(checked.firstDeliveryAt), Date.parse('2030-06-16T00:00:00Z'));
  assert.equal((await publish(owner, initial.id, '0'.repeat(64), 409)).code, 'SHARE_PREVIEW_STALE');
  const history = await call(reminders + '/' + initial.id + '/shares', 200, { actor: owner });
  assert.equal(history.items[0].id, shared.id);
  assert.equal(history.items[0].available, true);
  assert.ok(!JSON.stringify(history).includes(shared.token));

  await read(undefined, shared.token, 401);
  await read(receiver, 'rt_' + '0'.repeat(43), 404);
  const view = await read(receiver, shared.token);
  assert.deepEqual(Object.keys(view).sort(), ['expiresAt', 'firstDeliveryAt', 'firstPlannedAt', 'revision', 'template']);
  assert.deepEqual(view.template, checked.template);
  assert.equal(view.firstPlannedAt, checked.firstPlannedAt);
  assert.equal(view.firstDeliveryAt, checked.firstDeliveryAt);
  assert.notEqual(view.revision, checked.revision);
  assert.equal((await call(reminders, 200, { actor: receiver })).items.length, 0);
  await apply(receiver, shared.token, view.revision, false, 400);
  await apply(bystander, shared.token, view.revision, true, 409);
  await apply({ ...receiver, user: { ...receiver.user, workspaceId: owner.user.workspaceId } },
    shared.token, view.revision, true, 403);
  await call(shares + '/apply', 400, { actor: receiver, method: 'POST', body: {
    token: shared.token, revision: view.revision, confirm: true, timeZone: 'UTC',
  } });
  const [copy, again] = await Promise.all([0, 1].map(() => apply(receiver, shared.token, view.revision)));
  assert.equal(copy.id, again.id);
  assert.notEqual(copy.id, initial.id);
  assert.equal(copy.startsAtLocal, view.template.startsAtLocal);
  assert.equal(copy.timeZone, view.template.timeZone);
  assert.equal(copy.cadence, view.template.cadence);
  assert.deepEqual(copy.quietHours, view.template.quietHours);
  assert.equal(Date.parse(copy.nextScheduledAt), Date.parse(view.firstPlannedAt));
  assert.equal(Date.parse(copy.nextDeliveryAt), Date.parse(view.firstDeliveryAt));
  assert.equal((await call(reminders, 200, { actor: receiver })).items.length, 1);
  await revoke(receiver, shared.id, 404);
  await revoke(owner, shared.id);
  await revoke(owner, shared.id);
  await read(receiver, shared.token, 404);
  await apply(receiver, shared.token, view.revision, true, 404);
  assert.equal((await call(reminders + '/' + copy.id, 200, { actor: receiver })).id, copy.id);

  for (const cadence of ['daily', 'weekly']) {
    const source = await make(owner, { title: '相同未来时段 ' + cadence,
      startsAtLocal: '2024-01-01T05:00', timeZone: 'UTC', cadence });
    const { checked: occurrence, shared: link } = await prepare(owner, source);
    assert.notEqual(occurrence.template.startsAtLocal, source.startsAtLocal);
    assert.ok(Date.parse(occurrence.firstPlannedAt) > Date.now());
    const accepted = await read(receiver, link.token);
    const duplicate = await apply(receiver, link.token, accepted.revision);
    assert.equal(duplicate.startsAtLocal, occurrence.template.startsAtLocal);
    assert.equal(Date.parse(duplicate.nextScheduledAt), Date.parse(occurrence.firstPlannedAt));
    await call(reminders + '/' + source.id, 200, { actor: owner, method: 'PATCH', body: { active: false } });
    await read(receiver, link.token, 404);
    await call(reminders + '/' + source.id, 200, { actor: owner, method: 'PATCH', body: { active: true } });
    await read(receiver, link.token, 404);
  }
  const deletedSource = (await prepare(owner, initial)).shared;
  await call(reminders + '/' + initial.id, 204, { actor: owner, method: 'DELETE' });
  await read(receiver, deletedSource.token, 404);
  console.log(JSON.stringify({ ownerAndWorkspaceIsolation: true, requiredRecipientConfirmation: true,
    reviewedCalendarAndQuietShiftCopied: true, repeatApplicationIdempotent: true,
    noPublisherIdentityOrDeliveryMetadata: true, existingCopiesIndependent: true,
    recurringFutureOccurrenceExact: true, pauseResumeAndDeletionInvalidateOldLinks: true }));
}

async function quota(owner) {
  const receiver = await register();
  const originReminder = await make(owner, sample);
  const { shared } = await prepare(owner, originReminder);
  const checked = await read(receiver, shared.token);
  for (let index = 1; index <= 32; index += 1) {
    await make(receiver, { ...sample, title: '独立限额占位 ' + index });
  }
  const before = await call(reminders + '?limit=50', 200, { actor: receiver });
  assert.equal(before.items.length, 32);
  const rejected = await apply(receiver, shared.token, checked.revision, true, 409);
  assert.equal(rejected.code, 'CONFLICT');
  const after = await call(reminders + '?limit=50', 200, { actor: receiver });
  assert.deepEqual(after.items.map(({ id }) => id), before.items.map(({ id }) => id));
  console.log(JSON.stringify({ recipientQuotaIndependentlyChecked: true, noPartialCopy: true }));
}

async function marker(name, detail) {
  const path = join(evidence, name + '.json');
  await writeFile(path + '.tmp', JSON.stringify(detail) + '\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

async function waitForMarker(name) {
  const deadline = Date.now() + 120_000;
  do {
    try {
      await access(join(evidence, name + '.json'));
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(200);
  } while (Date.now() < deadline);
  assert.fail('Fixture did not create ' + name + '.json.');
}

async function restore(owner) {
  const receiver = await register();
  const source = await make(owner, { ...sample, title: '备份前可见的模板' });
  const deleting = await make(owner, { ...sample, title: '备份后删除的模板来源' });
  const revoked = (await prepare(owner, source)).shared;
  const drop = (await prepare(owner, deleting)).shared;
  const control = (await prepare(owner, source)).shared;
  const review = await read(receiver, revoked.token);
  const ownCopy = await apply(receiver, revoked.token, review.revision);
  const dropReview = await read(receiver, drop.token);
  await marker('backup-ready', { ownerId: owner.user.id, workspaceId: owner.user.workspaceId,
    revokedShareId: revoked.id, deletedSourceId: deleting.id, droppedShareId: drop.id,
    controlShareId: control.id, recipientCopyId: ownCopy.id });
  await waitForMarker('backup-done');
  await revoke(owner, revoked.id);
  await call(reminders + '/' + deleting.id, 204, { actor: owner, method: 'DELETE' });
  await read(receiver, revoked.token, 404);
  await read(receiver, drop.token, 404);
  await marker('restore-ready', {});
  await waitForMarker('database-switched');
  origin = restored;
  await feature(owner, true);
  await read(receiver, revoked.token, 404);
  await read(receiver, drop.token, 404);
  await apply(receiver, revoked.token, review.revision, true, 404);
  await apply(receiver, drop.token, dropReview.revision, true, 404);
  const restoredCopy = await call(reminders + '/' + ownCopy.id, 200, { actor: receiver });
  assert.equal(restoredCopy.id, ownCopy.id);
  assert.deepEqual(restoredCopy.quietHours, sample.quietHours);
  const active = await read(receiver, control.token);
  const nextCopy = await apply(receiver, control.token, active.revision);
  assert.notEqual(nextCopy.id, ownCopy.id);
  const summary = { revokedInvitationStayedUnavailable: true, deletedSourceInvitationStayedUnavailable: true,
    independentRecipientCopyRestored: true, unaffectedInvitationCanStillApply: true };
  await marker('summary', summary);
  console.log(JSON.stringify(summary));
}

try {
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    assert.deepEqual(await readdir(evidence), [], 'Use a fresh evidence directory.');
  }
  await feature(undefined, false);
  const owner = await register();
  await feature(owner, mode !== 'disabled');
  if (mode === 'enabled') await enabled(owner);
  else if (mode === 'quota') await quota(owner);
  else if (mode === 'restore') await restore(owner);
  else {
    assert.equal((await preview(owner, randomUUID(), 403)).code, 'CAPABILITY_UNAVAILABLE');
    await read(owner, 'rt_' + '0'.repeat(43), 403);
    console.log(JSON.stringify({ disabledGateKeepsTemplatesUnavailable: true }));
  }
} finally {
  for (const actor of sessions) await call('/auth/logout', 204, { actor, method: 'POST' }).catch(() => {});
}
