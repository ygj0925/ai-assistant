import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [source, mode, directory, target] = process.argv.slice(2);
assert.ok(['enabled', 'disabled', 'restore'].includes(mode));
assert.equal(Boolean(directory && target), mode === 'restore');

function loopback(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.port && !['18080', '18090'].includes(url.port) && url.pathname === '/' && !url.username && !url.password
    && !url.search && !url.hash, 'Use the dedicated loopback synthetic fixture.');
  return url;
}

let origin = loopback(source);
const restored = target && loopback(target);
const evidence = directory && resolve(directory);
if (evidence) await mkdir(evidence, { recursive: true });

async function request(path, status, { actor, method = 'GET', body, key } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.token;
    headers['X-Workspace-Id'] = actor.workspace;
  }
  if (key) headers['Idempotency-Key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL('/api/assistant/v1' + path, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(12_000),
  });
  const data = response.status === 204 ? undefined : await response.json().catch(() => null);
  assert.equal(response.status, status, method + ' ' + path + ' → ' + (data?.code ?? ''));
  if (path.startsWith('/conversations')) {
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
  }
  return data;
}

async function register() {
  const credentials = {
    username: 'qa-history-' + randomUUID().slice(0, 10),
    password: 'Qa.ExplicitHistory-' + randomUUID(),
  };
  const { accessToken, user } = await request('/auth/register', 201, { method: 'POST', body: credentials });
  return { token: accessToken, workspace: user.workspaceId, credentials };
}

const conversations = '/conversations';
const unavailable = { kind: 'history_reply', status: 'unavailable' };
const protectedExcerpt = '只出现于原始历史中的合成标记🦀' + '🧪'.repeat(300);
const sourceLabel = '历史来源的合成私有标题';

function create(actor, title, projectId) {
  return request(conversations, 201, { actor, method: 'POST', body: { title, projectId } });
}

function preference(actor, referenceHistory) {
  return request('/memory/settings', 200, { actor, method: 'PATCH', body: { referenceHistory } });
}

async function capability(actor, available) {
  const { capabilities } = await request('/capabilities', 200, { actor });
  assert.equal(capabilities.find(({ id }) => id === 'explicit_history_references')?.available, available);
}

function start(actor, targetId, content, historyReference, status = 202, key = randomUUID()) {
  return request(conversations + '/' + targetId + '/runs', status, {
    actor, method: 'POST', key, body: { action: 'send', modelId: 'local-echo', content, historyReference },
  });
}

async function waitFor(actor, id, accept, message) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const current = await request('/runs/' + id, 200, { actor });
    if (accept(current)) return current;
    await delay(70);
  }
  assert.fail(message);
}

async function complete(actor, run, expected = 'completed') {
  const result = await waitFor(actor, run.runId,
    ({ state }) => ['completed', 'cancelled', 'failed'].includes(state), 'Run never settled.');
  assert.equal(result.state, expected);
  if (expected === 'cancelled') {
    assert.equal(result.content, '');
    assert.equal(result.messageId, undefined);
    assert.deepEqual(result.context, run.context);
  }
  return result;
}

function transcript(actor, id) {
  return request(conversations + '/' + id + '/messages', 200, { actor });
}

function receipt(actor, reply, expected = 200) {
  return request(conversations + '/' + reply.conversationId + '/messages/' + reply.messageId
    + '/history-reference', expected, { actor });
}

