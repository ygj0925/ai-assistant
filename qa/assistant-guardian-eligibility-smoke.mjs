import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [source, folder, target] = process.argv.slice(2);
const operator = { token: process.env.ASSISTANT_TEST_GUARDIAN_OPERATOR_TOKEN };
const workspace = process.env.ASSISTANT_TEST_GUARDIAN_WORKSPACE;
const owner = { token: process.env.ASSISTANT_TEST_GUARDIAN_OWNER_TOKEN, workspace };
assert.ok(operator.token && owner.token && workspace && folder);
const evidence = resolve(folder);
await mkdir(evidence, { recursive: true });
const actors = [];
const enrollmentPath = '/system/assistant/eligibility/workspaces/' + workspace + '/enrollments';
const connector = '/automations/sandbox-connector';
const events = '/automations/event-reminders';
const decisions = '/eligibility/guardian/consents';

function loopback(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.port && url.port !== '18080' && url.pathname === '/' && !url.username && !url.password
    && !url.search && !url.hash, 'Use the dedicated synthetic loopback fixture.');
  return url;
}

let origin = loopback(source);
const recovered = loopback(target);
assert.notEqual(origin.port, recovered.port);

async function api(route, status, { actor, method = 'GET', body, key, platform = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) headers.Authorization = 'Bearer ' + actor.token;
  if (actor?.workspace) headers['X-Workspace-Id'] = actor.workspace;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(new URL((platform ? '' : '/api/assistant/v1') + route, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  const value = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  const expected = Array.isArray(status) ? status : [status];
  assert.ok(expected.includes(response.status), method + ' ' + route + ' HTTP ' + response.status + ' ' + (value?.code ?? ''));
  if (route.startsWith('/eligibility') || route.startsWith(connector)) {
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  }
  return value;
}

async function register() {
  const credentials = { username: 'qa-guardian-' + randomUUID().slice(0, 10), password: 'Qa.Guardian!' + randomUUID() };
  const { user, accessToken } = await api('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { id: user.id, token: accessToken, workspace: user.workspaceId, credentials };
  actors.push(actor);
  return actor;
}

async function poll(probe, accepts, failure, maxWait = 20_000) {
  const deadline = Date.now() + maxWait;
  while (Date.now() < deadline) {
    const value = await probe();
    if (accepts(value)) return value;
    await delay(100);
  }
  assert.fail(failure);
}

async function mark(name) {
  const path = join(evidence, name);
  await writeFile(path + '.tmp', '{}\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

function wait(name) {
  return poll(async () => {
    try { await access(join(evidence, name)); return true; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
  }, Boolean, 'Missing QA checkpoint ' + name, 300_000);
}

function invite(actor) {
  return api('/organizations/current/members', 201, { actor: owner, method: 'POST',
    body: { accountId: actor.id, role: 'member', confirm: true } });
}

function status(actor) {
  return api('/eligibility', 200, { actor });
}

async function allowed(actor, capability, expected) {
  const { capabilities } = await api('/capabilities', 200, { actor });
  assert.equal(capabilities.find(({ id }) => id === capability)?.available, expected, capability);
}

function enrollment(actor, participantAccountId, guardianAccountId, scenario, expected = 201) {
  return api(enrollmentPath, expected, { actor, method: 'POST', platform: true,
    body: { participantAccountId, guardianAccountId, scenario, confirm: true } });
}

function checkConsent(value, expected, expires = false) {
  assert.equal(value.status, expected);
  const keys = ['id', 'revision', 'status'];
  if (expires) {
    keys.push('expiresAt');
    assert.ok(Number.isFinite(Date.parse(value.expiresAt)));
  }
  assert.deepEqual(Object.keys(value).sort(), keys.sort());
}

function decide(actor, consent, authorize, expected = 200, confirm = true) {
  return api(decisions + '/' + consent.id, expected, { actor, method: 'PUT',
    body: { authorize, confirm, revision: consent.revision } });
}

function connect(actor, expected = 200) {
  return api(connector + '/authorization', expected, { actor, method: 'POST', body: { confirm: true } });
}

function draft(actor, authorizationId, expected = 201) {
  return api(connector + '/actions', expected, { actor, method: 'POST', key: randomUUID(),
    body: { authorizationId, kind: 'fixture_notice', simulation: 'acknowledged' } });
}

function approval(actor, action, expected = 202) {
  return api(connector + '/actions/' + action.id + '/approve', expected, { actor, method: 'POST',
    body: { confirm: true, approvalRevision: action.approvalRevision } });
}

function actionStatus(actor, action) {
  return api(connector + '/actions/' + action.id, 200, { actor });
}

function receipt(actor, authId, action, expected = 200) {
  return api(events + '/receive', expected, { actor, method: 'POST',
    body: { operationId: action.id, authorizationId: authId } });
}

async function erase(actor) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(new URL('/api/assistant/v1/privacy/account-erasure', origin), {
      method: 'POST', headers: { Authorization: 'Bearer ' + actor.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: actor.credentials.password, confirmation: 'DELETE' }),
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 204 || res.status === 401) return;
    assert.equal(res.status, 429, 'Unexpected test account cleanup status.');
    const retry = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    if (attempt < 2) await delay(Number.isFinite(retry) ? Math.min(60, Math.max(1, retry)) * 1000 : 60_000);
  }
  assert.fail('Synthetic guardian account cleanup remained throttled.');
}

let result;
try {
  await api('/eligibility', 401);
  const subjectPersonal = await register();
  const guardianPersonal = await register();
  const outsidePersonal = await register();
  await invite(subjectPersonal);
  const originalGuardianMembership = await invite(guardianPersonal);
  await invite(outsidePersonal);
  const subject = { ...subjectPersonal, workspace };
  const guardian = { ...guardianPersonal, workspace };
  const outside = { ...outsidePersonal, workspace };
  assert.deepEqual(await status(subjectPersonal), { applicable: false, connectorStatus: 'allowed' });
  await allowed(subjectPersonal, 'sandbox_connector', true);
  const legacy = await connect(subjectPersonal);
  const ordinary = await draft(subjectPersonal, legacy.authorizationId);
  await approval(subjectPersonal, ordinary);
  const earlier = await poll(() => actionStatus(subjectPersonal, ordinary),
    (row) => row.state === 'completed', 'Ordinary personal simulator receipt missing.');
  assert.equal(earlier.result.kind, 'fixture_receipt');
  assert.deepEqual(await status(subject), { applicable: true, connectorStatus: 'not_enrolled' });
  assert.equal((await connect(subject, 403)).code, 'ELIGIBILITY_REQUIRED');
  await allowed(subject, 'local_guardian_eligibility', false);
  await mark('before-ready');
  await wait('before-done');

  await enrollment(subject, subject.id, guardian.id, 'guardian_required', [401, 403]);
  await enrollment(operator, subject.id, subject.id, 'guardian_required', 400);
  const enrollmentRow = await enrollment(operator, subject.id, guardian.id, 'guardian_required');
  const outsideRow = await enrollment(operator, outside.id, guardian.id, 'outside_fixture_region');
  assert.deepEqual(await enrollment(operator, subject.id, guardian.id, 'guardian_required'), enrollmentRow);
  checkConsent(enrollmentRow, 'guardian_required');
  checkConsent(outsideRow, 'outside_fixture_region');
  await allowed(subject, 'local_guardian_eligibility', true);
  await allowed(guardian, 'local_guardian_eligibility', true);
  await allowed(subject, 'sandbox_connector', false);
  assert.deepEqual(await api(decisions, 200, { actor: subject }), { items: [] });
  assert.equal((await api(decisions, 200, { actor: guardian })).items.length, 2);
  await decide(subject, enrollmentRow, true, 404);
  await decide(guardianPersonal, enrollmentRow, true, 403);
  await decide(guardian, enrollmentRow, true, 400, false);
  assert.equal((await decide(guardian, outsideRow, true, 403)).code, 'ELIGIBILITY_REQUIRED');
  assert.deepEqual(await status(outside), { applicable: true, connectorStatus: 'outside_fixture_region' });
  assert.equal((await connect(outside, 403)).code, 'ELIGIBILITY_REQUIRED');

  const approved = await decide(guardian, enrollmentRow, true);
  assert.notEqual(approved.revision, enrollmentRow.revision);
  checkConsent(approved, 'allowed', true);
  assert.deepEqual(await decide(guardian, approved, true), approved, 'Repeated assent must retain exact expiry.');
  assert.equal((await decide(guardian, enrollmentRow, false, 409)).code, 'ELIGIBILITY_CHANGED');
  await allowed(subject, 'sandbox_connector', true);
  const authId = (await connect(subject)).authorizationId;
  const subscription = await api(events, 201, { actor: subject, method: 'POST',
    body: { authorizationId: authId, eventKind: 'fixture_notice_recorded', title: 'Guardian consent fixture', timeZone: 'UTC' } });
  assert.ok(subscription.id);
  const executed = await draft(subject, authId);
  await approval(subject, executed);
  const completed = await poll(() => actionStatus(subject, executed),
    (row) => row.state === 'completed', 'Approved synthetic effect never reached the ledger.');
  assert.equal(completed.result.kind, 'fixture_receipt');
  assert.equal((await receipt(subject, authId, executed)).scheduled, 1);
  const pending = await draft(subject, authId);
  await mark('active-ready');
  await wait('active-done');

  const revoked = await decide(guardian, approved, false);
  checkConsent(revoked, 'guardian_required');
  assert.equal((await approval(subject, pending, 403)).code, 'ELIGIBILITY_REQUIRED');
  assert.equal((await actionStatus(subject, pending)).state, 'blocked');
  assert.equal((await receipt(subject, authId, executed, 403)).code, 'ELIGIBILITY_REQUIRED');
  const fresh = await decide(guardian, revoked, true);
  assert.equal((await approval(subject, pending, 403)).code, 'ELIGIBILITY_REQUIRED');
  await receipt(subject, authId, executed, 404);
  await poll(() => status(subject), (value) => value.connectorStatus === 'consent_expired',
    'No real elapsed-time consent expiry was observed.', 45_000);
  assert.ok(Date.parse(fresh.expiresAt) <= Date.now());
  assert.equal((await draft(subject, authId, 403)).code, 'ELIGIBILITY_REQUIRED');
  await mark('cutover-ready');
  await wait('restored-active');

  origin = recovered;
  assert.deepEqual(await status(subject), { applicable: true, connectorStatus: 'guardian_required' });
  assert.equal((await approval(subject, pending, 403)).code, 'ELIGIBILITY_REQUIRED');
  assert.equal((await actionStatus(subject, pending)).state, 'blocked');
  assert.equal((await connect(subject, 403)).code, 'ELIGIBILITY_REQUIRED');
  const projected = (await api(decisions, 200, { actor: guardian })).items.find(({ id }) => id === enrollmentRow.id);
  assert.equal(projected.revision, approved.revision);
  checkConsent(projected, 'guardian_required');
  const replacement = await decide(guardian, projected, true);
  assert.notEqual(replacement.revision, approved.revision);
  assert.equal((await approval(subject, pending, 403)).code, 'ELIGIBILITY_REQUIRED');
  const current = await draft(subject, authId);
  await approval(subject, current);
  await poll(() => actionStatus(subject, current), (row) => row.state === 'completed',
    'Fresh approved generation did not reach the bound ledger.');
  await api('/auth/workspaces/' + workspace + '/leave', 204, {
    actor: guardian, method: 'POST',
    body: { membershipRevision: originalGuardianMembership.membershipRevision, confirm: true },
  });
  assert.deepEqual(await status(subject), { applicable: true, connectorStatus: 'not_enrolled' });
  assert.notEqual((await invite(guardianPersonal)).membershipRevision, originalGuardianMembership.membershipRevision);
  assert.equal((await connect(subject, 403)).code, 'ELIGIBILITY_REQUIRED');
  await mark('pre-cutover');
  await wait('restored-before');

  assert.deepEqual(await status(subject), { applicable: true, connectorStatus: 'not_enrolled' });
  await allowed(subject, 'sandbox_connector', false);
  await allowed(subject, 'local_guardian_eligibility', false);
  assert.equal((await connect(subject, 403)).code, 'ELIGIBILITY_REQUIRED');
  assert.deepEqual(await status(subjectPersonal), { applicable: false, connectorStatus: 'allowed' });
  await allowed(subjectPersonal, 'sandbox_connector', true);
  result = {
    result: 'synthetic_guardian_eligibility_verified', explicitPlatformAndGuardian: true,
    foreignRoleAndSyntheticRegionDenied: true, boundedStickyConsent: true, scopedActualEffect: true,
    exactSourceOnReminderIntake: true, oldConsentRevocationRestore: true,
    guardianMembershipReturnKeepsConsentRevoked: true, preEnrollmentRestoreHeldWithControlsOff: true,
    ordinaryPersonalUnaffected: true,
  };
} finally {
  const cleanup = await Promise.allSettled(actors.map(erase));
  for (const record of cleanup) {
    if (record.status === 'rejected') {
      console.error(record.reason.message);
      process.exitCode = 1;
    }
  }
}
if (!process.exitCode) console.log(JSON.stringify(result));
