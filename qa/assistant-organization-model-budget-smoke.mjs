import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [server, mode, directory, oldTarget, recoveredTarget] = process.argv.slice(2);
assert.ok(['restore', 'default'].includes(mode));
assert.ok(directory);
const evidence = resolve(directory);
const budgetRoute = '/organizations/current/model-budget';
const fallbackRevision = '00000000-0000-0000-0000-000000000000';
const recoveryCode = 'ORGANIZATION_BUDGET_RECOVERY_REQUIRED';
const exhaustedCode = 'ORGANIZATION_BUDGET_EXHAUSTED';
const reserve = 8192;
const cap = reserve * 2;

function local(raw) {
  const url = new URL(raw);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.port && !['18080', '18090'].includes(url.port) && url.href === url.origin + '/',
  'Use only isolated loopback budget fixtures.');
  return url;
}

let origin = local(server);
const old = mode === 'restore' ? local(oldTarget) : null;
const recovered = mode === 'restore' ? local(recoveredTarget) : null;
if (old) assert.equal(new Set([origin.origin, old.origin, recovered.origin]).size, 3);
await mkdir(evidence, { recursive: true });

async function call(path, expected, { actor, method = 'GET', body, rawJson, key, platform = false, code } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor?.token) headers.Authorization = 'Bearer ' + actor.token;
  if (actor?.workspace) headers['X-Workspace-Id'] = actor.workspace;
  if (key) headers['Idempotency-Key'] = key;
  if (body !== undefined || rawJson !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL((platform ? '' : '/api/assistant/v1') + path, origin), {
    method, headers, body: rawJson ?? (body === undefined ? undefined : JSON.stringify(body)),
    redirect: 'error', signal: AbortSignal.timeout(12_000),
  });
  const value = response.status === 204 ? undefined : await response.json().catch(() => null);
  if (Array.isArray(expected)) assert.ok(expected.includes(response.status), method + ' ' + path);
  else assert.equal(response.status, expected, method + ' ' + path + ' ' + (value?.code ?? ''));
  if (path === budgetRoute) assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  if (code) assert.equal(value.code, code);
  return { status: response.status, value };
}

async function register() {
  const credentials = { username: 'qa-orgbudget-' + randomUUID().slice(0, 10),
    password: 'Qa.OrgBudget!' + randomUUID() };
  const { value } = await call('/auth/register', 201, { method: 'POST', body: credentials });
  return { token: value.accessToken, id: value.user.id, workspace: value.user.workspaceId };
}

