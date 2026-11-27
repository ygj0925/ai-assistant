import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [source, restored, folder] = process.argv.slice(2);
const workspace = process.env.ASSISTANT_TEST_COMPOSITE_WORKSPACE;
const operator = { token: process.env.ASSISTANT_TEST_COMPOSITE_OPERATOR_TOKEN };
const pilot = { token: process.env.ASSISTANT_TEST_COMPOSITE_OWNER_TOKEN, workspace };
assert.ok(workspace && operator.token && pilot.token && folder);
const evidence = resolve(folder);
await mkdir(evidence, { recursive: true });
const sessions = [];
const erased = new Set();
const prefix = '/api/assistant/v1';
const memory = '/memory/entries';
const guardian = '/eligibility/guardian/consents';
const connector = '/automations/sandbox-connector';

function loopback(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.port && !['18080', '18090'].includes(url.port) && url.pathname === '/' && !url.username && !url.password
    && !url.search && !url.hash, 'Use a dedicated synthetic loopback origin.');
  return url;
}

let origin = loopback(source);
const target = loopback(restored);
assert.notEqual(origin.port, target.port);

async function api(path, statuses, { actor, method = 'GET', body, key, platform = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) headers.Authorization = 'Bearer ' + actor.token;
  if (actor?.workspace) headers['X-Workspace-Id'] = actor.workspace;
  if (key) headers['Idempotency-Key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL((platform ? '' : prefix) + path, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
    signal: AbortSignal.timeout(12_000),
  });
  const value = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  const expected = Array.isArray(statuses) ? statuses : [statuses];
  assert.ok(expected.includes(response.status),
    method + ' ' + path + ' returned ' + response.status + ' ' + (value?.code ?? ''));
  if (path.startsWith('/memory/') || path.startsWith('/shares/')) {
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  }
  return value;
}

