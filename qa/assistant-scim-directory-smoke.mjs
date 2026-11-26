import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [source, restored, checkpointDir] = process.argv.slice(2);
const sourceUrl = loopback(source);
const restoreUrl = loopback(restored);
assert.notEqual(sourceUrl.port, restoreUrl.port);
const folder = resolve(checkpointDir);
await mkdir(folder, { recursive: true });
const { seed, directoryId, machineToken, platformToken } = globalThis.assistantScimFixture;
const { workspaceId, otherWorkspaceId } = seed;
const org = '/api/assistant/v1/organizations/current';
const account = '/api/assistant/v1';
const scim = '/scim/v2/' + directoryId + '/Users';
const SCIM_JSON = 'application/scim+json';
const PATCH = { schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
  Operations: [{ op: 'replace', path: 'active', value: false }] };
const users = [];
let origin = sourceUrl;

function loopback(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.port && url.port !== '18080' && url.pathname === '/' && !url.username && !url.password
    && !url.search && !url.hash, 'Use a dedicated synthetic loopback fixture.');
  return url;
}

async function http(path, expected, { token, workspace, method = 'GET', body, key, etag, raw } = {}) {
  const isScim = path.startsWith('/scim/v2/');
  const headers = { Accept: isScim ? SCIM_JSON : 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (workspace) headers['X-Workspace-Id'] = workspace;
  if (key) headers['Idempotency-Key'] = key;
  if (etag) headers['If-Match'] = etag;
  if (body !== undefined || raw !== undefined) headers['Content-Type'] = isScim ? SCIM_JSON : 'application/json';
  const res = await fetch(new URL(path, origin), { method, headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)), redirect: 'error',
    signal: AbortSignal.timeout(12_000) });
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  assert.equal(res.status, expected, `${method} ${path.split('?')[0]} ${data?.code ?? ''}`);
  if (isScim) {
    assert.match(res.headers.get('content-type') ?? '', /^application\/scim\+json\b/);
    assert.match(res.headers.get('cache-control') ?? '', /\bno-store\b/);
    if (!res.ok) {
      assert.deepEqual(data.schemas, ['urn:ietf:params:scim:api:messages:2.0:Error']);
      assert.equal(data.status, String(expected));
    }
  }
  return { data, etag: res.headers.get('etag') };
}

async function login(credentials, register = false) {
  const reply = (await http(account + '/auth/' + (register ? 'register' : 'login'), register ? 201 : 200,
    { method: 'POST', body: { username: credentials.username, password: credentials.password } })).data;
  const result = { id: reply.user.id, token: reply.accessToken, personal: reply.user.workspaceId,
    password: credentials.password };
  users.push(result);
  return result;
}

function register() {
  return login({ username: 'qa-scim-' + randomUUID().slice(0, 12), password: 'Qa.Scim!' + randomUUID() }, true);
}

