import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18083');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Use an isolated loopback API.');
const disabled = process.argv[3] === '--disabled';
const revocation = process.argv[4] === 'revoke';
const erasure = process.argv[4] === 'erase';
const evidenceDirectory = !disabled && process.argv[3] ? resolve(process.argv[3]) : undefined;
assert.ok(!revocation || evidenceDirectory, 'Revocation requires an isolated evidence directory and a fixture driver.');
assert.ok(!erasure || evidenceDirectory, 'Erasure requires an isolated evidence directory and fixture.');
const accounts = [];

async function request(path, status, { method = 'GET', token, workspace, body, key } = {}) {
  const headers = { Accept: path.endsWith('/artifact') ? 'text/markdown, application/json' : 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (workspace) headers['X-Workspace-Id'] = workspace;
  if (key) headers['Idempotency-Key'] = key;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL('/api/assistant/v1' + path, origin), {
    method, headers, body: body ? JSON.stringify(body) : undefined,
    redirect: 'error', signal: AbortSignal.timeout(5_000),
  });
  if (response.status !== status) {
    const failureCode = response.status >= 400 ? (await response.json().catch(() => ({}))).code : undefined;
    assert.equal(response.status, status, `${method} ${path} ${failureCode ?? ''}`);
  }
  if (status === 204) return;
  if (path.endsWith('/artifact') && status === 200) {
    assert.match(response.headers.get('content-type'), /^text\/markdown;\s*charset=utf-8$/i);
    assert.match(response.headers.get('content-disposition'), /^attachment;.*conversation-export\.md/i);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    return Buffer.from(await response.arrayBuffer());
  }
  return response.json();
}

