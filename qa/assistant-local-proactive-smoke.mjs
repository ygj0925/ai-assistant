import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [source, mode, directory, target] = process.argv.slice(2);
assert.ok(['enabled', 'disabled', 'restore', 'workspace'].includes(mode));
assert.equal(Boolean(target), mode === 'restore');
assert.equal(Boolean(directory), ['restore', 'workspace'].includes(mode));
function loopback(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.port && url.port !== '18080' && url.pathname === '/' && !url.username && !url.password
    && !url.search && !url.hash, 'Use the isolated synthetic loopback fixture.');
  return url;
}
let origin = loopback(source);
const restored = target && loopback(target);
const evidence = directory && resolve(directory);
if (evidence) await mkdir(evidence, { recursive: true });
const base = '/automations/proactive';
const prefs = base + '/preferences';
const suggestions = base + '/suggestions';
const reminders = '/automations/reminders';
const occurrences = '/automations/reminder-occurrences';
const calendarSentinel = '源提醒的私有合成标题🦀';
const defaultPolicy = { enabled: false, role: 'reminder_review', notification: 'silent', timeZone: 'UTC' };

async function request(path, status, { actor, method = 'GET', body, key } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.token;
    headers['X-Workspace-Id'] = actor.workspace;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key !== undefined) headers['Idempotency-Key'] = key;
  const response = await fetch(new URL('/api/assistant/v1' + path, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
    signal: AbortSignal.timeout(8_000),
  });
  const data = response.status === 204 ? undefined : await response.json().catch(() => null);
  assert.equal(response.status, status, method + ' ' + path + ' → ' + (data?.code ?? ''));
  if (path.startsWith(base)) assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  return data;
}

async function register() {
  const { accessToken, user } = await request('/auth/register', 201, { method: 'POST', body: {
    username: 'qa-proactive-' + randomUUID().slice(0, 9), password: 'Qa.Proactive-' + randomUUID(),
  } });
  return { token: accessToken, accountId: user.id, workspace: user.workspaceId };
}

function change(actor, patch, expected = 200) {
  return request(prefs, expected, { actor, method: 'PUT',
    body: { ...defaultPolicy, ...patch } });
}

function planner(actor, patch = {}, expected = 200) {
  return change(actor, { enabled: true, role: 'schedule_planner', notification: 'in_app', ...patch },
    expected);
}

async function list(actor) {
  return (await request(suggestions, 200, { actor })).items;
}

function dismiss(actor, id, expected = 204) {
  return request(suggestions + '/' + id + '/dismiss', expected, { actor, method: 'POST' });
}

function calendar(actor, time = Date.now() + 90 * 60_000) {
  return request(reminders, 201, { actor, method: 'POST', key: randomUUID(),
    body: { title: calendarSentinel, startsAtLocal: new Date(time).toISOString().slice(0, 16),
      timeZone: 'UTC', cadence: 'once' } });
}

async function waitFor(probe, accept, message, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const current = await probe();
    if (accept(current)) return current;
    await delay(125);
  }
  assert.fail(message);
}

async function advice(actor, kind) {
  const items = await waitFor(() => list(actor), (value) => value.length > 0,
    'The opted-in calendar assistant did not propose a suggestion.');
  assert.equal(items.length, 1);
  const result = items[0];
  assert.deepEqual(Object.keys(result).sort(), ['createdAt', 'id', 'kind', 'source', 'state']);
  assert.equal(result.kind, kind);
  assert.equal(result.source, 'owned_calendar');
  assert.equal(result.state, 'available');
  assert.doesNotMatch(JSON.stringify(result), /私有合成标题/);
  return result;
}

function currentQuietWindow() {
  const minutes = Math.floor(Date.now() / 60_000) % 1440;
  const format = (value) => {
    const day = (value + 1440) % 1440;
    return String(Math.floor(day / 60)).padStart(2, '0') + ':' + String(day % 60).padStart(2, '0');
  };
  return { start: format(minutes - 20), end: format(minutes + 20) };
}

async function mark(name, value) {
  const path = join(evidence, name + '.json');
  await writeFile(path + '.tmp', JSON.stringify(value) + '\n', { flag: 'wx' });
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
    await delay(140);
  }
  assert.fail('Missing synthetic marker ' + name);
}

await request(prefs, 401);
const owner = await register();
const { capabilities } = await request('/capabilities', 200, { actor: owner });
assert.equal(capabilities.find(({ id }) => id === 'local_proactive_assistant')?.available, mode !== 'disabled');
assert.deepEqual(await request(prefs, 200, { actor: owner }), defaultPolicy);
assert.deepEqual(await list(owner), []);