async function cancelledEvents(actor, run) {
  const response = await fetch(new URL('/api/assistant/v1/runs/' + run.runId + '/events', origin), {
    headers: { Authorization: 'Bearer ' + actor.token, 'X-Workspace-Id': actor.workspace, Accept: 'text/event-stream' },
    redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  assert.equal(response.status, 200);
  const frames = await response.text();
  assert.match(frames, /event:\s*run\.cancelled/);
  assert.doesNotMatch(frames, /event:\s*(message\.delta|run\.completed)/);
}

async function scopedSource(actor, content = protectedExcerpt) {
  const { id } = await create(actor, sourceLabel);
  const run = await complete(actor, await start(actor, id, content));
  return { sourceConversationId: id, sourceMessageId: run.messageId };
}

function usageProof(payload, content, source) {
  assert.equal(payload.context.used, [...content].length + 256);
  assert.equal(payload.context.turns, 1);
  assert.doesNotMatch(JSON.stringify(payload), /只出现于原始历史中的合成标记|历史来源的合成私有标题/);
  assert.ok(!JSON.stringify(payload).includes(source.sourceMessageId));
}

async function move(actor, id, projectId) {
  await request(conversations + '/' + id + '/project', 200, {
    actor, method: 'PUT', body: { projectId },
  });
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
    await delay(140);
  }
  assert.fail('Fixture did not create ' + name);
}

const owner = await register();
await capability(owner, mode !== 'disabled');
const initialSource = await scopedSource(owner);
const { id: ordinaryTarget } = await create(owner, '普通对照');
const plain = await complete(owner, await start(owner, ordinaryTarget, '未选历史'));
assert.equal(plain.content, '本地模拟回复：未选历史');
assert.equal(plain.context.used, 4);
assert.equal((await transcript(owner, ordinaryTarget)).items.at(-1).generation.historyReferenceUsed, undefined);
await receipt(owner, plain, 404);
const { id: targetId } = await create(owner, '明确选择引用的合成目标');
assert.equal((await start(owner, targetId, '历史还未授权', initialSource, 403)).code, 'CAPABILITY_UNAVAILABLE');
assert.equal((await preference(owner, true)).referenceHistory, true);

if (mode === 'disabled') {
  assert.equal((await start(owner, targetId, '关闭功能后引用', initialSource, 403)).code, 'CAPABILITY_UNAVAILABLE');
  assert.deepEqual((await transcript(owner, targetId)).items, []);
  console.log(JSON.stringify({ flagOffRejectsSelectedHistory: true, ordinaryRunUnchanged: true }));
} else {
  const other = await register();
  const foreign = await scopedSource(other, '另一账户的合成对照');
  const project = await request('/projects', 201, { actor: owner, method: 'POST', body: { name: '历史隔离项目' } });
  const { id: projectTarget } = await create(owner, '项目隔离目标', project.id);
  const { id: projectSourceId } = await create(owner, '项目隔离来源', project.id);
  const projectSource = await complete(owner, await start(owner, projectSourceId, '项目来源的合成内容'));
  const sourceHistory = (await transcript(owner, initialSource.sourceConversationId)).items;
  const prompt = sourceHistory.find(({ role }) => role === 'user');
  for (const invalid of [foreign, { ...initialSource, sourceMessageId: prompt.id },
    { sourceConversationId: projectSourceId, sourceMessageId: projectSource.messageId },
    { ...initialSource, sourceMessageId: randomUUID() }]) {
    assert.equal((await start(owner, targetId, '不合格历史', invalid, 404)).code, 'NOT_FOUND');
  }
  assert.equal((await start(owner, targetId, '非法标识', { ...initialSource, sourceMessageId: 'broken' }, 400)).code,
    'VALIDATION_ERROR');
  assert.equal((await start(owner, initialSource.sourceConversationId, '同源历史', initialSource, 400)).code,
    'VALIDATION_ERROR');
  await start(owner, projectTarget, '项目目标不引用个人历史', initialSource, 404);
  assert.equal((await request(conversations + '/' + targetId + '/runs', 400, {
    actor: owner, method: 'POST', key: randomUUID(), body: {
      action: 'regenerate', messageId: prompt.id, historyReference: initialSource,
    },
  })).code, 'VALIDATION_ERROR');
  assert.deepEqual((await transcript(owner, targetId)).items, []);

  const firstText = '使用我明确选择的历史';
  const firstKey = randomUUID();
  const started = await start(owner, targetId, firstText, initialSource, 202, firstKey);
  const referenced = await complete(owner, started);
  assert.equal((await start(owner, targetId, firstText, initialSource, 202, firstKey)).runId, started.runId);
  assert.equal((await start(owner, targetId, firstText, undefined, 409, firstKey)).code, 'CONFLICT');
  usageProof(referenced, firstText, initialSource);
  assert.equal((await transcript(owner, targetId)).items.at(-1).generation.historyReferenceUsed, true);
  assert.deepEqual(await receipt(owner, referenced), { kind: 'history_reply', status: 'available', ...initialSource });
  await receipt(other, referenced, 404);

  await request(conversations + '/' + initialSource.sourceConversationId + '/read-lock', 204,
    { actor: owner, method: 'POST', body: { confirm: true } });
  assert.deepEqual(await receipt(owner, referenced), unavailable);
  assert.equal((await start(owner, targetId, '锁定历史', initialSource, 404)).code, 'NOT_FOUND');
  await request(conversations + '/' + initialSource.sourceConversationId + '/read-unlock', 204,
    { actor: owner, method: 'POST', body: { currentPassword: owner.credentials.password } });
  assert.deepEqual(await receipt(owner, referenced), unavailable);
  let replayTarget = (await create(owner, '移动影响的历史目标')).id;
  const placement = await complete(owner, await start(owner, replayTarget, '移动之前的历史', initialSource));
  assert.equal((await receipt(owner, placement)).status, 'available');

  if (mode === 'restore') {
    await preference(other, true);
    const controlSource = await scopedSource(other, '未撤销的合成引用来源');
    const controlTarget = (await create(other, '未撤销的合成目标')).id;
    const control = await complete(other, await start(other, controlTarget, '备份对照提示', controlSource));
    const activeTarget = (await create(other, '撤权前在途的合成目标')).id;
    const running = await start(other, activeTarget, '发布前需要撤权的合成提示'.repeat(300), controlSource);
    await waitFor(other, running.runId, ({ state }) => state === 'running', 'Expected delayed synthetic generation.');
    await mark('snapshot-ready', { placementRun: placement.runId, activeRun: running.runId,
      sourceId: initialSource.sourceConversationId, activeSourceId: controlSource.sourceConversationId });
    await waitForMark('snapshot-done');
    assert.equal((await request('/runs/' + running.runId, 200, { actor: other })).state, 'running');
    await move(owner, initialSource.sourceConversationId, project.id);
    await move(owner, initialSource.sourceConversationId, null);
    assert.deepEqual(await receipt(owner, placement), unavailable);
    await preference(other, false);
    await complete(other, running, 'cancelled');
    assert.deepEqual(await receipt(other, control), unavailable);
    await mark('revoke-ready', { sourcesMoved: true, historyOptOutSettled: true });
    await waitForMark('database-switched');
    origin = restored;
    assert.deepEqual(await receipt(owner, placement), unavailable);
    assert.deepEqual(await receipt(other, control), unavailable);
    const replayed = await complete(other, running, 'cancelled');
    assert.equal(replayed.content, '');
    await cancelledEvents(other, running);
    assert.equal((await request('/runs/' + placement.runId, 200, { actor: owner })).content, placement.content);
    await preference(other, true);
    assert.deepEqual(await receipt(other, control), unavailable);
    replayTarget = (await create(owner, '恢复后的明确重新选择')).id;
    const fresh = await complete(owner, await start(owner, replayTarget, '重新选择通过', initialSource));
    assert.equal((await receipt(owner, fresh)).status, 'available');
    await mark('summary', { exactSelectedReply: true, boundAt256UnicodePoints: true, noSourceTextInReceipt: true,
      foreignProjectAndPromptDenied: true, lockUnlockInvalidatesOldReference: true, moveReturnInvalidatesOldReference: true,
      priorSnapshotPlacementDoesNotReviveReceipt: true, historyOptOutDoesNotReviveOnRestoredQueue: true,
      furtherExplicitChoiceAndAlreadyDeliveredOutputPreserved: true });
  } else {
    await move(owner, replayTarget, project.id);
    await move(owner, replayTarget, null);
    assert.deepEqual(await receipt(owner, placement), unavailable);
    const activeTarget = (await create(owner, '撤权前在途的合成目标')).id;
    const running = await start(owner, activeTarget, '撤权前的合成提示'.repeat(120), initialSource);
    await waitFor(owner, running.runId, ({ state }) => state === 'running', 'Expected delayed synthetic generation.');
    await delay(120);
    assert.equal((await request('/runs/' + running.runId, 200, { actor: owner })).content, '');
    await preference(owner, false);
    await preference(owner, true);
    await complete(owner, running, 'cancelled');
    await cancelledEvents(owner, running);
    assert.equal((await request('/usage', 200, { actor: owner })).reserved, 0);
    assert.equal((await transcript(owner, activeTarget)).items.length, 1);
    const erasedSource = await scopedSource(owner, '删除来源时擦除关联标识');
    const erasedTarget = (await create(owner, '删除来源的合成目标')).id;
    const erased = await complete(owner, await start(owner, erasedTarget, '已提交的合成目标', erasedSource));
    assert.equal((await receipt(owner, erased)).status, 'available');
    await request(conversations + '/' + erasedSource.sourceConversationId, 204, { actor: owner, method: 'DELETE' });
    assert.deepEqual(await receipt(owner, erased), unavailable);
    console.log(JSON.stringify({ exactSelectedReply: true, outputDoesNotContainSource: true,
      personalAndCurrentScope: true, prePublicationOptOutCancelsWithoutDelta: true,
      deletedSourceReceiptRemoved: true }));
  }
}
