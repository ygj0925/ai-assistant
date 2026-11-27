import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [address, mode = 'enabled', evidenceDirectory] = process.argv.slice(2);
const origin = new URL(address);
assert.ok(['http:', 'https:'].includes(origin.protocol)
  && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
  && origin.port && !['18080', '18090'].includes(origin.port) && origin.pathname === '/'
  && !origin.username && !origin.password && !origin.search && !origin.hash,
'Use an isolated synthetic loopback API.');
assert.ok(['enabled', 'disabled', 'membership'].includes(mode));
assert.equal(Boolean(evidenceDirectory), mode === 'membership', 'Membership requires a fresh evidence directory.');
const evidence = evidenceDirectory && resolve(evidenceDirectory);
const prefix = '/api/assistant/v1';
const mock = 'local-echo';
const instruction = '格式：项目符号';
const privatePersonal = '仅存储在个人记忆的合成文本 🦀';
const privateProject = '仅存储在项目甲的合成文本 🌱';
const terminal = new Set(['completed', 'cancelled', 'failed']);
let actor;

async function call(path, status, { method = 'GET', body, key, guest = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor && !guest) {
    headers.Authorization = 'Bearer ' + actor.accessToken;
    headers['X-Workspace-Id'] = actor.user.workspaceId;
  }
  if (key) headers['Idempotency-Key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(prefix + path, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  assert.equal(response.status, status, method + ' ' + path);
  return status === 204 ? undefined : response.json();
}

function conversation(title, projectId) {
  return call('/conversations', 201, { method: 'POST', body: { title, projectId } });
}

function project(name) {
  return call('/projects', 201, { method: 'POST', body: { name } });
}

function projectMemory(projectId) {
  return '/projects/' + projectId + '/memory';
}

function settings(path, body) {
  return call(path + '/settings', 200, { method: 'PATCH', body });
}

function entry(path, content) {
  return call(path + '/entries', 201, { method: 'POST', body: { content } });
}

function start(id, content, parentId) {
  return call('/conversations/' + id + '/runs', 202, {
    method: 'POST', key: randomUUID(), body: { action: 'send', modelId: mock, content, parentId },
  });
}

function snapshot(runId) {
  return call('/runs/' + runId, 200);
}

function cancel(runId) {
  return call('/runs/' + runId + '/cancel', 200, { method: 'POST' });
}

async function waitFor(runId, accept, reason) {
  const deadline = Date.now() + 20_000;
  do {
    const current = await snapshot(runId);
    if (accept(current)) return current;
    await delay(80);
  } while (Date.now() < deadline);
  assert.fail(reason);
}

async function done(runId, state = 'completed') {
  const result = await waitFor(runId, ({ state }) => terminal.has(state), 'Run did not settle.');
  assert.equal(result.state, state);
  return result;
}

function units(text) {
  return [...text].length;
}

const marker = (instructions, personal, project) =>
  '本地模拟回复（自定义指令 ' + instructions + '，个人记忆 ' + personal + '，项目记忆 ' + project + '）：';

async function validatePlain(enabled, checkDefaultModel) {
  const target = (await conversation('无项目的合成对照')).id;
  const text = '普通用户提示';
  const started = checkDefaultModel
    ? await call('/conversations/' + target + '/runs', 202, {
      method: 'POST', key: randomUUID(), body: { action: 'send', content: text },
    })
    : await start(target, text);
  const result = await done(started.runId);
  assert.equal(result.modelId, mock);
  if (enabled) {
    assert.equal(result.content, marker(1, 1, 0) + '\n- ' + text);
    assert.equal(result.context.used, units(text + instruction + privatePersonal));
  } else {
    assert.equal(result.content, '本地模拟回复：' + text);
    assert.equal(result.context.used, units(text));
  }
  assert.equal(result.context.turns, 1);
  assert.equal(result.context.budget, 32_768);
  const history = await call('/conversations/' + target + '/messages', 200);
  assert.deepEqual(history.items.find(({ id }) => id === result.messageId).generation.context, result.context);
  assert.equal(history.items.find(({ role }) => role === 'user').content, text);
  assert.ok(!JSON.stringify(result).includes(privatePersonal));
}

async function verifyFullBranch() {
  const target = (await conversation('满上下文分支')).id;
  let parentId;
  for (const symbol of ['甲', '乙', '🧪', '🌱']) {
    const seed = symbol.repeat(8_000);
    const waiting = await start(target, seed, parentId);
    const stopped = await cancel(waiting.runId);
    assert.equal(stopped.state, 'cancelled');
    const { items } = await call('/conversations/' + target + '/messages', 200);
    parentId = items.find(({ role, content }) => role === 'user' && content === seed).id;
  }
  const text = '当前请求'.repeat(192);
  const queued = await start(target, text, parentId);
  assert.equal(queued.context.used, 32_768);
  const result = await done(queued.runId);
  assert.equal(result.content, '本地模拟回复：' + text);
  assert.deepEqual(result.context, queued.context);
}

async function testProjectScope() {
  const a = (await project('甲项目')).id;
  const b = (await project('乙项目')).id;
  const memoryA = projectMemory(a);
  const memoryB = projectMemory(b);
  await settings(memoryA, { enabled: true });
  await settings(memoryB, { enabled: true });
  const itemA = await entry(memoryA, privateProject);
  const bFirst = '乙项目自己的资料';
  const bSecond = '乙项目的另一份资料';
  await entry(memoryB, bFirst);
  const revoked = await entry(memoryB, '不应随同生成的乙项目旧资料');
  await entry(memoryB, bSecond);
  await call(memoryB + '/entries/' + revoked.id, 204, { method: 'DELETE' });

  const target = (await conversation('甲项目会话', a)).id;
  let queued = await start(target, '甲的提示');
  const usedA = await done(queued.runId);
  assert.equal(usedA.content, marker(0, 0, 1) + '甲的提示');
  assert.equal(usedA.context.used, units('甲的提示' + privateProject));
  assert.ok(!JSON.stringify(usedA).includes(privateProject));
  assert.ok(!JSON.stringify(usedA).includes(privatePersonal));

  const plainProject = (await project('普通对照项目')).id;
  const sentinel = (await conversation('排队隔离用对照', plainProject)).id;
  const running = await start(sentinel, '队列占用合成文本'.repeat(130));
  await waitFor(running.runId, (value) => value.state === 'running' && value.content.length > 0,
    'Start the fixture with assistant.models.mock-delay-millis=15.');
  const moved = (await conversation('领取前移动的会话', a)).id;
  queued = await start(moved, '移动后领取');
  assert.equal((await snapshot(queued.runId)).state, 'queued');
  await call('/conversations/' + moved + '/project', 200, { method: 'PUT', body: { projectId: b } });
  await cancel(running.runId);
  const usedB = await done(queued.runId);
  assert.equal(usedB.content, marker(0, 0, 2) + '移动后领取');
  assert.equal(usedB.context.used, units('移动后领取' + bFirst + bSecond));

  const revokedMidRun = (await conversation('生成后发布前撤权', a)).id;
  const inflight = await start(revokedMidRun, '撤权期间生成的合成文本'.repeat(90));
  await waitFor(inflight.runId, ({ state }) => state === 'running', 'The personalized worker did not claim the run.');
  await delay(350);
  assert.equal((await snapshot(inflight.runId)).content, '',
    'Personalized output must remain buffered until authorization is rechecked.');
  await settings(memoryA, { enabled: false });
  const rejected = await done(inflight.runId, 'cancelled');
  assert.equal(rejected.content, '');
  assert.deepEqual(rejected.context, inflight.context);
  const replay = await fetch(new URL(prefix + '/runs/' + inflight.runId + '/events', origin), {
    headers: { Authorization: 'Bearer ' + actor.accessToken, 'X-Workspace-Id': actor.user.workspaceId,
      Accept: 'text/event-stream' },
    redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  assert.equal(replay.status, 200);
  const retainedEvents = await replay.text();
  assert.equal([...retainedEvents.matchAll(/event:run\.cancelled|event: run\.cancelled/g)].length, 1);
  assert.doesNotMatch(retainedEvents, /message\.delta|run\.completed/);
  assert.equal((await call('/conversations/' + revokedMidRun + '/messages', 200))
    .items.some(({ role }) => role === 'assistant'), false);
  assert.equal((await call('/usage', 200)).reserved, 0);
  await call(memoryA + '/entries/' + itemA.id, 204, { method: 'DELETE' });
  await settings(memoryA, { enabled: true });
  const after = await start((await conversation('撤权后的普通回复', a)).id, '后续消息');
  assert.equal((await done(after.runId)).content, '本地模拟回复：后续消息');
}

async function mark(name, data) {
  const path = join(evidence, name + '.json');
  await writeFile(path + '.tmp', JSON.stringify(data), { flag: 'wx' });
  await rename(path + '.tmp', path);
}

async function waitForMarker(name) {
  const deadline = Date.now() + 25_000;
  do {
    try {
      await access(join(evidence, name + '.json'));
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(150);
  } while (Date.now() < deadline);
  assert.fail('Membership fixture did not create ' + name + '.json.');
}

async function testMembership() {
  const projectId = (await project('成员撤权的项目')).id;
  const memory = projectMemory(projectId);
  await settings(memory, { enabled: true });
  await entry(memory, privateProject);
  const target = (await conversation('成员撤权后取消待发回复', projectId)).id;
  const run = await start(target, '成员撤权的生成占位文本'.repeat(190));
  await waitFor(run.runId, ({ state }) => state === 'running', 'The scoped worker did not claim the run.');
  await delay(300);
  assert.equal((await snapshot(run.runId)).content, '');
  await mark('remove-member', { accountId: actor.user.id, workspaceId: actor.user.workspaceId, runId: run.runId });
  await waitForMarker('member-removed');
  assert.equal((await call('/runs/' + run.runId, 403)).code, 'FORBIDDEN');
  await mark('member-denied', {});
  await waitForMarker('member-rejoined');
  const canceled = await done(run.runId, 'cancelled');
  assert.equal(canceled.content, '');
  assert.equal((await call('/usage', 200)).reserved, 0);
  assert.equal((await call('/conversations/' + target + '/messages', 200))
    .items.some(({ role }) => role === 'assistant'), false);
  const summary = { membershipRevocationBlocksReads: true, scopedUnpublishedReplyCancelled: true,
    noPrivateOutputPersisted: true, reservationReleased: true };
  await mark('summary', summary);
  console.log(JSON.stringify(summary));
}

try {
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    assert.deepEqual(await readdir(evidence), [], 'Use a fresh evidence directory.');
  }
  actor = await call('/auth/register', 201, { method: 'POST', guest: true,
    body: { username: 'qa-prun-' + randomUUID().slice(0, 12), password: 'Qa.Memory-' + randomUUID() } });
  await settings('/memory', { enabled: true, referenceHistory: true, instructions: instruction });
  await entry('/memory', privatePersonal);
  if (mode === 'membership') {
    await testMembership();
  } else if (mode === 'enabled') {
    await validatePlain(true, true);
    await testProjectScope();
    await verifyFullBranch();
    console.log(JSON.stringify({ currentScopedPrivateInputs: true, currentInstructionBehavior: true,
      projectMovedWhileQueuedUsesCurrentScope: true, optOutSuppressesBufferedChanges: true,
      immutableRevocationHeld: true, exactContextBudget: true, noPrivateRawReplyOrMetadata: true }));
  } else {
    await validatePlain(false, true);
    console.log(JSON.stringify({ defaultOrdinaryReplyUnchanged: true, optedInStoredSourcesRemainUnused: true }));
  }
} finally {
  if (actor) await call('/auth/logout', 204, { method: 'POST' }).catch(() => {});
}
