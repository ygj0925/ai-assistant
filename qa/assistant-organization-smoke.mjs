import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function loopback(value) {
  const endpoint = new URL(value);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
    && endpoint.port && endpoint.port !== '18080', 'Use a dedicated loopback QA instance.');
  return endpoint;
}

let origin = loopback(process.argv[2]);
const replayIndex = process.argv.indexOf('--replay');
const evidence = replayIndex === -1 ? undefined : process.argv[replayIndex + 1];
const restored = evidence ? loopback(process.argv[replayIndex + 2]) : undefined;
assert.ok(!restored || restored.port !== origin.port);
const operatorToken = process.env.ASSISTANT_TEST_ORG_OPERATOR_TOKEN;
assert.ok(operatorToken, 'Supply an actual isolated ContiNew operator token via the process environment.');
const operator = { accessToken: operatorToken };
const prefix = '/api/assistant/v1';
const adminProvision = '/system/assistant/organizations';
const org = '/organizations/current';
const accounts = [];
const erased = new Set();

async function call(route, expected, { actor, method = 'GET', body, key, platform = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) headers.Authorization = 'Bearer ' + actor.accessToken;
  if (actor?.workspace) headers['X-Workspace-Id'] = actor.workspace;
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const res = await fetch(new URL((platform ? '' : prefix) + route, origin), {
    method, headers, body: body && JSON.stringify(body), redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const codes = Array.isArray(expected) ? expected : [expected];
  const data = res.status === 204 ? undefined : await res.json();
  const actual = res.status;
  assert.ok(codes.includes(actual), method + ' ' + route + ' expected ' + codes.join('/') +
    ', got ' + actual + ' ' + (data?.code ?? ''));
  if (actual !== 429 && (!platform || res.ok)) assert.match(res.headers.get('cache-control') ?? '', /no-store/i);
  return { code: actual, data, retryAfter: res.headers.get('retry-after') };
}

async function register() {
  const credentials = { username: 'qa-org-' + randomUUID().slice(0, 11), password: 'Qa.Org!' + randomUUID() };
  const { data } = await call('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { ...data, credentials };
  accounts.push(actor);
  return actor;
}

function inOrg(actor, organization) {
  return { ...actor, workspace: organization.workspaceId };
}

async function verifyCapability(actor, available) {
  const { data } = await call('/capabilities', 200, { actor });
  assert.equal(data.capabilities.find(({ id }) => id === 'organizations')?.available, available);
}

async function mark(name) {
  const path = join(evidence, name);
  await writeFile(path + '.tmp', '{}\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

async function wait(name) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    try {
      await access(join(evidence, name));
      return;
    } catch (failure) {
      if (failure.code !== 'ENOENT') throw failure;
    }
    await delay(180);
  }
  assert.fail('Missing QA checkpoint ' + name);
}

async function erase(actor, expected = 204) {
  if (erased.has(actor.user.id)) return;
  const statuses = Array.isArray(expected) ? expected : [expected];
  for (let remaining = 3; remaining > 0; remaining--) {
    const { code, retryAfter } = await call('/privacy/account-erasure', [...statuses, 429], {
      actor, method: 'POST', body: { currentPassword: actor.credentials.password, confirmation: 'DELETE' },
    });
    if (code !== 429) {
      erased.add(actor.user.id);
      return;
    }
    if (remaining > 1) {
      const seconds = Number.parseInt(retryAfter ?? '', 10);
      await delay(Number.isFinite(seconds) ? Math.min(60, Math.max(1, seconds)) * 1000 : 60_000);
    }
  }
  assert.fail('Synthetic organization account cleanup remained throttled.');
}

let result;
try {
  const owner = await register();
  const manager = await register();
  const contenderA = await register();
  const contenderB = await register();
  const otherOwner = await register();
  const auditSubject = await register();
  const config = { ownerAccountId: owner.user.id, name: 'Local team fixture', seatLimit: 3, confirm: true };
  const provision = (body, key, expected = 201, actor = operator) =>
    call(adminProvision, expected, { actor, method: 'POST', body, key, platform: true });
  await provision(config, randomUUID(), [401, 403], owner);
  await call(org, 401, { actor: operator });
  await call(org, 404, { actor: owner });
  await verifyCapability(owner, false);
  const key = randomUUID();
  const { data: organization } = await provision(config, key);
  assert.deepEqual(await provision(config, key).then(({ data }) => data), organization);
  await provision({ ...config, seatLimit: 4 }, key, 409);
  const { data: other } = await provision({
    ...config, name: 'Independent scope fixture', seatLimit: 2, ownerAccountId: otherOwner.user.id,
  }, randomUUID());
  assert.notEqual(other.workspaceId, organization.workspaceId);
  const asOwner = inOrg(owner, organization);
  const asManager = inOrg(manager, organization);
  const foreign = inOrg(otherOwner, other);
  await call(org, 403, { actor: inOrg(owner, other) });
  await call(org, 403, { actor: inOrg(otherOwner, organization) });
  assert.equal((await call(org, 200, { actor: foreign })).data.seatsUsed, 1);
  const { data: initial } = await call(org, 200, { actor: asOwner });
  await verifyCapability(asOwner, true);
  assert.deepEqual(initial, organization);
  assert.equal(initial.seatsUsed, 1);
  const leave = '/auth/workspaces/' + organization.workspaceId + '/leave-preview';
  assert.equal((await call(leave, 403, { actor: owner })).data.code, 'ORGANIZATION_OWNER');

  const add = (owner, target, role, expected = 201) => call(org + '/members', expected, {
    actor: owner, method: 'POST', body: { accountId: target.user.id, role, confirm: true },
  });
  await add(foreign, auditSubject, 'member');
  const { data: managerRow } = await add(asOwner, manager, 'admin');
  assert.equal((await call(org, 200, { actor: asManager })).data.role, 'admin');
  await add(asManager, contenderA, 'admin', 403);
  const competitors = await Promise.all([add(asManager, contenderA, 'member', [201, 409]),
    add(asManager, contenderB, 'member', [201, 409])]);
  assert.deepEqual(competitors.map(({ code }) => code).sort(), [201, 409]);
  assert.equal(competitors.find(({ code }) => code === 409).data.code, 'ORGANIZATION_SEAT_LIMIT');
  const index = competitors.findIndex(({ code }) => code === 201);
  const member = index === 0 ? contenderA : contenderB;
  const memberRow = competitors[index].data;
  const asMember = inOrg(member, organization);
  assert.equal((await call(org, 200, { actor: asMember })).data.role, 'member');
  await verifyCapability(asMember, true);
  assert.equal((await call(org, 200, { actor: asOwner })).data.seatsUsed, 3);
  assert.deepEqual((await add(asOwner, member, 'member')).data, memberRow);
  await call(org + '/members', 403, { actor: asMember });
  await call(org + '/audit', 403, { actor: asMember });

  const all = (await call(org + '/members', 200, { actor: asManager })).data.items;
  const ownerRow = all.find(({ accountId }) => accountId === owner.user.id);
  assert.ok(ownerRow);
  const roster = await call(org + '/members?limit=1', 200, { actor: asOwner });
  assert.equal(roster.data.items.length, 1);
  assert.ok(roster.data.nextCursor);
  const second = await call(org + '/members?limit=1&cursor=' + encodeURIComponent(roster.data.nextCursor),
    200, { actor: asOwner });
  assert.notEqual(second.data.items[0].accountId, roster.data.items[0].accountId);
  await call(org + '/members?limit=1&cursor=' + encodeURIComponent(roster.data.nextCursor),
    400, { actor: foreign });

  const role = (actor, candidate, nextRole, expected = 200) => call(org + '/members/' + candidate.accountId + '/role',
    expected, { actor, method: 'PUT', body: {
      membershipRevision: candidate.membershipRevision, authorityRevision: candidate.authorityRevision,
      role: nextRole, confirm: true,
    } });
  const revoke = (actor, candidate, expected = 204) => call(org + '/members/' + candidate.accountId + '/revoke',
    expected, { actor, method: 'POST', body: {
      membershipRevision: candidate.membershipRevision, confirm: true,
    } });
  await role(asManager, memberRow, 'admin', 403);
  await role(asOwner, ownerRow, 'member', 403);
  await revoke(asOwner, ownerRow, 403);
  await revoke(asManager, managerRow, 403);
  const managerProject = (await call('/projects', 201,
    { actor: asManager, method: 'POST', body: { name: 'Retained by a demoted member' } })).data;
  const memberProject = (await call('/projects', 201,
    { actor: asMember, method: 'POST', body: { name: 'Workspace access revoked below' } })).data;
  const beforeAudit = (await call(org + '/audit?limit=2', 200, { actor: asOwner })).data;
  assert.equal(beforeAudit.items.length, 2);
  assert.ok(beforeAudit.nextCursor);
  assert.equal((await call(org + '/audit', 200, { actor: asOwner })).data.items.length, 3);
  if (restored) {
    await mark('backup-ready');
    await wait('backup-done');
  }

  const downgraded = (await role(asOwner, managerRow, 'member')).data;
  assert.equal(downgraded.membershipRevision, managerRow.membershipRevision);
  assert.notEqual(downgraded.authorityRevision, managerRow.authorityRevision);
  await role(asOwner, managerRow, 'admin', 409);
  await call(org + '/members', 403, { actor: asManager });
  assert.equal((await call('/projects/' + managerProject.id, 200, { actor: asManager })).data.id, managerProject.id);
  await revoke(asOwner, memberRow);
  await revoke(asOwner, memberRow);
  await call('/projects/' + memberProject.id, 403, { actor: asMember });
  await call('/projects', 200, { actor: member });
  await verifyCapability(member, false);
  const currentAudit = (await call(org + '/audit', 200, { actor: asOwner })).data.items;
  assert.equal(currentAudit.length, 5);
  assert.ok(currentAudit.some(({ action, previousRole, role, actorAccountId }) => action === 'role_changed'
    && previousRole === 'admin' && role === 'member' && actorAccountId === owner.user.id));
  assert.ok(currentAudit.some(({ action, targetAccountId }) => action === 'member_revoked' && targetAccountId === member.user.id));
  await erase(auditSubject);

  if (restored) {
    await mark('cutover-ready');
    await wait('restore-done');
    origin = restored;
  }
  assert.equal((await call(org, 200, { actor: asManager })).data.role, 'member');
  await call(org + '/members', 403, { actor: asManager });
  await call('/projects/' + managerProject.id, 200, { actor: asManager });
  await call(org, 403, { actor: asMember });
  assert.equal((await call(org, 200, { actor: foreign })).data.seatsUsed, 1);
  const foreignAudit = (await call(org + '/audit', 200, { actor: foreign })).data.items;
  assert.ok(foreignAudit.some(({ action, targetAccountId }) => action === 'member_added' && targetAccountId === undefined));
  assert.ok(foreignAudit.every(({ actorAccountId, targetAccountId }) =>
    actorAccountId !== auditSubject.user.id && targetAccountId !== auditSubject.user.id));
  const anew = (await add(asOwner, member, 'member')).data;
  assert.notEqual(anew.membershipRevision, memberRow.membershipRevision);
  await revoke(asOwner, memberRow, 409);
  await call(org, 200, { actor: asMember });
  await erase(member);
  const audit = (await call(org + '/audit', 200, { actor: asOwner })).data.items;
  assert.ok(audit.some(({ action, targetAccountId }) => action === 'member_added' && targetAccountId === undefined));
  assert.ok(audit.every(({ actorAccountId, targetAccountId }) => actorAccountId !== member.user.id && targetAccountId !== member.user.id));
  assert.equal((await call(org, 200, { actor: asOwner })).data.seatsUsed, 2);
  result = { result: 'local_organization_authority_verified', platformLogin: true,
    seatsAtomic: true, activeRoleGeneration: true, oldestEpochRevocation: true,
    auditProjectionRedacted: true, immutableOwner: true, restore: Boolean(restored) };
} finally {
  const cleanup = await Promise.allSettled(accounts.map((actor) => erase(actor, [204, 401])));
  for (const result of cleanup) {
    if (result.status === 'rejected') {
      console.error('Synthetic organization account cleanup failed:', result.reason.message);
      process.exitCode = 1;
    }
  }
}
if (!process.exitCode) console.log(JSON.stringify(result));