async function mark(name, value) {
  const path = join(evidence, name + '.json');
  await writeFile(path + '.tmp', JSON.stringify(value) + '\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

async function until(check, complete, label, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (complete(value)) return value;
    await delay(100);
  }
  assert.fail(label);
}

function waitFor(name) {
  const path = join(evidence, name + '.json');
  return until(() => access(path).then(() => true, failure => {
    if (failure.code !== 'ENOENT') throw failure;
    return false;
  }), Boolean, 'Fixture marker missing: ' + name, 240_000);
}

const newRoom = async actor => (await call('/conversations', 201, { actor, method: 'POST',
  body: { title: 'Scoped synthetic model budget' } })).value;
const getRun = async (actor, id) => (await call('/runs/' + id, 200, { actor })).value;
const cancel = async (actor, id) => (await call('/runs/' + id + '/cancel', 200, { actor, method: 'POST' })).value;
const start = (actor, room, content, expected = 202, key = randomUUID(), code) =>
  call('/conversations/' + room.id + '/runs', expected, { actor, method: 'POST', key, code,
    body: { action: 'send', content, modelId: 'local-echo' } });
const startTemp = (actor, expected = 200, code) => call('/temporary-chat', expected,
  { actor, method: 'POST', body: { content: '合成临时对照' }, code });
const budget = async (actor, expected = 200, code) => (await call(budgetRoute, expected, { actor, code })).value;
const decide = async (actor, baseRevision, monthlyLimitUnits, expected = 200, code) =>
  (await call(budgetRoute, expected, { actor, method: 'PUT', code,
    body: { baseRevision, monthlyLimitUnits, confirm: true } })).value;
const terminal = (actor, id) => until(() => getRun(actor, id),
  run => ['completed', 'cancelled', 'failed'].includes(run.state), 'Synthetic ledger run did not settle');
const usage = async actor => (await call('/usage', 200, { actor })).value;
const capability = async (actor, id, wanted) => {
  const { value } = await call('/capabilities', 200, { actor });
  assert.equal(value.capabilities.find(item => item.id === id)?.available, wanted, id);
};

if (mode === 'default') {
  const home = await register();
  await capability(home, 'organization_model_budget', false);
  await budget(home, 403, 'CAPABILITY_UNAVAILABLE');
  const room = await newRoom(home);
  const { value: accepted } = await start(home, room, 'Standalone personal synthetic test');
  assert.equal((await terminal(home, accepted.runId)).state, 'completed');
  await startTemp(home);
  await mark('summary', { mode, noProvisionedBudgetFileRequired: true, personalRunAndTemporaryChatWorked: true });
} else {
  const token = process.env.ASSISTANT_TEST_ORG_OPERATOR_TOKEN;
  assert.ok(token, 'An actual platform operator token from the isolated fixture is required.');
  const home = await register();
  const others = [await register(), await register()];
  const { value: organization } = await call('/system/assistant/organizations', 201, {
    actor: { token }, method: 'POST', platform: true, key: randomUUID(),
    body: { ownerAccountId: home.id, name: '合成组织月度模型额度', seatLimit: 8, confirm: true },
  });
  const owner = { ...home, workspace: organization.workspaceId };
  const members = others.map(member => ({ ...member, workspace: owner.workspace }));
  await Promise.all(members.map(member => call('/organizations/current/members', 201, {
    actor: owner, method: 'POST', body: { accountId: member.id, role: 'member', confirm: true },
  })));
  await capability(owner, 'organization_model_budget', true);
  await capability(members[0], 'organization_model_budget', false);
  await call(budgetRoute, 401);
  await budget(members[0], 403);
  await decide(members[1], fallbackRevision, cap, 403);
  const initial = await budget(owner);
  assert.equal(initial.revision, fallbackRevision);
  assert.equal(initial.monthlyLimitUnits, null);
  assert.equal(initial.availableUnits, null);
  assert.equal(initial.updatedAt, null);
  assert.equal(initial.timeZone, 'UTC');
  assert.equal(initial.unit, 'output_code_points');
  assert.match(initial.monthStart, /\-01T00:00:00Z$/);
  assert.match(initial.monthEndExclusive, /\-01T00:00:00Z$/);
  for (const wrong of [true, '16', 12.5, -1, 1_000_000_001]) {
    await decide(owner, initial.revision, wrong, 400, 'VALIDATION_ERROR');
  }
  await call(budgetRoute, 400, { actor: owner, method: 'PUT', code: 'VALIDATION_ERROR',
    body: { baseRevision: initial.revision, confirm: true } });
  await call(budgetRoute, 400, { actor: owner, method: 'PUT', code: 'VALIDATION_ERROR',
    rawJson: JSON.stringify({ baseRevision: initial.revision, confirm: true, monthlyLimitUnits: 0 })
      .slice(0, -1) + ',"monthlyLimitUnits":null}' });
  await call(budgetRoute, 400, { actor: owner, method: 'PUT', code: 'VALIDATION_ERROR',
    body: { baseRevision: initial.revision, confirm: false, monthlyLimitUnits: 0 } });
  const rooms = await Promise.all(members.map(newRoom));
  const zero = await decide(owner, initial.revision, 0);
  assert.equal(zero.monthlyLimitUnits, 0);
  assert.equal(zero.availableUnits, 0);
  await start(members[0], rooms[0], 'Zero denies any new reservation', 429, randomUUID(), exhaustedCode);
  assert.equal((await usage(members[0])).reserved, 0);
  await startTemp(members[0], 403, 'ORGANIZATION_BUDGET_TEMPORARY_UNSUPPORTED');
  await capability(members[0], 'temporary_chat', false);
  await decide(owner, initial.revision, cap, 409, 'ORGANIZATION_BUDGET_CHANGED');
  const uncapped = await decide(owner, zero.revision, null);
  assert.equal(uncapped.monthlyLimitUnits, null);
  assert.equal(uncapped.availableUnits, null);
  await startTemp(members[0]);
  const finite = await decide(owner, uncapped.revision, cap);
  assert.equal(finite.monthlyLimitUnits, cap);
  assert.equal(finite.availableUnits, cap);
  assert.ok(finite.updatedAt);
  await startTemp(members[1], 403, 'ORGANIZATION_BUDGET_TEMPORARY_UNSUPPORTED');
  const audit = (await call('/organizations/current/audit', 200, { actor: owner })).value;
  assert.equal(audit.items.filter(row => row.action === 'model_budget_changed').length, 3);

  const blockerRoom = await newRoom(home);
  const { value: blocker } = await start(home, blockerRoom, '合成占位，等待组织测试快照。'.repeat(24));
  await until(() => getRun(home, blocker.runId), run => run.state === 'running',
    'Personal synthetic worker did not occupy the test slot');
  const ownerRoom = await newRoom(owner);
  const { value: oldQueue } = await start(owner, ownerRoom, 'Confirmed original pending synthetic model run');
  assert.equal((await getRun(owner, oldQueue.runId)).state, 'queued');
  const firstHold = await budget(owner);
  assert.equal(firstHold.reservedUnits, reserve);
  assert.equal(firstHold.settledUnits, 0);
  assert.equal(firstHold.availableUnits, reserve);
  await mark('snapshot-ready', { workspaceId: owner.workspace, ownerId: owner.id,
    queuedRunId: oldQueue.runId, blockerId: blocker.runId, revision: finite.revision });
  await waitFor('snapshot-done');

  const raceKey = randomUUID();
  const payload = '组织内并发合成对照。';
  const results = await Promise.all(members.map((actor, index) => start(actor, rooms[index],
    payload, [202, 429], raceKey)));
  assert.deepEqual(results.map(row => row.status).sort((a, b) => a - b), [202, 429]);
  const winner = results.findIndex(row => row.status === 202);
  const loser = 1 - winner;
  const won = results[winner].value;
  assert.equal(results[loser].value.code, exhaustedCode);
  const held = await budget(owner);
  assert.equal(held.reservedUnits, cap);
  assert.equal(held.availableUnits, 0);
  assert.equal(held.revision, finite.revision);
  assert.equal((await start(members[winner], rooms[winner], payload, 202, raceKey)).value.runId, won.runId);
  assert.equal((await budget(owner)).reservedUnits, cap);
  await start(members[winner], rooms[winner], 'different request', 409, raceKey, 'CONFLICT');
  assert.equal((await cancel(owner, oldQueue.runId)).state, 'cancelled');
  assert.equal((await cancel(members[winner], won.runId)).state, 'cancelled');
  assert.equal((await budget(owner)).reservedUnits, 0);
  assert.equal((await budget(owner)).settledUnits, 0);
  await cancel(home, blocker.runId);

  const { value: retry } = await start(members[loser], rooms[loser], '本地额度结算。', 202, raceKey);
  const completed = await terminal(members[loser], retry.runId);
  assert.equal(completed.state, 'completed');
  const used = [...completed.content].length;
  assert.ok(used > 0 && used < reserve);
  const charged = await budget(owner);
  assert.equal(charged.settledUnits, used);
  assert.equal(charged.reservedUnits, 0);
  assert.equal(charged.availableUnits, cap - used);
  assert.equal((await usage(members[loser])).used, used);
  await mark('source-done', { concurrentReservations: 1, keptPriorCapRevision: true,
    chargeAfterRelease: used, acceptedLaterRunId: retry.runId });
  await waitFor('restore-done');

  origin = old;
  await budget(owner, 503, recoveryCode);
  await start(members[1], rooms[1], 'An old database cannot authorize this reservation', 503, randomUUID(), recoveryCode);
  await startTemp(members[0], 503, recoveryCode);
  const staleClaim = await terminal(owner, oldQueue.runId);
  assert.equal(staleClaim.state, 'failed');
  assert.equal(staleClaim.error.code, recoveryCode);
  assert.equal(staleClaim.content, '');
  await call('/runs/' + retry.runId, 404, { actor: members[loser] });
  await cancel(home, blocker.runId);
  await startTemp(home);
  await mark('older-confirmed', { oldQueuedDispatchDenied: true, budgetScopeDeniedAndPersonalWorked: true });
  await waitFor('valid-done');

  origin = recovered;
  const surviving = await budget(owner);
  assert.equal(surviving.revision, finite.revision);
  assert.equal(surviving.monthlyLimitUnits, cap);
  assert.equal(surviving.settledUnits, used);
  assert.equal(surviving.reservedUnits, 0);
  assert.equal((await getRun(members[loser], retry.runId)).state, 'completed');
  await mark('valid-confirmed', { matchingLedgerRecovered: true, settledUnits: used });
  await waitFor('flagoff-done');

  await capability(owner, 'organization_model_budget', false);
  await budget(owner, 403, 'CAPABILITY_UNAVAILABLE');
  await startTemp(members[0], 403, 'ORGANIZATION_BUDGET_TEMPORARY_UNSUPPORTED');
  const disabledRace = await Promise.all(members.map((actor, index) => start(actor, rooms[index],
    '作者关闭后保持额度限制。', [202, 429])));
  assert.deepEqual(disabledRace.map(row => row.status).sort((a, b) => a - b), [202, 429]);
  const disabledWinner = disabledRace.findIndex(row => row.status === 202);
  assert.equal(disabledRace[1 - disabledWinner].value.code, exhaustedCode);
  await cancel(members[disabledWinner], disabledRace[disabledWinner].value.runId);
  await mark('flagoff-confirmed', { durableCapKeptWhileAuthoringOff: true });
  await waitFor('missing-done');

  await capability(owner, 'organization_model_budget', false);
  await capability(members[0], 'temporary_chat', false);
  await budget(owner, 503, recoveryCode);
  await start(members[0], rooms[0], 'Missing guard must not create a run', 503, randomUUID(), recoveryCode);
  await startTemp(members[0], 503, recoveryCode);
  const personalRoom = await newRoom(home);
  const { value: personal } = await start(home, personalRoom, '独立个人对照。');
  assert.equal((await terminal(home, personal.runId)).state, 'completed');
  await mark('summary', { mode, strictOwnerNullAndZero: true, twoMemberAtomicReservation: true,
    repeatedKeyDidNotReserveAgain: true, cancellationReleasedBothHolds: true, settledAcceptedCodePoints: used,
    staleSameRevisionDenied: true, queuedOldLeaseDeniedBeforeModelOutput: true,
    correctLedgerRecovered: true, durableCapKeptWhileAuthoringOff: true,
    unavailableGuardDeniedOnlyOrganization: true });
}
console.log((await readFile(join(evidence, 'summary.json'), 'utf8')).trim());
