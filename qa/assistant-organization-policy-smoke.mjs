import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [server, mode = 'normal', directory, target] = process.argv.slice(2);
assert.ok(['normal', 'restore', 'toggle'].includes(mode));
assert.equal(Boolean(directory && target), mode !== 'normal');
const evidence = directory && resolve(directory);
const operatorToken = process.env.ASSISTANT_TEST_ORG_OPERATOR_TOKEN;
assert.ok(operatorToken, 'Use a real platform token from the isolated fixture process.');
const actors = [];
const policyRoute = '/organizations/current/policy';
const connector = '/automations/sandbox-connector';
const authorization = connector + '/authorization';
const actions = connector + '/actions';
const events = '/automations/event-reminders';
const localModel = 'local-echo';
const legacyModel = 'qa-retired';
const defaultRevision = '00000000-0000-0000-0000-000000000000';

function loopback(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.port && !['18080', '18090'].includes(url.port) && url.pathname === '/' && !url.username && !url.password
    && !url.search && !url.hash, 'Use the isolated synthetic loopback fixture.');
  return url;
}

let origin = loopback(server);
const restored = target && loopback(target);
assert.ok(!restored || (mode === 'toggle') === (restored.port === origin.port));
if (evidence) await mkdir(evidence, { recursive: true });

async function request(route, expected, { actor, method = 'GET', body, key, platform = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) headers.Authorization = 'Bearer ' + actor.token;
  if (actor?.workspace) headers['X-Workspace-Id'] = actor.workspace;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key !== undefined) headers['Idempotency-Key'] = key;
  const res = await fetch(new URL((platform ? '' : '/api/assistant/v1') + route, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(12_000),
  });
  const value = res.status === 204 ? undefined : await res.json().catch(() => null);
  assert.equal(res.status, expected, method + ' ' + route + ' → ' + (value?.code ?? ''));
  if (route === policyRoute) assert.match(res.headers.get('cache-control') ?? '', /\bno-store\b/);
  return value;
}

async function register() {
  const credentials = { username: 'qa-orgpol-' + randomUUID().slice(0, 10), password: 'Qa.OrgPolicy!' + randomUUID() };
  const { accessToken, user } = await request('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { token: accessToken, id: user.id, workspace: user.workspaceId, credentials };
  actors.push(actor);
  return actor;
}

async function provision(owner) {
  const { workspaceId } = await request('/system/assistant/organizations', 201, {
    actor: { token: operatorToken }, method: 'POST', platform: true, key: randomUUID(),
    body: { ownerAccountId: owner.id, name: 'Local organization policy QA', seatLimit: 3, confirm: true },
  });
  return { ...owner, workspace: workspaceId };
}

async function capability(actor, id, expected) {
  const { capabilities } = await request('/capabilities', 200, { actor });
  assert.equal(capabilities.find((value) => value.id === id)?.available, expected, id);
}

function policy(actor, status = 200) {
  return request(policyRoute, status, { actor });
}

function decide(actor, current, ids, connectorAllowed, status = 200, confirm = true) {
  return request(policyRoute, status, {
    actor, method: 'PUT',
    body: { baseRevision: current.revision, allowedModelIds: ids, sandboxConnectorAllowed: connectorAllowed, confirm },
  });
}

async function models(actor) {
  return (await request('/models', 200, { actor })).models.map(({ id }) => id);
}

function conversation(actor) {
  return request('/conversations', 201, { actor, method: 'POST', body: { title: 'Scoped policy test' } });
}

function start(actor, room, content, modelId, status = 202) {
  return request('/conversations/' + room.id + '/runs', status, {
    actor, method: 'POST', key: randomUUID(), body: { action: 'send', content, modelId },
  });
}

function getRun(actor, id) {
  return request('/runs/' + id, 200, { actor });
}

function messages(actor, room) {
  return request('/conversations/' + room.id + '/messages?limit=20', 200, { actor });
}

async function poll(probe, accepts, failure, timeout = 18_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await probe();
    if (accepts(value)) return value;
    await delay(35);
  }
  assert.fail(failure);
}

function terminal(actor, id) {
  return poll(() => getRun(actor, id), (value) => ['completed', 'failed', 'cancelled'].includes(value.state),
    'Model run did not settle.');
}

function connect(actor, status = 200) {
  return request(authorization, status, { actor, method: 'POST', body: { confirm: true } });
}

function action(actor, authorizationId, status = 201) {
  return request(actions, status, {
    actor, method: 'POST', key: randomUUID(), body: { authorizationId, kind: 'fixture_notice', simulation: 'acknowledged' },
  });
}

function approve(actor, value, status = 202) {
  return request(actions + '/' + value.id + '/approve', status, {
    actor, method: 'POST', body: { confirm: true, approvalRevision: value.approvalRevision },
  });
}

