import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [address, mode = 'normal', evidenceDirectory] = process.argv.slice(2);
assert.ok(address, 'Specify an isolated QA API origin.');
const origin = new URL(address);
assert.ok(['http:', 'https:'].includes(origin.protocol) &&
  ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) &&
  origin.port && !['18080', '18090'].includes(origin.port) && origin.pathname === '/' &&
  !origin.username && !origin.password && !origin.search && !origin.hash,
'Use a dedicated loopback API on an explicit QA port other than 18090.');
assert.ok(['normal', 'disabled', 'quota', 'restore'].includes(mode), 'Unknown project resource verification mode.');
assert.equal(Boolean(evidenceDirectory), mode === 'restore', 'Restore mode requires a fresh evidence directory.');

const evidence = evidenceDirectory && resolve(evidenceDirectory);
const contentLimit = 16_384;
const nameLimit = 120;
const prefix = '/api/assistant/v1';
const accounts = [];
const ownerResources = new Map();
let restoreConfirmed = false;

async function request(path, statuses, { actor, method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.token;
    headers['X-Workspace-Id'] = actor.workspace;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(prefix + path, origin), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(8_000),
  });
  const result = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  const expected = Array.isArray(statuses) ? statuses : [statuses];
  const diagnostic = method + ' ' + path + ' received ' + response.status + ' ' + (result?.code ?? '');
  assert.ok(expected.includes(response.status), diagnostic);
  if (response.status !== 204) assert.ok(result, diagnostic + ' without an API response body');
  if (path.includes('/resources')) assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
  return result;
}

