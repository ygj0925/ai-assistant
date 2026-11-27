import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [source, mode = 'enabled', directory, target] = process.argv.slice(2);
function loopback(address) {
  const url = new URL(address);
  assert.ok(['http:', 'https:'].includes(url.protocol)
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.port && !['18080', '18090'].includes(url.port) && url.pathname === '/'
    && !url.username && !url.password && !url.search && !url.hash, 'Use a dedicated loopback API.');
  return url;
}
let origin = loopback(source);
assert.ok(['enabled', 'disabled', 'restore', 'source-change', 'lineage'].includes(mode), 'Invalid research smoke mode.');
assert.equal(Boolean(directory), ['restore', 'source-change', 'lineage'].includes(mode));
assert.equal(Boolean(target), mode === 'restore');
const evidence = directory && resolve(directory);
const restoredOrigin = target && loopback(target);
const prefix = '/api/assistant/v1';
const alpha = 'ba8f4c14-4979-487a-b6af-eefd5aed2001';
const beta = 'ba8f4c14-4979-487a-b6af-eefd5aed2002';
const expired = 'ba8f4c14-4979-487a-b6af-eefd5aed2003';
const accounts = [];

async function send(path, status, { user, method = 'GET', body, key } = {}) {
  const headers = { Accept: 'application/json' };
  if (user) {
    headers.Authorization = 'Bearer ' + user.accessToken;
    headers['X-Workspace-Id'] = user.user.workspaceId;
  }
  if (key) headers['Idempotency-Key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(prefix + path, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  if (path.startsWith('/research')) assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
  if (status === 200 && path.includes('/report')) {
    assert.equal(response.status, status);
    assert.match(response.headers.get('content-type') ?? '', /^text\/plain;\s*charset=UTF-8$/i);
    assert.match(response.headers.get('content-disposition') ?? '', /^attachment;\s*filename="?research-report\.txt"?$/i);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    return response.text();
  }
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  assert.equal(response.status, status, method + ' ' + path + ' returned ' + response.status + ' ' + (payload?.code ?? ''));
  if (status !== 204) assert.ok(payload, method + ' ' + path + ' had no JSON payload');
  return payload;
}

async function register() {
  const input = { username: 'qa-rsrch-' + randomUUID().slice(0, 12), password: 'Qa.Research-' + randomUUID() };
  const session = await send('/auth/register', 201, { method: 'POST', body: input });
  accounts.push(session);
  return { ...session, credentials: input };
}

async function feature(user, expected) {
  const { capabilities } = await send('/capabilities', 200, { user });
  assert.equal(capabilities.find(({ id }) => id === 'curated_research')?.available, expected);
}

function create(user, question, sourceIds, status = 201, key = randomUUID()) {
  return send('/research', status, { user, method: 'POST', body: { question, sourceIds }, key });
}

function inspect(user, id, status = 200) {
  return send('/research/' + id, status, { user });
}

function revise(user, id, expectedRevision, question, sourceIds, status = 200) {
  return send('/research/' + id, status, { user, method: 'PATCH', body: { expectedRevision, question, sourceIds } });
}

function action(user, id, op, revision, status) {
  return send('/research/' + id + '/' + op, status ?? (op === 'approve' ? 202 : 200), {
    user, method: 'POST', body: { revision },
  });
}

function report(user, id, revision, status = 200) {
  return send('/research/' + id + '/report?revision=' + revision, status, { user });
}

async function state(user, id, expected) {
  const deadline = Date.now() + 18_000;
  do {
    const value = await inspect(user, id);
    if (value.state === expected) return value;
    if (['completed', 'cancelled', 'failed'].includes(value.state)) {
      assert.fail('Task entered ' + value.state + ' while expecting ' + expected);
    }
    await delay(85);
  } while (Date.now() < deadline);
  assert.fail('Task did not reach ' + expected);
}

async function scopedJourney(owner) {
  const usageBefore = await send('/usage', 200, { user: owner });
  const outsider = await register();
  const all = await send('/research/sources?limit=50', 200, { user: owner });
  assert.ok(all.items.some(({ id }) => id === alpha) && all.items.some(({ id }) => id === beta));
  assert.ok(!all.items.some(({ id }) => id === expired));
  const firstPage = await send('/research/sources?limit=1', 200, { user: owner });
  assert.equal(firstPage.items.length, 1);
  assert.ok(firstPage.nextCursor);
  const next = await send('/research/sources?limit=1&cursor=' + firstPage.nextCursor, 200, { user: owner });
  assert.notEqual(next.items[0].id, firstPage.items[0].id);
  await create(owner, '过期资料计划', [expired], 409);
  await create(owner, '不允许给链接', ['https://example.com'], 400);
  await create(owner, '不能重复选择', [alpha, alpha], 400);
  await create(owner, ' ', [alpha], 400);
  await create(owner, '🦀'.repeat(257), [alpha], 400);

  const key = randomUUID();
  const first = await create(owner, '第一份本地研究', [alpha], 201, key);
  assert.equal(first.state, 'awaiting_approval');
  assert.equal(first.progress, 0);
  assert.equal(first.revision, 1);
  assert.deepEqual(first.sourceIds, [alpha]);
  assert.equal(first.reportAvailable, false);
  assert.equal(first.reusedSourceCount, 0);
  assert.deepEqual((await send('/research', 200, { user: owner })).items, [first]);
  assert.deepEqual((await send('/research', 200, { user: outsider })).items, []);
  assert.deepEqual(await create(owner, '第一份本地研究', [alpha], 201, key), first);
  await create(owner, '不同请求使用相同键', [alpha], 409, key);
  await inspect(undefined, first.id, 401);
  await inspect(outsider, first.id, 404);
  await action(outsider, first.id, 'approve', 1, 404);
  await report(outsider, first.id, 1, 404);
  await inspect({ ...owner, user: { ...owner.user, workspaceId: outsider.user.workspaceId } }, first.id, 403);
  await delay(450);
  assert.equal((await inspect(owner, first.id)).state, 'awaiting_approval');
  await report(owner, first.id, 1, 409);
  assert.equal((await action(owner, first.id, 'approve', 1)).state, 'queued');
  assert.equal((await state(owner, first.id, 'running')).progress, 50);
  const refreshed = await revise(owner, first.id, 1, '限定乙资料的新要求', [beta]);
  assert.equal(refreshed.revision, 2);
  assert.equal(refreshed.state, 'awaiting_approval');
  assert.equal(refreshed.reusedSourceCount, 0);
  await action(owner, first.id, 'approve', 1, 409);
  await action(owner, first.id, 'cancel', 1, 409);
  await report(owner, first.id, 1, 409);
  await delay(450);
  assert.equal((await inspect(owner, first.id)).state, 'awaiting_approval');
  await action(owner, first.id, 'approve', 2);
  await action(owner, first.id, 'approve', 2);
  const final = await state(owner, first.id, 'completed');
  assert.equal(final.progress, 100);
  assert.equal(final.reportAvailable, true);
  const text = await report(owner, first.id, 2);
  assert.match(text, /限定乙资料的新要求/);
  assert.match(text, /合成陈述乙/);
  assert.match(text, /https:\/\/evidence\.example\/beta/);
  assert.doesNotMatch(text, /alpha|合成陈述甲|过期/);
  assert.deepEqual(await revise(owner, first.id, 2, '限定乙资料的新要求', [beta]), final);
  assert.equal((await action(owner, first.id, 'cancel', 2)).state, 'cancelled');
  assert.equal((await action(owner, first.id, 'cancel', 2)).state, 'cancelled');
  await report(owner, first.id, 2, 409);
  assert.deepEqual(await send('/usage', 200, { user: owner }), usageBefore);
  await send('/privacy/account-erasure', 204, { user: owner, method: 'POST',
    body: { currentPassword: owner.credentials.password, confirmation: 'DELETE' } });
  await inspect(owner, first.id, 401);
  console.log(JSON.stringify({ scopeIsolated: true, explicitTwoActApproval: true,
    supersededApprovalRejected: true, scopedGroundedPlainText: true,
    revokedReportUnavailable: true, idempotent: true, modelUsageUnchanged: true,
    accountErasureRevokesTaskAccess: true }));
}

async function marker(name, detail) {
  const path = join(evidence, name + '.json');
  await writeFile(path + '.tmp', JSON.stringify(detail) + '\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

async function waitForMarker(name, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  do {
    try {
      await access(join(evidence, name + '.json'));
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(200);
  } while (Date.now() < deadline);
  assert.fail('Fixture did not create ' + name + '.json.');
}

async function restore(owner) {
  const revised = await create(owner, '备份后将要修订', [alpha]);
  const canceled = await create(owner, '备份后将要取消', [beta]);
  for (const task of [revised, canceled]) await action(owner, task.id, 'approve', 1);
  for (const task of [revised, canceled]) await state(owner, task.id, 'completed');
  const control = await create(owner, '可续接的检查点对照', [beta]);
  await action(owner, control.id, 'approve', 1);
  assert.equal((await state(owner, control.id, 'running')).progress, 50);
  await marker('backup-ready', { accountId: owner.user.id, workspaceId: owner.user.workspaceId,
    revisedTaskId: revised.id, canceledTaskId: canceled.id, continuingTaskId: control.id });
  await waitForMarker('backup-done');
  await revise(owner, revised.id, 1, '较新的明确范围', [beta]);
  await action(owner, canceled.id, 'cancel', 1);
  await report(owner, revised.id, 1, 409);
  await report(owner, canceled.id, 1, 409);
  await marker('restore-ready', {});
  await waitForMarker('database-switched');
  origin = restoredOrigin;
  await feature(owner, true);
  assert.equal((await inspect(owner, revised.id)).state, 'cancelled');
  assert.equal((await inspect(owner, canceled.id)).state, 'cancelled');
  await action(owner, revised.id, 'approve', 1, 409);
  await report(owner, revised.id, 1, 409);
  await report(owner, canceled.id, 1, 409);
  const resumed = await state(owner, control.id, 'completed');
  assert.equal(resumed.reportAvailable, true);
  assert.match(await report(owner, control.id, 1), /合成陈述乙/);
  const newer = await revise(owner, revised.id, 1, '恢复后获得再次明确批准', [beta]);
  assert.equal(newer.revision, 2);
  await action(owner, revised.id, 'approve', 2);
  assert.equal((await state(owner, revised.id, 'completed')).reportAvailable, true);
  const summary = { revokedOlderApprovalNeverRevived: true, cancelledOlderApprovalNeverRevived: true,
    sameWorkerCheckpointContinued: true, explicitNewApprovalPermitted: true };
  await marker('summary', summary);
  console.log(JSON.stringify(summary));
}

async function sourceChanged(owner) {
  const captured = await create(owner, '核验来源内容变化后的下载权限', [alpha]);
  await action(owner, captured.id, 'approve', 1);
  assert.equal((await state(owner, captured.id, 'completed')).reportAvailable, true);
  await report(owner, captured.id, 1);
  await marker('source-change-ready', { sourceId: alpha });
  await waitForMarker('source-change-applied');
  assert.equal((await inspect(owner, captured.id)).reportAvailable, false);
  await report(owner, captured.id, 1, 409);
  await action(owner, captured.id, 'approve', 1, 409);
  const summary = { latestSourceChangeBlocksEarlierReport: true };
  await marker('summary', summary);
  console.log(JSON.stringify(summary));
}

async function lineage(owner) {
  const first = await create(owner, '尚未核验来源的草稿', [alpha]);
  assert.equal(first.reusedSourceCount, 0);
  const second = await revise(owner, first.id, 1, '先修改草稿再批准', [alpha]);
  assert.equal(second.reusedSourceCount, 0);
  await action(owner, first.id, 'approve', 2);
  const firstCheckpoint = await state(owner, first.id, 'running');
  assert.equal(firstCheckpoint.progress, 50);
  assert.equal(firstCheckpoint.reusedSourceCount, 0);
  const thirdQuestion = '核验保留甲且明确新增乙';
  const third = await revise(owner, first.id, 2, thirdQuestion, [alpha, beta]);
  assert.equal(third.revision, 3);
  assert.equal(third.state, 'awaiting_approval');
  assert.equal(third.progress, 0);
  assert.equal(third.reusedSourceCount, 1);
  assert.equal(third.reportAvailable, false);
  await action(owner, first.id, 'approve', 2, 409);
  await report(owner, first.id, 2, 409);
  await report(owner, first.id, 3, 409);
  await action(owner, first.id, 'approve', 3);
  const oldReport = await state(owner, first.id, 'completed');
  assert.equal(oldReport.reusedSourceCount, 1);
  assert.match(await report(owner, first.id, 3), /合成陈述甲[\s\S]*合成陈述乙/);

  await marker('source-change-ready', { sourceId: alpha });
  await waitForMarker('source-change-applied');
  await report(owner, first.id, 3, 409);
  const fourth = await revise(owner, first.id, 3, thirdQuestion, [alpha, beta]);
  assert.equal(fourth.revision, 4, 'A refreshed source requires its own renewed plan.');
  assert.equal(fourth.reusedSourceCount, 1, 'Only unchanged beta should be reused.');
  await marker('lineage-proof-ready', { taskId: first.id, revision: 4 });
  await waitForMarker('lineage-proof-confirmed');
  await action(owner, first.id, 'approve', 4);
  const checking = await state(owner, first.id, 'running');
  assert.equal(checking.reusedSourceCount, 1);
  await marker('final-revoke-ready', { sourceId: beta });
  await waitForMarker('final-revoke-applied', 15_000);
  const failed = await state(owner, first.id, 'failed');
  assert.equal(failed.errorCode, 'SOURCES_CHANGED');
  assert.equal(failed.reportAvailable, false);
  await report(owner, first.id, 4, 409);
  const summary = { unapprovedDraftsDoNotCreateProof: true, verifiedMatchReused: true,
    changedSourceStartsUnverified: true, freshApprovalRequired: true,
    reusedSourceCheckedAgainAtFinalization: true };
  await marker('summary', summary);
  console.log(JSON.stringify(summary));
}

try {
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    assert.deepEqual(await readdir(evidence), [], 'Use a fresh evidence directory.');
  }
  await feature(undefined, false);
  const owner = await register();
  await feature(owner, mode !== 'disabled');
  if (mode === 'enabled') await scopedJourney(owner);
  else if (mode === 'restore') await restore(owner);
  else if (mode === 'source-change') await sourceChanged(owner);
  else if (mode === 'lineage') await lineage(owner);
  else {
    const failure = await create(owner, '关闭策略时不产生计划', [alpha], 403);
    assert.equal(failure.code, 'CAPABILITY_UNAVAILABLE');
    await send('/research/sources', 403, { user: owner });
    console.log(JSON.stringify({ disabledResearchDenied: true }));
  }
} finally {
  for (const user of accounts) await send('/auth/logout', 204, { user, method: 'POST' }).catch(() => {});
}
