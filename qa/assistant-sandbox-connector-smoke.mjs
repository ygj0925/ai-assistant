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
const connector = '/automations/sandbox-connector';
const authorizationPath = connector + '/authorization';
const collection = connector + '/actions';
const actionPath = (id) => collection + '/' + id;
const disconnected = { state: 'disconnected' };

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
  if (path.startsWith(connector)) assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  return data;
}

async function register() {
  const credentials = {
    username: 'qa-effects-' + randomUUID().slice(0, 10),
    password: 'Qa.Connector-' + randomUUID(),
  };
  const { accessToken, user } = await request('/auth/register', 201, { method: 'POST', body: credentials });
  return { token: accessToken, id: user.id, workspace: user.workspaceId, credentials };
}

async function capability(owner, available) {
  const { capabilities } = await request('/capabilities', 200, { actor: owner });
  assert.equal(capabilities.find(({ id }) => id === 'sandbox_connector')?.available, available);
}

function authorize(actor, expected = 200, body = { confirm: true }) {
  return request(authorizationPath, expected, { actor, method: 'POST', body });
}

function revoke(actor, id, expected = 204) {
  return request(authorizationPath + '/' + id, expected, { actor, method: 'DELETE' });
}

function create(actor, authorizationId, simulation, key = randomUUID(), expected = 201) {
  return request(collection, expected, { actor, method: 'POST', key,
    body: { authorizationId, kind: 'fixture_notice', simulation } });
}

function approve(actor, action, expected = 202, revision = action.approvalRevision) {
  return request(actionPath(action.id) + '/approve', expected, {
    actor, method: 'POST', body: { confirm: true, approvalRevision: revision },
  });
}

function get(actor, action, expected = 200) {
  return request(actionPath(action.id), expected, { actor });
}

function transition(actor, action, command, expected = 200) {
  return request(actionPath(action.id) + '/' + command, expected, { actor, method: 'POST' });
}

async function waitFor(actor, action, state) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const stored = await get(actor, action);
    if (stored.state === state) return stored;
    await delay(55);
  }
  assert.fail('Action did not reach ' + state);
}

async function mark(name, object) {
  const path = join(evidence, name + '.json');
  await writeFile(path + '.tmp', JSON.stringify(object) + '\n', { flag: 'wx' });
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
  assert.fail('Fixture did not create ' + name);
}

function confirmedReceipt(action) {
  assert.equal(action.state, 'completed');
  assert.deepEqual(Object.keys(action.result).sort(), ['kind', 'recordedAt']);
  assert.equal(action.result.kind, 'fixture_receipt');
  assert.ok(Number.isFinite(Date.parse(action.result.recordedAt)));
}