function getAction(actor, value) {
  return request(actions + '/' + value.id, 200, { actor });
}

function receive(actor, authorizationId, operationId, status = 200) {
  return request(events + '/receive', status, {
    actor, method: 'POST', body: { authorizationId, operationId },
  });
}

async function completeAction(actor, authorizationId) {
  const entry = await action(actor, authorizationId);
  await approve(actor, entry);
  return poll(() => getAction(actor, entry), (value) => value.state === 'completed', 'No simulator receipt.');
}

async function mark(name) {
  const path = join(evidence, name);
  await writeFile(path + '.tmp', '{}\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

async function waitFor(name) {
  await poll(async () => {
    try { await access(join(evidence, name)); return true; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
  }, Boolean, 'Missing ' + name, 300_000);
}

async function erase(actor) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(new URL('/api/assistant/v1/privacy/account-erasure', origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { Authorization: 'Bearer ' + actor.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: actor.credentials.password, confirmation: 'DELETE' }),
    });
    if (res.status === 204 || res.status === 401) return;
    assert.equal(res.status, 429, 'Synthetic account cleanup failed.');
    const retry = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    if (attempt < 2) await delay(Number.isFinite(retry) ? Math.min(60, Math.max(1, retry)) * 1000 : 60_000);
  }
  assert.fail('Synthetic account cleanup remained throttled.');
}

const summary = {
  result: 'local_organization_policy_verified',
  restore: mode === 'restore',
  authoringDisabled: mode === 'toggle',
};