async function register() {
  const credentials = { username: 'qa-pres-' + randomUUID().slice(0, 12), password: 'Qa.Resource-' + randomUUID() };
  const session = await request('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { id: session.user.id, token: session.accessToken, workspace: session.user.workspaceId, credentials };
  accounts.push(actor);
  return actor;
}

function resourcePath(project, resourceId) {
  const base = '/projects/' + encodeURIComponent(project) + '/resources';
  return resourceId === undefined ? base : base + '/' + encodeURIComponent(resourceId);
}

function list(actor, project, query = {}, status = 200) {
  const params = new URLSearchParams(query).toString();
  return request(resourcePath(project) + (params ? '?' + params : ''), status, { actor });
}

function write(actor, project, body, status = 201) {
  return request(resourcePath(project), status, { actor, method: 'POST', body });
}

function detail(actor, project, resource, status = 200) {
  return request(resourcePath(project, resource), status, { actor });
}

function remove(actor, project, resource, status = 204) {
  return request(resourcePath(project, resource), status, { actor, method: 'DELETE' });
}

function createProject(actor, name) {
  return request('/projects', 201, { actor, method: 'POST', body: { name } });
}

function erase(actor) {
  return request('/privacy/account-erasure', 204, {
    actor, method: 'POST',
    body: { currentPassword: actor.credentials.password, confirmation: 'DELETE' },
  });
}

async function capability(actor, expected) {
  const { capabilities } = await request('/capabilities', 200, { actor });
  assert.equal(capabilities.find(({ id }) => id === 'project_resources')?.available, expected);
}

async function fixtureResource(actor, project, name, content) {
  const resource = await write(actor, project, { name, content });
  assert.match(resource.id, /^[a-f0-9-]{36}$/i);
  assert.ok(Number.isFinite(Date.parse(resource.createdAt)));
  assert.deepEqual(resource, { id: resource.id, name: name.trim(), content, createdAt: resource.createdAt });
  ownerResources.set(resource.id, { actor, project });
  return resource;
}

async function validation(owner, project) {
  const char = '🦀';
  const maximum = char.repeat(contentLimit / Buffer.byteLength(char));
  assert.equal(Buffer.byteLength(maximum), contentLimit);
  const boundary = await fixtureResource(owner, project, char.repeat(nameLimit), maximum);
  assert.equal((await detail(owner, project, boundary.id)).content, maximum);
  const invalidBodies = [
    { name: ' ', content: 'synthetic' },
    { name: char.repeat(nameLimit + 1), content: 'synthetic' },
    { name: 'empty body', content: ' \t\n ' },
    { name: 'unit boundary', content: maximum + 'a' },
    { name: 'binary control', content: 'ok\u0000invalid' },
    { name: 'binary control', content: 'ok\u0001invalid' },
    { name: 'invalid unicode', content: 'ok\ud800invalid' },
    { name: 'wrong content type', content: { data: [0, 1, 127] } },
    { name: 'unknown field', content: 'synthetic', workspaceId: owner.workspace },
  ];
  for (const body of invalidBodies) {
    assert.equal((await write(owner, project, body, 400)).code, 'VALIDATION_ERROR');
  }
  assert.equal((await list(owner, project, { q: char.repeat(101) }, 400)).code, 'VALIDATION_ERROR');
  assert.equal((await list(owner, project, { limit: 0 }, 400)).code, 'VALIDATION_ERROR');
  assert.equal((await list(owner, project, { cursor: 'not.a.valid.cursor' }, 400)).code, 'VALIDATION_ERROR');
  await remove(owner, project, boundary.id);
  ownerResources.delete(boundary.id);
}

async function normal(owner) {
  const outsider = await register();
  const project = (await createProject(owner, '私有资料测试')).id;
  const sibling = (await createProject(owner, '同一工作空间的第二项目')).id;
  const external = (await createProject(outsider, '另一个账号的项目')).id;
  const source = await fixtureResource(owner, project, '  研究材料 Ｍｅｒｃｕｒｙ  ',
    '第一行\t完整记录１００％\n索引_甲 字符!号 参考🦀');
  const second = await fixtureResource(owner, project, '其他中文资料', '第一行记录100x 索引X甲 字符X号');
  const outside = await fixtureResource(outsider, external, '另一个账号的已知资料', '独立保存');

  await list(undefined, project, {}, 401);
  await detail(undefined, project, source.id, 401);
  await write(undefined, project, { name: 'guest', content: 'synthetic' }, 401);
  await list(outsider, project, {}, 404);
  await detail(outsider, project, source.id, 404);
  await detail(outsider, external, source.id, 404);
  await remove(outsider, project, source.id, 404);
  await write(outsider, project, { name: 'denied', content: 'synthetic' }, 404);
  await detail(owner, external, outside.id, 404);
  await detail(owner, sibling, source.id, 404);
  await remove(owner, sibling, source.id, 404);
  await detail({ ...owner, workspace: outsider.workspace }, project, source.id, 403);
  await detail(owner, project, 'malformed', 400);
  await remove(owner, project, randomUUID(), 404);
  assert.deepEqual(await detail(owner, project, source.id), source);

  const first = await list(owner, project, { limit: 1 });
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const next = await list(owner, project, { limit: 1, cursor: first.nextCursor });
  assert.equal(next.items.length, 1);
  assert.equal(next.nextCursor, null);
  assert.deepEqual(new Set([...first.items, ...next.items].map(({ id }) => id)), new Set([source.id, second.id]));
  assert.equal((await list(owner, project, { q: 'mercury', cursor: first.nextCursor }, 400)).code, 'VALIDATION_ERROR');
  assert.equal((await list(owner, sibling, { cursor: first.nextCursor }, 400)).code, 'VALIDATION_ERROR');
  assert.equal((await list(outsider, external, { cursor: first.nextCursor }, 400)).code, 'VALIDATION_ERROR');
  for (const item of [...first.items, ...next.items]) {
    assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'id', 'name']);
  }
  for (const q of ['mercury', 'ｍＥＲＣＵＲＹ', '100%', '索引_甲', '字符!号', '参考🦀']) {
    const found = await list(owner, project, { q });
    assert.deepEqual(found.items.map(({ id }) => id), [source.id], 'literal normalized query ' + q);
  }
  assert.deepEqual((await list(owner, project, { q: '不存在的关键词' })).items, []);
  assert.deepEqual((await list(owner, sibling, { q: 'mercury' })).items, []);
  await validation(owner, project);

  await remove(owner, project, source.id);
  await remove(owner, project, source.id);
  await detail(owner, project, source.id, 404);
  assert.deepEqual((await list(owner, project, { q: 'mercury' })).items, []);
  ownerResources.delete(source.id);
  await erase(owner);
  await detail(owner, project, second.id, 401);
  await list(owner, project, {}, 401);
  assert.deepEqual(await detail(outsider, external, outside.id), outside);
  console.log(JSON.stringify({
    unicodeAndByteBounds: 'passed', binaryAndMalformedInput: 'passed', ownerAndWorkspaceScope: 'passed',
    literalSearchAndCursor: 'passed', removalAndAccountErasure: 'passed',
  }));
}