await request(authorizationPath, 401);
const owner = await register();
await capability(owner, mode !== 'disabled');
assert.deepEqual(await request(authorizationPath, 200, { actor: owner }), disconnected);
assert.equal((await authorize(owner, 400, { confirm: false })).code, 'VALIDATION_ERROR');
if (mode === 'workspace') {
  const organization = await register();
  const setup = { workspaceId: organization.workspace, ownerId: organization.id, memberId: owner.id };
  await mark('membership-needed', setup);
  await waitForMark('membership-added');
  const member = { ...owner, workspace: organization.workspace };
  const grant = (await authorize(member)).authorizationId;
  const stale = await create(member, grant, 'acknowledged');
  const leavePath = '/auth/workspaces/' + member.workspace;
  const preview = await request(leavePath + '/leave-preview', 200, { actor: member });
  await request(leavePath + '/leave', 204, {
    actor: member, method: 'POST', body: { confirm: true, membershipRevision: preview.membershipRevision },
  });
  await get(member, stale, 403);
  assert.deepEqual(await request(authorizationPath, 200, { actor: owner }), disconnected);
  await mark('rejoin-needed', setup);
  await waitForMark('rejoin-added');
  const latest = await request(leavePath + '/leave-preview', 200, { actor: member });
  assert.notEqual(latest.membershipRevision, preview.membershipRevision);
  await get(member, stale, 404);
  await approve(member, stale, 404);
  await revoke(member, grant, 404);
  const freshGrant = (await authorize(member)).authorizationId;
  assert.notEqual(freshGrant, grant);
  const renewed = await create(member, freshGrant, 'acknowledged');
  await approve(member, renewed);
  confirmedReceipt(await waitFor(member, renewed, 'completed'));
  await mark('summary', { membershipDepartureBlockedOldApproval: true, renewedMembershipNeedsNewAuthorization: true,
    verifiedFreshScopedReceipt: true, staleId: stale.id, newId: renewed.id });
} else if (mode === 'disabled') {
  assert.equal((await authorize(owner, 403)).code, 'CAPABILITY_UNAVAILABLE');
  assert.equal((await create(owner, randomUUID(), 'acknowledged', randomUUID(), 403)).code, 'CAPABILITY_UNAVAILABLE');
  assert.deepEqual(await request(collection, 200, { actor: owner }), { items: [], nextCursor: null });
  console.log(JSON.stringify({ disabledCannotAuthorizeOrCreate: true, scopedEmptyStatusRemainsReadable: true }));
} else {
  const { authorizationId: id } = await authorize(owner);
  assert.equal((await authorize(owner)).authorizationId, id);
  const key = randomUUID();
  const unknown = await create(owner, id, 'ack_lost', key);
  assert.equal(unknown.state, 'awaiting_approval');
  assert.equal(unknown.result, undefined);
  assert.deepEqual(await create(owner, id, 'ack_lost', key), unknown);
  assert.equal((await create(owner, id, 'acknowledged', key, 409)).code, 'CONFLICT');
  const negative = await request(collection, 400, { actor: owner, method: 'POST', key: randomUUID(),
    body: { authorizationId: id, kind: 'external', simulation: 'acknowledged' } });
  assert.equal(negative.code, 'VALIDATION_ERROR');
  assert.equal((await approve(owner, unknown, 409, randomUUID())).code, 'APPROVAL_CHANGED');
  assert.equal((await get(owner, unknown)).state, 'awaiting_approval');
  const blocked = await create(owner, id, 'acknowledged');
  const cancelled = await create(owner, id, 'acknowledged');
  const orphanKey = randomUUID();
  if (mode === 'restore') {
    await mark('snapshot-ready', { unknownId: unknown.id, blockedId: blocked.id,
      cancelledId: cancelled.id, originalAuthorization: id });
    await waitForMark('snapshot-done');
  }
  const accepted = await approve(owner, unknown);
  assert.ok(['approved', 'pending_result'].includes(accepted.state));
  const uncertainty = await waitFor(owner, unknown, 'pending_result');
  assert.equal(uncertainty.result, undefined);
  assert.equal((await approve(owner, unknown)).state, 'pending_result');
  assert.equal((await transition(owner, unknown, 'cancel', 409)).code, 'ACTION_IN_DOUBT');

  let orphan;
  if (mode === 'restore') {
    orphan = await create(owner, id, 'acknowledged', orphanKey);
    await approve(owner, orphan);
    confirmedReceipt(await waitFor(owner, orphan, 'completed'));
  }
  assert.equal((await transition(owner, cancelled, 'cancel')).state, 'cancelled');
  await revoke(owner, id);
  await revoke(owner, id);
  assert.deepEqual(await request(authorizationPath, 200, { actor: owner }), disconnected);
  assert.equal((await get(owner, blocked)).state, 'blocked');
  assert.equal((await approve(owner, blocked, 409)).code, 'CONNECTOR_AUTHORIZATION_CHANGED');
  assert.equal((await create(owner, id, 'acknowledged', randomUUID(), 409)).code, 'CONNECTOR_AUTHORIZATION_CHANGED');
  const outsider = await register();
  await get(outsider, unknown, 404);
  await revoke(outsider, id, 404);
  assert.deepEqual(await request(collection, 200, { actor: outsider }), { items: [], nextCursor: null });

  if (mode === 'restore') {
    await mark('revoke-ready', { unknownId: unknown.id, blockedId: blocked.id,
      cancelledId: cancelled.id, orphanId: orphan.id, originalAuthorization: id });
    await waitForMark('database-switched');
    origin = restored;
    assert.deepEqual(await request(authorizationPath, 200, { actor: owner }), disconnected);
    assert.equal((await get(owner, unknown)).state, 'pending_result');
    assert.equal((await get(owner, blocked)).state, 'blocked');
    assert.equal((await get(owner, cancelled)).state, 'cancelled');
    await get(owner, orphan, 404);
    confirmedReceipt(await transition(owner, unknown, 'reconcile'));
    const { authorizationId: renewed } = await authorize(owner);
    assert.notEqual(renewed, id);
    assert.equal((await create(owner, renewed, 'acknowledged', orphanKey, 409)).code, 'OPERATION_RESTORED');
    const confirmed = await transition(owner, unknown, 'reconcile');
    confirmedReceipt(confirmed);
    await mark('summary', { priorApprovalRestoreRemainsUncertainUntilQuery: true,
      authenticatedQueryConverges: true, duplicatePreCreationBackupKeyRejected: true,
      withdrawnAuthorizationDidNotReviveApproval: true, cancelledWasNotDispatched: true,
      completedAndUnknownEffectsNeverBlindlyRedispatched: true });
  } else {
    const otherGrant = (await authorize(outsider)).authorizationId;
    const bounded = [];
    for (let i = 0; i < 8; i++) bounded.push(await create(outsider, otherGrant, 'acknowledged'));
    assert.equal((await create(outsider, otherGrant, 'acknowledged', randomUUID(), 429)).code, 'RATE_LIMITED');
    assert.equal((await transition(outsider, bounded[0], 'cancel')).state, 'cancelled');
    assert.equal((await create(outsider, otherGrant, 'acknowledged')).state, 'awaiting_approval');
    await request('/privacy/account-erasure', 204, { actor: outsider, method: 'POST',
      body: { currentPassword: outsider.credentials.password, confirmation: 'DELETE' } });
    await get(outsider, bounded[0], 401);
    const outcome = await transition(owner, unknown, 'reconcile');
    confirmedReceipt(outcome);
    assert.deepEqual(await transition(owner, unknown, 'reconcile'), outcome);
    assert.deepEqual(await get(owner, unknown), outcome);
    const { authorizationId: renewed } = await authorize(owner);
    assert.notEqual(renewed, id);
    const known = await create(owner, renewed, 'acknowledged');
    await approve(owner, known);
    confirmedReceipt(await waitFor(owner, known, 'completed'));
    const first = await request(collection + '?limit=2', 200, { actor: owner });
    const second = await request(collection + '?limit=2&cursor=' + first.nextCursor, 200, { actor: owner });
    assert.equal(new Set([...first.items, ...second.items].map(({ id }) => id)).size, 4);
    assert.equal(second.nextCursor, null);
    console.log(JSON.stringify({ approvedEffectRequiresExactReview: true, crossAccountDenied: true,
      revokedPreDispatchBlocksEffect: true, uncertainResultRequiresAuthority: true,
      repeatsConvergeToOneResult: true, knownAcknowledgementCompletes: true, scopedPageStable: true,
      pendingBudgetAndErasure: true }));
  }
}