if (mode === 'disabled') {
  await calendar(owner);
  assert.equal((await planner(owner, {}, 403)).code, 'CAPABILITY_UNAVAILABLE');
  assert.deepEqual(await request(prefs, 200, { actor: owner }), defaultPolicy);
  assert.deepEqual(await list(owner), []);
  console.log(JSON.stringify({ featureOffKeepsOwnSettingsReadable: true, flagOffRejectsOptIn: true,
    calendarSourceStillAvailable: true }));
} else if (mode === 'workspace') {
  const organization = await register();
  const setup = { ownerId: organization.accountId, memberId: owner.accountId, workspaceId: organization.workspace };
  await mark('membership-needed', setup);
  await waitForMark('membership-added');
  const member = { ...owner, workspace: organization.workspace };
  await calendar(member);
  await planner(member);
  const stale = await advice(member, 'review_upcoming');
  const leave = '/auth/workspaces/' + member.workspace;
  const preview = await request(leave + '/leave-preview', 200, { actor: member });
  await request(leave + '/leave', 204, { actor: member, method: 'POST',
    body: { confirm: true, membershipRevision: preview.membershipRevision } });
  await request(suggestions, 403, { actor: member });
  await mark('rejoin-needed', setup);
  await waitForMark('rejoin-added');
  const renewed = await request(leave + '/leave-preview', 200, { actor: member });
  assert.notEqual(renewed.membershipRevision, preview.membershipRevision);
  assert.deepEqual(await request(prefs, 200, { actor: member }), defaultPolicy);
  assert.deepEqual(await list(member), []);
  await dismiss(member, stale.id, 404);
  assert.deepEqual(await list(owner), []);
  await mark('summary', { priorMembershipCannotReadEvents: true, freshEnrollmentNeedsNewConsent: true });
} else if (mode === 'restore') {
  const other = await register();
  const preCreation = await register();
  for (const actor of [owner, other, preCreation]) await calendar(actor);
  await planner(owner);
  await planner(other);
  await planner(preCreation, { notification: 'silent' });
  const issued = await advice(owner, 'review_upcoming');
  const dismissed = await advice(other, 'review_upcoming');
  const scope = (actor) => ({ accountId: actor.accountId, workspaceId: actor.workspace });
  await mark('snapshot-ready', { owner: scope(owner), other: scope(other),
    earlier: scope(preCreation), offSuggestion: issued.id, dismissal: dismissed.id });
  await waitForMark('snapshot-done');
  await planner(owner, { enabled: false });
  await dismiss(other, dismissed.id);
  await planner(preCreation);
  const oldAbsent = await advice(preCreation, 'review_upcoming');
  await planner(preCreation, { enabled: false });
  assert.deepEqual(await list(owner), []);
  assert.deepEqual(await list(other), []);
  assert.deepEqual(await list(preCreation), []);
  await mark('revoke-ready', { earlierIssued: oldAbsent.id });
  await waitForMark('database-switched');
  origin = restored;
  assert.equal((await request(prefs, 200, { actor: owner })).enabled, false);
  assert.equal((await request(prefs, 200, { actor: other })).enabled, true);
  assert.equal((await request(prefs, 200, { actor: preCreation })).enabled, false);
  for (const actor of [owner, other, preCreation]) assert.deepEqual(await list(actor), []);
  await planner(owner);
  await planner(preCreation);
  await delay(1900);
  assert.deepEqual(await list(owner), []);
  assert.deepEqual(await list(preCreation), []);
  await dismiss(other, dismissed.id);
  await mark('summary', { oldSettingsOffAfterRestore: true, oldDismissalStaysClosed: true,
    backupBeforeCreationCannotReissueSameDaySuggestion: true });
} else {
  const outsider = await register();
  const normal = await calendar(owner);
  await planner(owner, { notification: 'silent' });
  await delay(1250);
  assert.deepEqual(await list(owner), []);
  assert.equal((await planner(owner, { timeZone: 'Fixture/Wrong' }, 400)).code, 'VALIDATION_ERROR');
  assert.equal((await planner(owner, { quietHours: { start: '99:00', end: '00:00' } }, 400)).code,
    'VALIDATION_ERROR');
  const quiet = currentQuietWindow();
  assert.deepEqual((await planner(owner, { quietHours: quiet })).quietHours, quiet);
  await delay(1250);
  assert.deepEqual(await list(owner), []);

  await planner(owner, { timeZone: 'Etc/GMT+12' });
  const first = await advice(owner, 'review_upcoming');
  assert.deepEqual(await list(outsider), []);
  await dismiss(outsider, first.id, 404);
  await dismiss(owner, first.id);
  await dismiss(owner, first.id);
  await planner(owner, { timeZone: 'Etc/GMT+12', notification: 'silent' });
  await planner(owner, { timeZone: 'Etc/GMT+12' });
  await delay(1250);
  assert.deepEqual(await list(owner), []);

  await planner(owner, { timeZone: 'Pacific/Kiritimati' });
  const nextDay = await advice(owner, 'review_upcoming');
  assert.notEqual(nextDay.id, first.id);
  assert.equal((await request(reminders + '/' + normal.id, 200, { actor: owner })).state, 'active');
  await request(reminders + '/' + normal.id, 200, { actor: owner, method: 'PATCH',
    body: { active: false } });
  assert.deepEqual(await list(owner), []);
  const nextMinute = Math.ceil((Date.now() + 12_000) / 60_000) * 60_000;
  const arriving = await calendar(owner, nextMinute);
  const delivery = (await waitFor(() => request(occurrences + '?reminderId=' + arriving.id, 200,
    { actor: owner }), ({ items }) => items.some(({ outcome }) => outcome === 'delivered'),
    'Existing calendar engine did not deliver its scoped reminder.', 90_000)).items[0];
  await change(owner, { enabled: true, role: 'reminder_review', notification: 'in_app' });
  await advice(owner, 'review_reminders');
  const read = await request(occurrences + '/' + delivery.id, 200, { actor: owner, method: 'PATCH',
    body: { read: true } });
  assert.ok(read.readAt);
  assert.deepEqual(await list(owner), []);
  await change(owner, { enabled: false, role: 'reminder_review', notification: 'in_app' });
  assert.deepEqual(await list(owner), []);
  console.log(JSON.stringify({ optInAndRoles: true, quietAndSilentNoSuggestion: true,
    sameDayDismissalAndNewLocalDay: true, sourcePauseAndReadInvalidate: true,
    actualCalendarDeliveryUnaffected: true, scopedAuthIsolated: true }));
}