async function checkpoint(name, data = {}) {
  const path = join(folder, name);
  await writeFile(path + '.tmp', JSON.stringify(data) + '\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

async function wait(name) {
  const end = Date.now() + 300_000;
  do {
    try { await access(join(folder, name)); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(100);
  } while (Date.now() < end);
  assert.fail('Missing controlled recovery checkpoint ' + name);
}

async function runCompleted(actor, room) {
  const { data: run } = await http(account + `/conversations/${room.id}/runs`, 202, {
    token: actor.token, workspace: workspaceId, method: 'POST', key: randomUUID(),
    body: { action: 'send', content: 'Synthetic directory membership and ledger verification' },
  });
  for (let attempts = 0; attempts < 80; attempts++) {
    const { data } = await http(account + '/runs/' + run.runId, 200, { token: actor.token, workspace: workspaceId });
    if (data.state === 'completed') return;
    await delay(100);
  }
  assert.fail('Synthetic organization run did not complete.');
}

try {
  const owner = await login(seed.owner);
  const admin = await login(seed.admin);
  const member = await register();
  const ownerScope = { token: owner.token, workspace: workspaceId };
  const memberScope = { token: member.token, workspace: workspaceId };
  const adminScope = { token: admin.token, workspace: workspaceId };
  const add = async (actor) => (await http(org + '/members', 201, { ...ownerScope, method: 'POST',
    body: { accountId: actor.id, role: 'member', confirm: true } })).data;
  const remove = (membership) => http(org + '/members/' + membership.accountId + '/revoke', 204, {
    ...ownerScope, method: 'POST', body: { membershipRevision: membership.membershipRevision, confirm: true },
  });
  const roster = async () => (await http(org + '/members', 200, ownerScope)).data.items;
  const usage = async () => (await http(org + '/usage?days=7', 200, ownerScope)).data.items;
  const audit = async () => (await http(org + '/audit', 200, ownerScope)).data.items;
  const bind = (body, status = 201, actor = ownerScope) => http(org + '/directory-bindings', status,
    { ...actor, method: 'POST', body });
  const mkBinding = (membership) => ({ accountId: membership.accountId,
    membershipRevision: membership.membershipRevision, externalId: randomUUID(), confirm: true });
  const scope = await add(member);
  assert.equal((await roster()).length, 4);
  const actual = mkBinding(scope);
  await bind({ ...actual, accountId: owner.id }, 409);
  await bind({ ...actual, accountId: admin.id, membershipRevision: seed.admin.membershipRevision }, 409);
  await bind({ ...actual, membershipRevision: randomUUID() }, 409);
  await bind(actual, 403, adminScope);
  await bind(actual, 403, { token: owner.token, workspace: otherWorkspaceId });
  const bound = (await bind(actual)).data;
  assert.deepEqual(bound, { id: bound.id, directoryId, externalId: actual.externalId,
    membershipRevision: actual.membershipRevision });
  assert.deepEqual((await bind(actual)).data, bound);
  await http(org + '/members/' + member.id + '/role', 409, { ...ownerScope, method: 'PUT',
    body: { membershipRevision: scope.membershipRevision, authorityRevision: scope.authorityRevision,
      role: 'admin', confirm: true } });

  const { data: room } = await http(account + '/conversations', 201, { ...memberScope, method: 'POST',
    body: { title: 'Synthetic revocable organization chat' } });
  const { data: personalRoom } = await http(account + '/conversations', 201, { token: member.token, method: 'POST',
    body: { title: 'Synthetic personal control chat' } });
  const beforeRun = await usage();
  await runCompleted(member, room);
  const baselineLedger = await usage();
  const total = (days, key) => days.reduce((sum, day) => sum + day[key], 0);
  assert.equal(total(baselineLedger, 'completedRuns'), total(beforeRun, 'completedRuns') + 1);
  assert.ok(total(baselineLedger, 'settledUnits') > total(beforeRun, 'settledUnits'));

  const resource = scim + '/' + bound.id;
  let machine = await machineToken();
  const wrong = await machineToken(true);
  const pieces = machine.split('.');
  pieces[2] = (pieces[2][0] === 'A' ? 'B' : 'A') + pieces[2].slice(1);
  for (const token of [undefined, member.token, platformToken, wrong, pieces.join('.')]) {
    await http(resource, 401, { token });
  }
  await http(org, 401, { token: machine, workspace: workspaceId });
  await http('/scim/v2/' + randomUUID() + '/Users/' + bound.id, 404, { token: machine });
  const lookup = '?filter=' + encodeURIComponent('externalId eq "' + actual.externalId + '"');
  const current = await http(resource, 200, { token: machine });
  assert.equal(current.data.active, true);
  assert.equal(current.data.externalId, actual.externalId);
  assert.equal(current.data.userName, actual.externalId);
  assert.equal(current.etag, current.data.meta.version);
  assert.ok(!JSON.stringify(current.data).includes(member.id));
  const searched = (await http(scim + lookup, 200, { token: machine })).data;
  assert.deepEqual(searched.Resources, [current.data]);
  assert.equal(searched.totalResults, 1);
  await http(scim + '?filter=active%20eq%20true', 400, { token: machine });
  const patch = (id, expected, extras = {}) => http(scim + '/' + id, expected,
    { method: 'PATCH', token: machine, body: PATCH, ...extras });
  await patch(bound.id, 412, { etag: '"stale"' });
  await patch(bound.id, 400, { body: { ...PATCH, Operations: [{ ...PATCH.Operations[0], value: true }] } });
  await patch(bound.id, 400, { body: { ...PATCH, Operations: [...PATCH.Operations, ...PATCH.Operations] } });
  await patch(bound.id, 400, { raw: '{"schemas":[],"Operations":[],"Operations":[]}' });
  await patch(bound.id, 400, { raw: ' '.repeat(4_097) });
  await checkpoint('backup-ready');
  await wait('backup-done');

  machine = await machineToken();
  const retired = await Promise.all([patch(bound.id, 200), patch(bound.id, 200)]);
  assert.ok(retired.every((reply) => reply.data.active === false && reply.etag !== current.etag));
  await patch(bound.id, 412, { etag: current.etag });
  await http(account + '/conversations/' + room.id, 403, memberScope);
  await http(account + '/conversations/' + personalRoom.id, 200, { token: member.token });
  assert.equal((await roster()).length, 3);
  assert.equal((await roster()).find((entry) => entry.accountId === admin.id)?.role, 'admin');
  assert.deepEqual(await usage(), baselineLedger);
  const events = (await audit()).filter((event) => event.action === 'directory_deactivated'
    && event.targetAccountId === member.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].directoryId, directoryId);
  assert.equal(events[0].targetAccountId, member.id);
  const replacement = await add(member);
  assert.notEqual(replacement.membershipRevision, scope.membershipRevision);
  await patch(bound.id, 409);
  await http(org, 200, memberScope);

  await remove(replacement);
  const second = await register();
  const secondScope = await add(second);
  const secondBinding = (await bind(mkBinding(secondScope))).data;
  const overlap = await Promise.all([remove(secondScope), patch(secondBinding.id, 200)]);
  assert.equal(overlap[1].data.active, false);
  const secondAudit = (await audit()).filter((event) => event.targetAccountId === second.id
    && ['member_revoked', 'directory_deactivated'].includes(event.action));
  assert.equal(secondAudit.length, 1);
  assert.equal((await roster()).find((entry) => entry.accountId === admin.id)?.role, 'admin');
  assert.deepEqual(await usage(), baselineLedger);
  await checkpoint('account-hold-ready', { bindingId: secondBinding.id });
  await wait('account-binding-locked');
  const erase = http(account + '/privacy/account-erasure', 204, { token: second.token, method: 'POST',
    body: { currentPassword: second.password, confirmation: 'DELETE' } });
  await wait('account-erasure-waiting');
  await http(scim + '/' + secondBinding.id, 404, { token: machine });
  await checkpoint('account-hold-read-denied');
  await erase;
  await http(scim + '/' + secondBinding.id, 404, { token: machine });
  await patch(secondBinding.id, 404);
  assert.ok((await audit()).every((event) => event.targetAccountId !== second.id));

  await checkpoint('cutover-ready');
  await wait('restore-ready');
  origin = restoreUrl;
  machine = await machineToken();
  const recovered = await http(resource, 200, { token: machine });
  assert.equal(recovered.data.active, false);
  await patch(bound.id, 412, { etag: current.etag });
  await patch(bound.id, 200);
  await http(account + '/conversations/' + room.id, 403, memberScope);
  await http(account + '/conversations/' + personalRoom.id, 200, { token: member.token });
  assert.deepEqual(await usage(), baselineLedger);
  assert.equal((await roster()).find((entry) => entry.accountId === admin.id)?.role, 'admin');
  await checkpoint('restore-verified');
  await wait('disabled-ready');
  machine = await machineToken();
  await http(resource, 403, { token: machine });
  await http(account + '/conversations/' + room.id, 403, memberScope);
  await http(account + '/conversations/' + personalRoom.id, 200, { token: member.token });
  assert.deepEqual(await usage(), baselineLedger);
  console.log(JSON.stringify({ realSignedDirectory: true, exactWorkspaceAndRole: true, crossedTokensRejected: true,
    oldEpochDenied: true, concurrentDeactivationAndDirectRevocation: true, auditAndSeatPreserved: true,
    ledgerPreserved: true, accountErasureHoldsDirectory: true, preDeactivationRestoreRemainsDenied: true,
    featureOffDoesNotUndoRevocation: true }));
} finally {
  await Promise.allSettled(users.map((user) => http(account + '/auth/logout', 204, { token: user.token, method: 'POST' })));
}
