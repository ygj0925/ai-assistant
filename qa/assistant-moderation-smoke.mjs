import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18080');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) {
  throw new Error('Use an isolated loopback service with synthetic accounts.');
}

const prefix = '/api/assistant/v1';
const suppliedOwner = process.env.ASSISTANT_TEST_REPORT_OWNER_TOKEN;
const administrator = process.env.ASSISTANT_TEST_MODERATOR_TOKEN ?? process.env.ASSISTANT_TEST_ADMIN_TOKEN;
const tokens = [];

async function request(path, { status, method = 'GET', token, workspace, body, idempotencyKey } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (workspace) headers['X-Workspace-Id'] = workspace;
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(path, origin), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  if (status !== undefined) assert.equal(response.status, status, `${method} ${path}`);
  if (response.status === 204) return { status: response.status };
  return { status: response.status, body: await response.json() };
}

async function createAccount() {
  const { body } = await request(prefix + '/auth/register', {
    status: 201,
    method: 'POST',
    body: { username: `qa-rep-${randomUUID().slice(0, 14)}`, password: `Test-aa${randomUUID()}` },
  });
  tokens.push(body.accessToken);
  return { token: body.accessToken, workspace: body.user.workspaceId };
}

async function fixtureOwner() {
  if (!suppliedOwner) return createAccount();
  const { body } = await request(prefix + '/auth/me', { status: 200, token: suppliedOwner });
  return { token: suppliedOwner, workspace: body.workspaceId };
}

async function newReply(owner, conversation) {
  const { body: queued } = await request(`${prefix}/conversations/${conversation}/runs`, {
    ...owner,
    status: 202,
    method: 'POST',
    idempotencyKey: randomUUID(),
    body: { action: 'send', modelId: 'local-echo', content: 'Synthetic moderation fixture' },
  });
  const deadline = Date.now() + 20_000;
  do {
    const { body } = await request(`${prefix}/runs/${queued.runId}`, { ...owner, status: 200 });
    if (body.state === 'completed') {
      assert.ok(body.messageId);
      return body.messageId;
    }
    assert.ok(['queued', 'running'].includes(body.state), `Unexpected fixture state ${body.state}`);
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail('Fixture reply did not complete.');
}

function submit(body, options) {
  return request(prefix + '/reports', { ...options, body, method: 'POST' });
}

let owner;
let conversation;
try {
  owner = await fixtureOwner();
  const other = await createAccount();
  const { body: created } = await request(prefix + '/conversations', {
    ...owner,
    status: 201,
    method: 'POST',
    body: { title: 'Synthetic reported reply' },
  });
  conversation = created.id;
  const target = { targetType: 'assistant_reply', targetId: await newReply(owner, conversation), reason: 'safety' };
  const ops = `/system/assistant/moderation/workspaces/${owner.workspace}/reports`;
  const foreignOps = `/system/assistant/moderation/workspaces/${other.workspace}/reports`;

  await submit(target, { status: 401 });
  await submit(target, { ...other, status: 404 });
  await submit(target, { ...other, workspace: owner.workspace, status: 403 });
  await submit({ ...target, targetType: 'shared_reply' }, { ...owner, status: 400 });
  await submit({ ...target, targetType: 'unsupported' }, { ...owner, status: 403 });
  await submit({ ...target, reason: 'synthetic arbitrary message' }, { ...owner, status: 400 });
  const pair = await Promise.all([submit(target, owner), submit(target, owner)]);
  assert.deepEqual(pair.map((result) => result.status).sort(), [200, 201]);
  assert.deepEqual(pair[0].body, pair[1].body);
  const receipt = pair[0].body;
  assert.equal(receipt.status, 'open');
  assert.equal(receipt.targetId, target.targetId);
  assert.equal(receipt.preview, undefined);
  assert.equal(receipt.evidenceDigest, undefined);
  await submit({ ...target, reason: 'spam' }, { ...owner, status: 409 });

  const adminCase = `${ops}/${receipt.id}`;
  await request(adminCase, { status: 401, token: owner.token });
  if (administrator) {
    await submit(target, { status: 401, token: administrator, workspace: owner.workspace });
    await request(foreignOps, { status: 403, token: administrator });
  }

  const verifyOperator = Boolean(administrator && suppliedOwner);
  if (verifyOperator) {
    const { body: pending } = await request(ops, { status: 200, token: administrator });
    assert.ok(pending.items.some((item) => item.id === receipt.id));
    const { body: before } = await request(adminCase, { status: 200, token: administrator });
    assert.equal(before.targetAvailable, true);
    assert.match(before.preview, /Synthetic moderation fixture/);
    assert.match(before.evidenceDigest, /^[0-9a-f]{64}$/);
    assert.deepEqual(before.audit, []);
  }

  await request(`${prefix}/conversations/${conversation}`, { ...owner, status: 204, method: 'DELETE' });
  conversation = undefined;
  await submit(target, { ...owner, status: 404 });

  if (verifyOperator) {
    const { body: after } = await request(adminCase, { status: 200, token: administrator });
    assert.equal(after.targetAvailable, false);
    assert.equal(after.preview ?? null, null);
    const decision = { decision: 'escalate' };
    const requestOptions = { status: 200, token: administrator, method: 'POST', body: decision };
    const { body: decided } = await request(adminCase + '/decision', requestOptions);
    assert.equal(decided.status, 'target_unavailable');
    assert.deepEqual((await request(adminCase + '/decision', requestOptions)).body, decided);
    await request(adminCase + '/decision', {
      ...requestOptions, status: 409, body: { decision: 'dismiss' },
    });
    const { body: finished } = await request(adminCase, { status: 200, token: administrator });
    assert.equal(finished.audit.length, 1);
    assert.equal(finished.audit[0].decision, 'escalate');
    assert.equal(finished.audit[0].resultingStatus, 'target_unavailable');
  }
  console.log(JSON.stringify({ consumerAuthorization: 'passed', consumerOnAdminRoute: 'rejected',
    administratorOnConsumerRoute: administrator ? 'rejected' : 'not tested',
    authorizedOperatorAndAudit: verifyOperator ? 'passed' : 'not tested' }));
} finally {
  if (conversation && owner) {
    await request(`${prefix}/conversations/${conversation}`, { ...owner, method: 'DELETE' }).catch(() => {});
  }
  await Promise.all(tokens.map((token) =>
    request(prefix + '/auth/logout', { token, method: 'POST' }).catch(() => {})));
}