async function quota(owner) {
  const project = (await createProject(owner, '资料配额与并发')).id;
  for (let count = 1; count <= 63; count++) {
    await fixtureResource(owner, project, '合成资料 ' + count, '配额检查内容');
  }
  const concurrent = await Promise.all([
    write(owner, project, { name: '并发 A', content: '配额检查内容' }, [201, 409]),
    write(owner, project, { name: '并发 B', content: '配额检查内容' }, [201, 409]),
  ]);
  const last = concurrent.find(({ id }) => id);
  assert.equal(concurrent.filter(({ code }) => code === 'CONFLICT').length, 1);
  assert.ok(last?.id);
  ownerResources.set(last.id, { actor: owner, project });
  assert.equal((await list(owner, project, { limit: 100 })).items.length, 64);
  const first = (await list(owner, project, { limit: 1 })).items[0];
  await remove(owner, project, first.id);
  ownerResources.delete(first.id);
  await fixtureResource(owner, project, '删除后释放配额', '配额检查内容');
  await erase(owner);
  ownerResources.clear();
  console.log(JSON.stringify({ serializedProjectQuota: 'passed', quotaReleasedAfterDelete: 'passed' }));
}

async function mark(name, value = {}) {
  const filename = join(evidence, name + '.json');
  await writeFile(filename + '.tmp', JSON.stringify(value) + '\n', { encoding: 'utf8', flag: 'wx' });
  await rename(filename + '.tmp', filename);
}

async function waitForMarker(name, timeout = 60_000) {
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
  assert.fail('The restore fixture did not create ' + name + '.json.');
}

async function restoredCapability(owner) {
  const deadline = Date.now() + 85_000;
  do {
    try {
      await capability(owner, true);
      return;
    } catch (failure) {
      if (!(failure instanceof TypeError || failure.name === 'TimeoutError')) throw failure;
    }
    await delay(400);
  } while (Date.now() < deadline);
  assert.fail('The restored fixture did not become available.');
}

async function restore(owner) {
  const removedAccount = await register();
  const project = (await createProject(owner, '恢复验证的保留项目')).id;
  const doomedProject = (await createProject(removedAccount, '恢复验证的注销项目')).id;
  const removed = await fixtureResource(owner, project, '即将撤回的资料', '从撤回前备份恢复也不可见');
  const retained = await fixtureResource(owner, project, '保留资料', '应当继续可见🦀');
  const doomed = await fixtureResource(removedAccount, doomedProject, '即将注销账号的资料', '账号注销后应擦除');

  await mark('backup-ready', { accountId: owner.id, projectId: project, removedResourceId: removed.id,
    retainedResourceId: retained.id, erasedAccountId: removedAccount.id, erasedProjectId: doomedProject,
    erasedResourceId: doomed.id });
  await waitForMarker('backup-done');
  await remove(owner, project, removed.id);
  await erase(removedAccount);
  await detail(owner, project, removed.id, 404);
  await detail(removedAccount, doomedProject, doomed.id, 401);
  await mark('restore-ready');
  await waitForMarker('database-switched', 120_000);
  await restoredCapability(owner);
  await detail(owner, project, removed.id, 404);
  await remove(owner, project, removed.id);
  assert.deepEqual(await detail(owner, project, retained.id), retained);
  assert.deepEqual((await list(owner, project)).items.map(({ id }) => id), [retained.id]);
  await detail(removedAccount, doomedProject, doomed.id, 401);
  const summary = { resourceRemovalReplayed: true, accountErasureReplayed: true, retainedResourceAvailable: true };
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
  if (mode === 'disabled') {
    const project = (await createProject(owner, '关闭资料能力的项目')).id;
    await list(undefined, project, {}, 401);
    assert.equal((await list(owner, project, {}, 403)).code, 'CAPABILITY_UNAVAILABLE');
    assert.equal((await write(owner, project, { name: 'blocked', content: 'synthetic' }, 403)).code, 'CAPABILITY_UNAVAILABLE');
    console.log(JSON.stringify({ disabledCapability: 'passed' }));
  } else if (mode === 'restore') {
    await restore(owner);
  } else if (mode === 'quota') {
    await quota(owner);
  } else {
    await normal(owner);
  }
} finally {
  // Revoke synthetic sessions. Do not mutate fixtures after a failed restore hand-off.
  if (mode !== 'restore') {
    for (const [id, { actor, project }] of ownerResources) {
      await remove(actor, project, id).catch(() => {});
    }
  }
  if (mode !== 'restore' || restoreConfirmed) {
    await Promise.all(accounts.map((actor) => request('/auth/logout', 204, { actor, method: 'POST' }).catch(() => {})));
  }
}