async function createAccount() {
  const credentials = { username: `qa-job-${randomUUID().slice(0, 12)}`, password: `Qa.Job-${randomUUID()}` };
  const session = await request('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { token: session.accessToken, workspace: session.user.workspaceId, id: session.user.id, credentials };
  accounts.push(actor);
  return actor;
}

async function waitFor(read, expected, admissible, { timeout = 45_000, allowDisconnect = false } = {}) {
  const deadline = Date.now() + timeout;
  let disconnected = false;
  do {
    let state;
    try {
      state = await read();
    } catch (error) {
      if (!allowDisconnect || !(error instanceof TypeError || error.name === 'TimeoutError')) throw error;
      disconnected = true;
      await delay(200);
      continue;
    }
    if (expected(state)) return { state, disconnected };
    assert.ok(admissible(state), `Unexpected state ${state.status ?? state.state}`);
    await delay(150);
  } while (Date.now() < deadline);
  assert.fail('Fixture did not reach expected state.');
}

async function createSource(owner, conversation, content) {
  const { runId } = await request(`/conversations/${conversation}/runs`, 202, {
    ...owner, method: 'POST', key: randomUUID(), body: { action: 'send', content, modelId: 'local-echo', parentId: null },
  });
  const { state } = await waitFor(() => request(`/runs/${runId}`, 200, owner),
    (run) => run.state === 'completed', (run) => ['queued', 'running'].includes(run.state));
  assert.ok(state.messageId);
  return state.messageId;
}

function enqueue(owner, conversation, sourceMessageId, key = randomUUID(), status = 202) {
  return request(`/conversations/${conversation}/exports`, status, {
    ...owner, method: 'POST', key, body: { sourceMessageId },
  });
}

function readJob(owner, id, status = 200) {
  return request(`/jobs/${id}`, status, owner);
}

function cancel(owner, id, status = 200) {
  return request(`/jobs/${id}/cancel`, status, { ...owner, method: 'POST' });
}

function artifact(owner, id, status = 200) {
  return request(`/jobs/${id}/artifact`, status, owner);
}

async function checkpoint(owner, conversation, source, key, markerName) {
  const job = await enqueue(owner, conversation.id, source, key);
  const result = await waitFor(() => readJob(owner, job.id), (j) => j.status === 'running', (j) => j.status === 'queued');
  assert.equal(result.state.progress, 50);
  assert.equal(result.state.artifactId, undefined);
  await mkdir(evidenceDirectory, { recursive: true });
  const marker = join(evidenceDirectory, markerName);
  await writeFile(marker + '.tmp', JSON.stringify({ jobId: job.id, progress: 50,
    ...(revocation ? { accountId: owner.id, workspaceId: owner.workspace } : {}) }));
  await rename(marker + '.tmp', marker);
  return job;
}

async function restart(owner, conversation, source) {
  const restartKey = randomUUID();
  const job = await checkpoint(owner, conversation, source, restartKey, 'restart-ready.json');
  const resumed = await waitFor(() => readJob(owner, job.id), (j) => j.status === 'completed',
    (j) => j.status === 'running' && j.progress === 50, { timeout: 95_000, allowDisconnect: true });
  assert.ok(resumed.disconnected, 'The client must observe real API unavailability.');
  assert.equal(resumed.state.id, job.id);
  assert.equal(resumed.state.progress, 100);
  const first = await artifact(owner, job.id);
  const replay = await enqueue(owner, conversation.id, source, restartKey);
  assert.equal(replay.id, job.id);
  assert.equal(replay.artifactId, resumed.state.artifactId);
  assert.deepEqual(await artifact(owner, job.id), first);
  assert.match(first.toString('utf8'), /重启接续样例🦀/);
  const summary = { processDisconnection: resumed.disconnected, jobId: job.id, artifactId: replay.artifactId,
    artifactSha256: createHash('sha256').update(first).digest('hex'), progress: resumed.state.progress };
  await writeFile(join(evidenceDirectory, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}

async function revokeMembership(owner, conversation, source) {
  const job = await checkpoint(owner, conversation, source, randomUUID(), 'revoke-ready.json');
  const url = new URL(`/api/assistant/v1/jobs/${job.id}`, origin);
  const headers = { Authorization: `Bearer ${owner.token}`, 'X-Workspace-Id': owner.workspace };
  const deadline = Date.now() + 45_000;
  let status;
  do {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
    status = response.status;
    await response.body.cancel();
    if (status === 403) break;
    assert.equal(status, 200);
    await delay(200);
  } while (Date.now() < deadline);
  assert.equal(status, 403, 'Revocation driver must remove the test membership.');
  await writeFile(join(evidenceDirectory, 'revoke-checked.json'), '{}');
  const result = await waitFor(async () => {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(5_000) });
    if (response.status === 403) {
      await response.body.cancel();
      return { status: 'forbidden' };
    }
    assert.equal(response.status, 200);
    return response.json();
  }, (j) => j.status === 'cancelled', (j) => j.status === 'forbidden', { timeout: 55_000 });
  assert.equal(result.state.progress, 50);
  assert.equal(result.state.artifactId, undefined);
  await artifact(owner, job.id, 409);
  console.log(JSON.stringify({ membershipRevoked: true, workerCancelled: true, artifactUnavailable: true }));
}

async function eraseOwner(owner) {
  const capabilities = await request('/capabilities', 200, owner);
  assert.equal(capabilities.capabilities.find(({ id }) => id === 'account-erasure')?.available, true);
  const project = await request('/projects', 201, { ...owner, method: 'POST', body: { name: '待注销项目', description: '应清除的合成说明' } });
  const conversation = await request('/conversations', 201, { ...owner, method: 'POST', body: { title: '待注销会话', projectId: project.id } });
  const source = await createSource(owner, conversation.id, '注销后应清除的合成分支');
  const job = await enqueue(owner, conversation.id, source);
  await waitFor(() => readJob(owner, job.id), (j) => j.status === 'completed', (j) => ['queued', 'running'].includes(j.status));
  assert.match((await artifact(owner, job.id)).toString('utf8'), /注销后应清除的合成分支/);
  const active = await enqueue(owner, conversation.id, source);
  const { state } = await waitFor(() => readJob(owner, active.id), (j) => j.status === 'running', (j) => j.status === 'queued');
  assert.equal(state.progress, 50);

  await request('/privacy/account-erasure', 204, { ...owner, method: 'POST', body: {
    currentPassword: owner.credentials.password, confirmation: 'DELETE',
  } });
  await request('/projects', 401, owner);
  await readJob(owner, active.id, 401);
  await artifact(owner, job.id, 401);
  await request('/auth/login', 401, { method: 'POST', body: owner.credentials });
  await mkdir(evidenceDirectory, { recursive: true });
  const idRecord = { accountId: owner.id, projectId: project.id, conversationId: conversation.id,
    completedJobId: job.id, activeJobId: active.id };
  await writeFile(join(evidenceDirectory, 'verify-database.json'), JSON.stringify(idRecord, null, 2));
  console.log(JSON.stringify({ ownerErased: true, sessionRevoked: true, artifactUnavailable: true }));
}

async function testEnabled(owner) {
  const conversation = await request('/conversations', 201, { ...owner, method: 'POST', body: { title: '后台导出自测' } });
  const source = await createSource(owner, conversation.id, evidenceDirectory ? '重启接续样例🦀' : '仅选中分支甲🦀');

  if (revocation) {
    await revokeMembership(owner, conversation, source);
  } else if (evidenceDirectory) {
    await restart(owner, conversation, source);
  } else {
    const other = await createAccount();
    const second = await createSource(owner, conversation.id, '不应进入导出的另一分支');
    const external = await request('/conversations', 201, { ...other, method: 'POST', body: { title: '其他账号' } });
    await enqueue(other, conversation.id, source, randomUUID(), 404);
    await enqueue(owner, external.id, source, randomUUID(), 404);
    await request(`/conversations/${conversation.id}/exports`, 400, { ...owner, method: 'POST', body: { sourceMessageId: source } });
    const key = randomUUID();
    const started = await Promise.all([enqueue(owner, conversation.id, source, key), enqueue(owner, conversation.id, source, key)]);
    const id = started[0].id;
    assert.equal(started[1].id, id);
    await enqueue(owner, conversation.id, second, key, 409);
    await readJob({}, id, 401);
    await readJob(other, id, 404);
    await cancel(other, id, 404);
    await artifact(other, id, 404);
    await readJob({ ...owner, workspace: other.workspace }, id, 403);

    const pending = await enqueue(owner, conversation.id, second);
    const { state: running } = await waitFor(() => readJob(owner, pending.id), (j) => j.status === 'running', (j) => j.status === 'queued');
    assert.equal(running.progress, 50);
    const cancelled = await Promise.all([cancel(owner, pending.id), cancel(owner, pending.id)]);
    assert.deepEqual(cancelled[0], cancelled[1]);
    assert.equal(cancelled[0].status, 'cancelled');
    assert.equal(cancelled[0].artifactId, undefined);
    await artifact(owner, pending.id, 409);

    const { state: complete } = await waitFor(() => readJob(owner, id), (j) => j.status === 'completed', (j) => ['queued', 'running'].includes(j.status));
    assert.equal(complete.progress, 100);
    assert.ok(complete.artifactId);
    const exported = await artifact(owner, id);
    assert.equal(exported.toString('utf8'), '# 对话导出\n\n## 用户\n\n仅选中分支甲🦀\n\n## 助手\n\n本地模拟回复：仅选中分支甲🦀\n');
    assert.deepEqual(await cancel(owner, id), complete);
    assert.equal((await readJob(owner, pending.id)).status, 'cancelled');
    const page = await request('/jobs?limit=1', 200, owner);
    assert.ok(page.nextCursor);
    const next = await request('/jobs?limit=1&cursor=' + encodeURIComponent(page.nextCursor), 200, owner);
    assert.deepEqual(new Set([page.items[0].id, next.items[0].id]), new Set([id, pending.id]));
    assert.equal(next.nextCursor, null);
    assert.deepEqual((await request('/jobs', 200, other)).items, []);
    await request(`/conversations/${conversation.id}`, 204, { ...owner, method: 'DELETE' });
    await readJob(owner, id, 404);
    await artifact(owner, id, 404);
    assert.deepEqual((await request('/jobs', 200, owner)).items, []);
    console.log(JSON.stringify({ deduplication: 'passed', permissionScopes: 'passed', cancellation: 'passed',
      selectedBranch: 'passed', attachment: 'passed', cursor: 'passed', conversationDeletion: 'passed' }));
  }
}

try {
  const owner = await createAccount();
  const capabilities = await request('/capabilities', 200, owner);
  assert.equal(capabilities.capabilities.find(({ id }) => id === 'background_tasks')?.available, !disabled);
  if (disabled) {
    await request('/jobs', 401);
    const error = await request('/jobs', 403, owner);
    assert.equal(error.code, 'CAPABILITY_UNAVAILABLE');
    console.log(JSON.stringify({ capabilityHidden: true, disabledStatus: 403, authenticationFirst: true }));
  } else if (erasure) {
    await eraseOwner(owner);
  } else {
    await testEnabled(owner);
  }
} finally {
  await Promise.all(accounts.map((actor) => request('/auth/logout', 204, { ...actor, method: 'POST' }).catch(() => {})));
}