try {
  const owner = await register();
  const orgOwner = await provision(owner);
  const personalModels = await models(owner);
  assert.ok(personalModels.includes(localModel));
  await capability(owner, 'organization_policies', false);
  await capability(orgOwner, 'organization_policies', true);
  {
    const member = await register();
    await request('/organizations/current/members', 201, {
      actor: orgOwner, method: 'POST', body: { accountId: member.id, role: 'admin', confirm: true },
    });
    const manager = { ...member, workspace: orgOwner.workspace };
    const initial = await policy(orgOwner);
    assert.deepEqual(initial, { revision: defaultRevision, allowedModelIds: null, sandboxConnectorAllowed: true,
      reviewRequired: false });
    await capability(manager, 'organization_policies', false);
    await policy(manager, 403);
    await decide(manager, initial, [], false, 403);
    assert.equal((await decide(orgOwner, initial, [], false, 400, false)).code, 'VALIDATION_ERROR');
    assert.equal((await decide(orgOwner, initial, [localModel, localModel], true, 400)).code, 'VALIDATION_ERROR');
    assert.deepEqual(await models(manager), personalModels);

    const { authorizationId } = await connect(manager);
    const staleAction = await action(manager, authorizationId);
    const rule = await request(events, 201, { actor: manager, method: 'POST',
      body: { title: 'Policy-bound event', authorizationId, eventKind: 'fixture_notice_recorded', timeZone: 'UTC' } });
    const oldEffect = await completeAction(manager, authorizationId);
    assert.equal((await receive(manager, authorizationId, oldEffect.id)).scheduled, 1);
    if (mode === 'restore') {
      await mark('backup-ready');
      await waitFor('backup-done');
    }

    const configured = await decide(orgOwner, initial, [localModel], true);
    assert.notEqual(configured.revision, initial.revision);
    assert.deepEqual(await decide(orgOwner, configured, [localModel], true), configured);
    assert.equal((await decide(orgOwner, initial, [], false, 409)).code, 'ORGANIZATION_POLICY_CHANGED');
    assert.deepEqual(await models(manager), [localModel]);
    assert.equal((await approve(manager, staleAction, 403)).code, 'ORGANIZATION_POLICY_DENIED');
    assert.equal((await getAction(manager, staleAction)).state, 'blocked');
    await receive(manager, authorizationId, oldEffect.id, 404);
    const freshEffect = await completeAction(manager, authorizationId);
    assert.equal((await receive(manager, authorizationId, freshEffect.id)).scheduled, 1);
    const oldOccurrence = await request(events + '/' + rule.id + '/occurrences', 200, { actor: manager });
    assert.ok(oldOccurrence.items.length >= 1);

    const refusedRoom = await conversation(manager);
    const allowance = await request('/usage', 200, { actor: manager });
    assert.equal((await start(manager, refusedRoom, 'Disallowed retired alias', legacyModel, 403)).code,
      'ORGANIZATION_POLICY_DENIED');
    assert.deepEqual((await messages(manager, refusedRoom)).items, []);
    const aliasOnly = await decide(orgOwner, configured, [legacyModel], true);
    assert.deepEqual(await models(manager), []);
    assert.equal((await start(manager, refusedRoom, 'Disallowed route fallback', legacyModel, 403)).code,
      'ORGANIZATION_POLICY_DENIED');
    assert.deepEqual((await messages(manager, refusedRoom)).items, []);
    assert.deepEqual(await request('/usage', 200, { actor: manager }), allowance);
    const streamPolicy = await decide(orgOwner, aliasOnly, [localModel], true);
    const longRoom = await conversation(manager);
    const running = await start(manager, longRoom, 'policy stream boundary 漢字'.repeat(45), localModel);
    await poll(() => getRun(manager, running.runId),
      (value) => value.state === 'running' && value.content.length > 0,
      'Configure bounded mock delay to observe a fragment before revocation.');
    const denied = await decide(orgOwner, streamPolicy, [], false);
    const atCutoff = await getRun(manager, running.runId);
    const failed = await terminal(manager, running.runId);
    assert.equal(failed.state, 'failed');
    assert.equal(failed.error?.code, 'ORGANIZATION_POLICY_DENIED');
    assert.equal(failed.content, atCutoff.content);
    assert.equal(failed.messageId, undefined);
    assert.deepEqual((await messages(manager, longRoom)).items.map(({ role }) => role), ['user']);
    assert.deepEqual(await models(manager), []);
    assert.equal((await start(manager, refusedRoom, 'No admitted prompt', undefined, 403)).code, 'ORGANIZATION_POLICY_DENIED');
    assert.deepEqual((await messages(manager, refusedRoom)).items, []);
    assert.equal((await connect(manager, 403)).code, 'ORGANIZATION_POLICY_DENIED');
    assert.equal((await action(manager, authorizationId, 403)).code, 'ORGANIZATION_POLICY_DENIED');
    assert.equal((await receive(manager, authorizationId, freshEffect.id, 403)).code, 'ORGANIZATION_POLICY_DENIED');
    assert.ok((await request('/organizations/current/audit', 200, { actor: orgOwner })).items
      .some(({ action, actorAccountId }) => action === 'policy_changed' && actorAccountId === owner.id));
    assert.equal((await policy(orgOwner)).revision, denied.revision);

    if (mode === 'restore') {
      await mark('cutover-ready');
      await waitFor('restore-done');
      origin = restored;
      const recovered = await policy(orgOwner);
      assert.deepEqual(recovered, { revision: defaultRevision, allowedModelIds: [], sandboxConnectorAllowed: false,
        reviewRequired: true });
      assert.deepEqual(await models(manager), []);
      assert.equal((await connect(manager, 403)).code, 'ORGANIZATION_POLICY_DENIED');
      assert.equal((await getAction(manager, staleAction)).state, 'blocked');
      const enabled = await decide(orgOwner, recovered, [localModel], true);
      assert.equal(enabled.reviewRequired, false);
      assert.equal((await approve(manager, staleAction, 403)).code, 'ORGANIZATION_POLICY_DENIED');
      const cancelled = await request(actions + '/' + staleAction.id + '/cancel', 200, { actor: manager, method: 'POST' });
      assert.equal(cancelled.state, 'cancelled');
      const afterRecovery = await completeAction(manager, authorizationId);
      assert.equal((await receive(manager, authorizationId, afterRecovery.id)).scheduled, 1);
    } else if (mode === 'toggle') {
      await mark('cutover-ready');
      await waitFor('restore-done');
      origin = restored;
      await capability(orgOwner, 'organization_policies', false);
      assert.equal((await policy(orgOwner, 403)).code, 'CAPABILITY_UNAVAILABLE');
      assert.deepEqual(await models(manager), []);
      assert.equal((await connect(manager, 403)).code, 'ORGANIZATION_POLICY_DENIED');
    }
    Object.assign(summary, {
      ownerOnlyManagement: true, exactFallbackPolicy: true, noRejectedPrompt: true,
      midStreamCutoff: true, oldActionAndEventDenied: true, confirmedAudit: true,
      staleSnapshotFailsClosed: mode === 'restore',
    });
  }
  assert.deepEqual(await models(owner), personalModels);
  const personalRoom = await conversation(owner);
  const friendly = await start(owner, personalRoom, 'Personal scopes stay usable.', legacyModel);
  assert.equal(friendly.fallbackFromModelId, legacyModel);
  assert.equal((await terminal(owner, friendly.runId)).state, 'completed');
  summary.personalIsolation = true;
} finally {
  const cleaned = await Promise.allSettled(actors.map((actor) => erase(actor)));
  for (const outcome of cleaned) {
    if (outcome.status === 'rejected') {
      console.error(outcome.reason.message);
      process.exitCode = 1;
    }
  }
}

if (!process.exitCode) console.log(JSON.stringify(summary));
