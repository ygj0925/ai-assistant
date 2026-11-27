import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [address, mode = 'normal', evidenceDirectory] = process.argv.slice(2);
assert.ok(address, 'Specify an isolated QA API origin.');
const origin = new URL(address);
assert.ok(['http:', 'https:'].includes(origin.protocol) &&
  ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && origin.port &&
  !['18080', '18090'].includes(origin.port) && origin.pathname === '/' && !origin.username && !origin.password &&
  !origin.search && !origin.hash,
'Use a dedicated loopback API on an explicit QA port other than 18090.');
assert.ok(['normal', 'disabled', 'restore'].includes(mode), 'Unknown memory verification mode.');
assert.equal(Boolean(evidenceDirectory), mode === 'restore', 'Restore mode requires a fresh evidence directory.');

const evidence = evidenceDirectory && resolve(evidenceDirectory);
const prefix = '/api/assistant/v1';
const accounts = [];
const personalDefault = { enabled: false, referenceHistory: false, instructions: '' };
const emptyPage = { items: [], nextCursor: null };
let restoreConfirmed = false;

async function request(path, status, { actor, method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.token;
    headers['X-Workspace-Id'] = actor.workspace;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(prefix + path, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  const result = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  const diagnostic = method + ' ' + path + ' received ' + response.status + ' ' + (result?.code ?? '');
  assert.ok((Array.isArray(status) ? status : [status]).includes(response.status), diagnostic);
  if (response.status !== 204) assert.ok(result, diagnostic + ' without an API response body');
  if (path.includes('/memory/')) assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
  return result;
}

async function register() {
  const credentials = { username: 'qa-mem-' + randomUUID().slice(0, 12), password: 'Qa.Memory-' + randomUUID() };
  const session = await request('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { id: session.user.id, token: session.accessToken, workspace: session.user.workspaceId, credentials };
  accounts.push(actor);
  return actor;
}

async function capability(actor, expected) {
  const { capabilities } = await request('/capabilities', 200, { actor });
  const feature = capabilities.find(({ id }) => id === 'manual_memory');
  assert.equal(feature?.available, expected);
}

async function createProject(actor, name) {
  const { id } = await request('/projects', 201, { actor, method: 'POST', body: { name } });
  return id;
}

function settings(actor, project, body, status = 200) {
  const base = project ? '/projects/' + project + '/memory' : '/memory';
  return request(base + '/settings', status, { actor, method: body === undefined ? 'GET' : 'PATCH', body });
}

function entries(actor, project, { method = 'GET', id, body, query, status = 200 } = {}) {
  const base = project ? '/projects/' + project + '/memory' : '/memory';
  const params = query ? '?' + new URLSearchParams(query).toString() : '';
  return request(base + '/entries' + (id ? '/' + id : '') + params, status, { actor, method, body });
}

async function add(actor, project, content) {
  const entry = await entries(actor, project, { method: 'POST', body: { content }, status: 201 });
  assert.match(entry.id, /^[a-f0-9-]{36}$/);
  assert.ok(Number.isFinite(Date.parse(entry.createdAt)));
  assert.deepEqual(entry, { id: entry.id, content, createdAt: entry.createdAt });
  return entry;
}

function remove(actor, project, id, status = 204) {
  return entries(actor, project, { id, method: 'DELETE', status });
}

function replace(actor, project, id, content, status = 200) {
  return entries(actor, project, { id, method: 'PATCH', body: { content }, status });
}

async function normal(owner) {
  const outsider = await register();
  const project = await createProject(owner, '记忆项目甲');
  const sibling = await createProject(owner, '记忆项目乙');
  const external = await createProject(outsider, '另一个账号的项目');
  assert.deepEqual(await settings(owner), personalDefault);
  assert.deepEqual(await settings(owner, project), { enabled: false });
  assert.deepEqual(await entries(owner), emptyPage);
  assert.deepEqual(await entries(owner, project), emptyPage);
  await settings(undefined, null, undefined, 401);
  assert.equal((await entries(owner, null, { method: 'POST', body: { content: '不应写入' }, status: 403 })).code,
    'CAPABILITY_UNAVAILABLE');
  assert.equal((await entries(owner, project, { method: 'POST', body: { content: '不应写入' }, status: 403 })).code,
    'CAPABILITY_UNAVAILABLE');

  assert.deepEqual(await settings(owner, null, { referenceHistory: true, instructions: '使用中文回答' }),
    { enabled: false, referenceHistory: true, instructions: '使用中文回答' });
  assert.deepEqual(await settings(owner, null, { enabled: true }),
    { enabled: true, referenceHistory: true, instructions: '使用中文回答' });
  assert.deepEqual(await settings(owner, project, { enabled: true }), { enabled: true });
  assert.deepEqual(await settings(owner, sibling, { enabled: true }), { enabled: true });
  assert.deepEqual(await entries(owner), emptyPage, 'Rejected inactive writes must not appear after opt-in.');
  assert.deepEqual(await entries(owner, project), emptyPage);

  for (const body of [{ enabled: null }, { enabled: 'true' }, {}, { referenceHistory: 1 },
    { instructions: {} }, { custom: 'unexpected' }, { instructions: '\u0000' }]) {
    assert.equal((await settings(owner, null, body, 400)).code, 'VALIDATION_ERROR');
  }
  assert.equal((await settings(owner, project, { referenceHistory: true }, 400)).code, 'VALIDATION_ERROR');
  assert.equal((await settings(owner, project, { instructions: 'project override' }, 400)).code, 'VALIDATION_ERROR');
  for (const body of [{ content: '\u0000' }, { content: '\ud800' }, { content: ' \t\n' },
    { content: '🦀'.repeat(2001) }, { content: 1 }, { content: 'scope', projectId: external }]) {
    assert.equal((await entries(owner, project, { method: 'POST', body, status: 400 })).code, 'VALIDATION_ERROR');
  }

  const personal = await add(owner, null, '跨会话手动记忆');
  const first = await add(owner, project, '🦀'.repeat(2000));
  const second = await add(owner, project, '第二条项目记忆\n仅项目甲');
  const control = await add(owner, sibling, '项目乙对照');
  const page = await entries(owner, project, { query: { limit: 1 } });
  assert.equal(page.items.length, 1);
  assert.ok(page.nextCursor);
  const last = await entries(owner, project, { query: { limit: 1, cursor: page.nextCursor } });
  assert.equal(last.nextCursor, null);
  assert.deepEqual(new Set([...page.items, ...last.items].map(({ id }) => id)), new Set([first.id, second.id]));
  await entries(owner, sibling, { query: { cursor: page.nextCursor }, status: 400 });
  await entries(owner, null, { query: { cursor: page.nextCursor }, status: 400 });
  await entries(owner, null, { query: { limit: 0 }, status: 400 });
  await entries(owner, sibling, { id: first.id, status: 404 });
  await entries(owner, null, { id: first.id, status: 404 });
  await entries(owner, project, { id: personal.id, status: 404 });
  await entries(outsider, project, { id: first.id, status: 404 });
  await settings(owner, external, undefined, 404);
  await settings({ ...owner, workspace: outsider.workspace }, undefined, undefined, 403);
  await remove(owner, sibling, first.id, 404);
  await replace(undefined, project, first.id, '未认证的变更', 401);
  await replace(outsider, project, first.id, '外部账号变更', 404);
  await replace(owner, sibling, first.id, '越范围变更', 404);
  await replace(owner, project, first.id, ' \t\n ', 400);
  await entries(owner, project, { id: first.id, method: 'PATCH', body: { content: 'x', scope: 'y' }, status: 400 });
  assert.deepEqual(await replace(owner, project, first.id, first.content), first);
  assert.deepEqual(await entries(owner, project, { id: first.id }), first);
  const changedControl = await replace(owner, sibling, control.id, '项目乙变更后的内容');
  assert.notEqual(changedControl.id, control.id);
  assert.equal(changedControl.content, '项目乙变更后的内容');
  assert.deepEqual(await entries(owner, sibling, { id: changedControl.id }), changedControl);
  await replace(owner, sibling, control.id, '重试已经完成的变更', 404);
  const concurrent = await Promise.all(['并行编辑甲', '并行编辑乙'].map(content =>
    replace(owner, null, personal.id, content, [200, 401, 404])));
  const versions = concurrent.filter(result => result.id);
  assert.equal(versions.length, 1, 'Only one concurrent request can replace the same immutable ID.');
  const [changedPersonal] = versions;
  assert.notEqual(changedPersonal.id, personal.id);
  await entries(owner, null, { id: personal.id, status: 404 });
  assert.deepEqual(await entries(owner), { items: [changedPersonal], nextCursor: null });

  assert.deepEqual(await settings(owner, project, { enabled: false }), { enabled: false });
  assert.deepEqual(await entries(owner, project), emptyPage);
  await entries(owner, project, { id: first.id, status: 404 });
  await replace(owner, project, first.id, '关闭后的变更', 403);
  await remove(owner, project, first.id);
  await remove(owner, project, first.id);
  assert.deepEqual(await settings(owner, project, { enabled: true }), { enabled: true });
  await entries(owner, project, { id: first.id, status: 404 });
  assert.deepEqual(await entries(owner, project, { id: second.id }), second);
  assert.deepEqual(await entries(owner, sibling, { id: changedControl.id }), changedControl);
  assert.deepEqual(await settings(owner, null, { referenceHistory: false, instructions: '' }),
    { enabled: true, referenceHistory: false, instructions: '' });
  assert.deepEqual(await entries(owner, null, { id: changedPersonal.id }), changedPersonal);
  await request('/privacy/account-erasure', 204, { actor: owner, method: 'POST',
    body: { currentPassword: owner.credentials.password, confirmation: 'DELETE' } });
  await settings(owner, null, undefined, 401);
  await entries(owner, sibling, { id: changedControl.id, status: 401 });
  console.log(JSON.stringify({ defaultOffWithoutWrites: true, explicitScopeIsolation: true,
    independentPreferences: true, paginationAndUnicodeBounds: true,
    immutableScopedReplacement: true, concurrentReplacementCommitsOnce: true,
    revokedEntryStaysUnavailableAfterOptIn: true, accountErasureRevokesReads: true }));
}

async function mark(name, value = {}) {
  const filename = join(evidence, name + '.json');
  await writeFile(filename + '.tmp', JSON.stringify(value) + '\n', { encoding: 'utf8', flag: 'wx' });
  await rename(filename + '.tmp', filename);
}

async function waitForMarker(name, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  do {
    try {
      await access(join(evidence, name + '.json'));
      return;
    } catch (failure) {
      if (failure.code !== 'ENOENT') throw failure;
    }
    await delay(250);
  } while (Date.now() < deadline);
  assert.fail('The backup fixture did not create ' + name + '.json.');
}

async function restore(owner) {
  const project = await createProject(owner, '恢复时关闭的记忆');
  const sibling = await createProject(owner, '恢复时的独立对照');
  await settings(owner, null, { enabled: true, referenceHistory: true, instructions: '旧指令合成样本' });
  await settings(owner, project, { enabled: true });
  await settings(owner, sibling, { enabled: true });
  const stale = await add(owner, null, '应始终不可恢复的条目');
  const retained = await add(owner, project, '仅在重新开启时可重新读取');
  const control = await add(owner, sibling, '始终允许读取的独立项目记忆');
  const editedBeforeBackup = await add(owner, sibling, '备份前已退役的条目');
  const durableReplacement = await replace(owner, sibling, editedBeforeBackup.id, '随备份保留的新条目');
  const editedAfterBackup = await add(owner, sibling, '备份后应永久失效的旧版本');
  await mark('backup-ready', { accountId: owner.id, workspaceId: owner.workspace,
    projectId: project, siblingId: sibling, revokedMemoryId: stale.id,
    retainedMemoryId: retained.id, controlMemoryId: control.id, replacedMemoryId: editedAfterBackup.id });
  await waitForMarker('backup-done');
  const afterSnapshotReplacement = await replace(owner, sibling, editedAfterBackup.id, '只在新数据库存在的条目');
  await entries(owner, sibling, { id: editedAfterBackup.id, status: 404 });
  await settings(owner, null, { enabled: false, referenceHistory: false, instructions: '取代旧指令的合成样本' });
  await settings(owner, project, { enabled: false });
  await remove(owner, null, stale.id);
  await entries(owner, null, { id: stale.id, status: 404 });
  await mark('restore-ready');
  await waitForMarker('database-switched');
  await capability(owner, true);
  assert.deepEqual(await settings(owner), personalDefault);
  assert.deepEqual(await settings(owner, project), { enabled: false });
  assert.deepEqual(await settings(owner, sibling), { enabled: true });
  assert.deepEqual(await entries(owner), emptyPage);
  assert.deepEqual(await entries(owner, project), emptyPage);
  assert.deepEqual(await entries(owner, sibling, { id: control.id }), control);
  await entries(owner, sibling, { id: editedBeforeBackup.id, status: 404 });
  assert.deepEqual(await entries(owner, sibling, { id: durableReplacement.id }), durableReplacement);
  await entries(owner, sibling, { id: editedAfterBackup.id, status: 404 });
  await entries(owner, sibling, { id: afterSnapshotReplacement.id, status: 404 });
  assert.deepEqual(await settings(owner, null, { enabled: true, referenceHistory: true, instructions: '重新保存的指令' }),
    { enabled: true, referenceHistory: true, instructions: '重新保存的指令' });
  assert.deepEqual(await settings(owner, project, { enabled: true }), { enabled: true });
  await entries(owner, null, { id: stale.id, status: 404 });
  assert.deepEqual(await entries(owner, project, { id: retained.id }), retained);
  const summary = { durableIndependentCutoffs: true, revokedEntryStaysUnavailableAfterRestoreAndOptIn: true,
    explicitNewerPreferencesSurviveDurableCutoffs: true, unaffectedSiblingRemainsReadable: true,
    retiredMemoryVersionsStayUnavailableAfterRestore: true, replacementPresentWhenIncludedInBackup: true };
  await mark('summary', summary);
  restoreConfirmed = true;
  console.log(JSON.stringify(summary));
}

try {
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    assert.deepEqual(await readdir(evidence), [], 'Use an empty restore evidence directory.');
  }
  await capability(undefined, false);
  const owner = await register();
  await capability(owner, mode !== 'disabled');
  if (mode === 'restore') {
    await restore(owner);
  } else if (mode === 'normal') {
    await normal(owner);
  } else {
    assert.equal((await settings(owner, null, undefined, 403)).code, 'CAPABILITY_UNAVAILABLE');
    assert.equal((await settings(owner, null, { enabled: true }, 403)).code, 'CAPABILITY_UNAVAILABLE');
    await entries(owner, null, { status: 403 });
    await entries(owner, null, { method: 'POST', body: { content: '关闭时禁止写入' }, status: 403 });
    await replace(owner, null, randomUUID(), '关闭时禁止变更', 403);
    console.log(JSON.stringify({ disabledCapability: true, disabledReadsAndWrites: true }));
  }
} finally {
  if (mode !== 'restore' || restoreConfirmed) {
    await Promise.all(accounts.map(actor => request('/auth/logout', 204, { actor, method: 'POST' }).catch(() => {})));
  }
}