async function register() {
  const credentials = { username: 'qa-comp-' + randomUUID().slice(0, 12), password: 'Qa.Composite!' + randomUUID() };
  const { user, accessToken } = await api('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { id: user.id, token: accessToken, credentials };
  sessions.push(actor);
  return actor;
}

async function poll(probe, accepts, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await probe();
    if (accepts(value)) return value;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail(label);
}

async function checkpoint(name) {
  const path = join(evidence, name);
  await writeFile(path + '.tmp', '{}\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

function awaitCheckpoint(name) {
  return poll(async () => {
    try { await access(join(evidence, name)); return true; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
  }, Boolean, 'Missing driver checkpoint ' + name, 300_000);
}

async function run(actor, conversation, key, content) {
  return api('/conversations/' + conversation.id + '/runs', 202, {
    actor, method: 'POST', key, body: { action: 'send', content },
  });
}

function complete(actor, id) {
  return poll(() => api('/runs/' + id, 200, { actor }), ({ state }) => state === 'completed',
    'Synthetic model run did not complete.');
}

function history(actor, id) {
  return api('/conversations/' + id + '/messages?limit=20', 200, { actor }).then(({ items }) => items);
}

async function share(actor, conversation, reply, scope) {
  const body = { sourceMessageId: reply, scope, audience: 'link', includesAttachments: false };
  const draft = await api('/conversations/' + conversation.id + '/share-previews', 200, {
    actor, method: 'POST', body,
  });
  const published = await api('/conversations/' + conversation.id + '/shares', 201, {
    actor, method: 'POST', body: { ...body, revision: draft.revision },
  });
  assert.match(published.token, /^sh_[A-Za-z0-9_-]{43}$/);
  return { body, published };
}

function readShare(published, expected = 200) {
  return api('/shares/read', expected, { method: 'POST', body: { token: published.token } });
}

function decide(actor, value, authorize, expected = 200) {
  return api(guardian + '/' + value.id, expected, { actor, method: 'PUT',
    body: { revision: value.revision, authorize, confirm: true } });
}

async function capabilities(actor, available) {
  const { capabilities: entries } = await api('/capabilities', 200, { actor });
  for (const id of ['conversation_sharing', 'manual_memory']) {
    assert.equal(entries.find((entry) => entry.id === id)?.available, available, id);
  }
}

async function erase(actor) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(new URL(prefix + '/privacy/account-erasure', origin), {
      method: 'POST', headers: { Authorization: 'Bearer ' + actor.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: actor.credentials.password, confirmation: 'DELETE' }),
      redirect: 'error', signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 204 || res.status === 401) {
      erased.add(actor.id);
      return;
    }
    assert.equal(res.status, 429, 'Synthetic composite account cleanup failed.');
    const retry = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    if (attempt < 2) await delay(Number.isFinite(retry) ? Math.min(60, Math.max(1, retry)) * 1000 : 60_000);
  }
  assert.fail('Synthetic composite account cleanup remained throttled.');
}

async function verifyUsage(actor, conversation, completed, expectedUsage, expectedHistory, operationKey, content) {
  const replay = await Promise.all(Array.from({ length: 6 }, () => run(actor, conversation, operationKey, content)));
  for (const value of replay) {
    assert.equal(value.runId, completed.runId);
    assert.equal(value.messageId, completed.messageId);
  }
  assert.deepEqual(await api('/usage', 200, { actor }), expectedUsage);
  assert.deepEqual(await history(actor, conversation.id), expectedHistory);
}

let result;
try {
  const editor = await register();
  const subject = await register();
  const retiredAccount = await register();

  const oldSession = await api('/auth/login', 200, { method: 'POST', body: retiredAccount.credentials });
  const retiredSecond = { token: oldSession.accessToken };
  const retiredPrivate = await api('/conversations', 201, {
    actor: retiredAccount, method: 'POST', body: { title: '独立注销验证' },
  });
  const retiredRun = await run(retiredAccount, retiredPrivate, randomUUID(), 'Independent erased account sample.');
  await complete(retiredAccount, retiredRun.runId);
  await api('/conversations/' + retiredPrivate.id, 200, { actor: retiredSecond });

  for (const user of [editor, subject]) {
    await api('/organizations/current/members', 201, { actor: pilot, method: 'POST',
      body: { accountId: user.id, role: 'member', confirm: true } });
  }
  const consent = await api('/system/assistant/eligibility/workspaces/' + workspace + '/enrollments', 201, {
    actor: operator, platform: true, method: 'POST',
    body: { participantAccountId: subject.id, guardianAccountId: editor.id, scenario: 'guardian_required', confirm: true },
  });
  const guardianActor = { ...editor, workspace };
  const scopedSubject = { ...subject, workspace };
  const approved = await decide(guardianActor, consent, true);
  assert.equal(approved.status, 'allowed');
  const sandboxGrant = await api(connector + '/authorization', 200, {
    actor: scopedSubject, method: 'POST', body: { confirm: true },
  });
  const proposal = await api(connector + '/actions', 201, {
    actor: scopedSubject, method: 'POST', key: randomUUID(),
    body: { authorizationId: sandboxGrant.authorizationId, kind: 'fixture_notice', simulation: 'acknowledged' },
  });

  await capabilities(editor, true);
  const conversation = await api('/conversations', 201, {
    actor: editor, method: 'POST', body: { title: '组合恢复中的未删除会话' },
  });
  const operationKey = randomUUID();
  const content = '同一备份中保留账本及消息。';
  const concurrent = await Promise.all(Array.from({ length: 6 }, () => run(editor, conversation, operationKey, content)));
  assert.equal(new Set(concurrent.map(({ runId }) => runId)).size, 1);
  const completed = await complete(editor, concurrent[0].runId);
  const expectedUsage = await api('/usage', 200, { actor: editor });
  const expectedHistory = await history(editor, conversation.id);
  assert.equal(expectedUsage.reserved, 0);
  assert.equal(expectedUsage.used, [...completed.content].length);
  assert.equal(expectedHistory.length, 2);

  const { published: withdrawn } = await share(editor, conversation, completed.messageId, 'branch');
  const { published: retained, body: retainedSelection } = await share(editor, conversation, completed.messageId, 'reply');
  assert.notEqual(withdrawn.id, retained.id);
  const shared = await readShare(retained);
  await readShare(withdrawn);

  await api('/memory/settings', 200, { actor: editor, method: 'PATCH', body: { enabled: true } });
  const forgotten = await api(memory, 201, { actor: editor, method: 'POST', body: { content: 'Synthetic forgotten marker.' } });
  const remaining = await api(memory, 201, { actor: editor, method: 'POST', body: { content: 'Synthetic retained marker.' } });
  assert.equal((await api(memory, 200, { actor: editor })).items.length, 2);
  await checkpoint('backup-ready');
  await awaitCheckpoint('backup-done');

  assert.equal((await decide(guardianActor, approved, false)).status, 'guardian_required');
  await api('/shares/' + withdrawn.id, 204, { actor: editor, method: 'DELETE' });
  await api(memory + '/' + forgotten.id, 204, { actor: editor, method: 'DELETE' });
  await erase(retiredAccount);
  const deniesApproval = async () => {
    const reply = await api(connector + '/actions/' + proposal.id + '/approve', 403, {
      actor: scopedSubject, method: 'POST',
      body: { confirm: true, approvalRevision: proposal.approvalRevision },
    });
    assert.equal(reply.code, 'ELIGIBILITY_REQUIRED');
    assert.equal((await api(connector + '/actions/' + proposal.id, 200, { actor: scopedSubject })).state, 'blocked');
  };
  await deniesApproval();
  await readShare(withdrawn, 404);
  await api(memory + '/' + forgotten.id, 404, { actor: editor });
  await api('/conversations/' + retiredPrivate.id, 401, { actor: retiredSecond });
  await verifyUsage(editor, conversation, completed, expectedUsage, expectedHistory, operationKey, content);
  await checkpoint('revocations-ready');
  await awaitCheckpoint('restored-off-ready');

  origin = target;
  await capabilities(editor, false);
  await readShare(withdrawn, 404);
  await readShare(retained, 404);
  assert.equal((await api('/conversations/' + conversation.id + '/share-previews', 403, {
    actor: editor, method: 'POST', body: retainedSelection,
  })).code, 'CAPABILITY_UNAVAILABLE');
  assert.equal((await api(memory, 403, { actor: editor })).code, 'CAPABILITY_UNAVAILABLE');
  assert.equal((await api(memory, 403, { actor: editor, method: 'POST', body: { content: 'Blocked' } })).code,
    'CAPABILITY_UNAVAILABLE');
  await api('/conversations/' + retiredPrivate.id, 401, { actor: retiredAccount });
  await api('/conversations/' + retiredPrivate.id, 401, { actor: retiredSecond });
  await deniesApproval();
  await verifyUsage(editor, conversation, completed, expectedUsage, expectedHistory, operationKey, content);
  await checkpoint('re-enable-ready');
  await awaitCheckpoint('restored-on-ready');

  await capabilities(editor, true);
  await readShare(withdrawn, 404);
  assert.deepEqual(await readShare(retained), shared);
  await api(memory + '/' + forgotten.id, 404, { actor: editor });
  assert.deepEqual((await api(memory, 200, { actor: editor })).items, [remaining]);
  await api('/conversations/' + retiredPrivate.id, 401, { actor: retiredSecond });
  await deniesApproval();
  await verifyUsage(editor, conversation, completed, expectedUsage, expectedHistory, operationKey, content);
  result = {
    result: 'single_window_composite_recovery_verified',
    publicShareAndPrivateMemoryRetired: true, guardianConsentRetired: true, accountAndOldSessionsScrubbed: true,
    flagsDisabledAndReenabled: true, untouchedPublicAndPrivateControlsRestored: true,
    legacyRawV1EnvelopeAndConcurrentIdempotency: true, exactChatHistoryAndLedgerPreserved: true,
  };
} finally {
  const cleanup = await Promise.allSettled(sessions.filter(({ id }) => !erased.has(id)).map(erase));
  for (const item of cleanup) {
    if (item.status === 'rejected') {
      console.error(item.reason.message);
      process.exitCode = 1;
    }
  }
}
if (!process.exitCode) console.log(JSON.stringify(result));
