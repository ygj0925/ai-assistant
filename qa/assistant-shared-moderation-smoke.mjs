import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [source, restored, folder] = process.argv.slice(2);
const operator = { token: process.env.ASSISTANT_TEST_SHARED_MODERATOR_TOKEN };
assert.ok(operator.token && folder);
const evidence = resolve(folder);
await mkdir(evidence, { recursive: true });
const accounts = [];

function loopback(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.port && !['18080', '18090'].includes(url.port) && url.pathname === '/' && !url.username && !url.password
    && !url.search && !url.hash, 'Use the dedicated synthetic loopback fixture.');
  return url;
}

let origin = loopback(source);
const target = loopback(restored);
assert.notEqual(origin.port, target.port);

async function request(path, expected, { actor, method = 'GET', body, key, platform = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) headers.Authorization = 'Bearer ' + actor.token;
  if (actor?.workspace) headers['X-Workspace-Id'] = actor.workspace;
  if (key) headers['Idempotency-Key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(new URL((platform ? '' : '/api/assistant/v1') + path, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  const value = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  assert.ok((Array.isArray(expected) ? expected : [expected]).includes(res.status),
    method + ' ' + path + ' HTTP ' + res.status + ' ' + (value?.code ?? ''));
  if (res.ok && (path === '/reports' || path.startsWith('/shares/') || path.includes('/moderation/'))) {
    assert.match(res.headers.get('cache-control') ?? '', /\bno-store\b/);
  }
  return { value, status: res.status };
}

async function register() {
  const credentials = { username: 'qa-report-' + randomUUID().slice(0, 11), password: 'Qa.Review!' + randomUUID() };
  const { value: session } = await request('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { id: session.user.id, workspace: session.user.workspaceId, token: session.accessToken, credentials };
  accounts.push(actor);
  return actor;
}

async function poll(probe, accepts, failure, timeout = 18_000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await probe();
    if (accepts(value)) return value;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail(failure);
}

async function mark(name, value = {}) {
  const path = join(evidence, name);
  await writeFile(path + '.tmp', JSON.stringify(value) + '\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

function wait(name) {
  return poll(async () => {
    try { await access(join(evidence, name)); return true; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return false;
    }
  }, Boolean, 'Missing fixture checkpoint ' + name, 300_000);
}

async function conversation(actor) {
  return (await request('/conversations', 201, {
    actor, method: 'POST', body: { title: 'Shared moderation fixture' },
  })).value;
}

async function reply(actor, room, content, parentId) {
  const { value: run } = await request('/conversations/' + room.id + '/runs', 202, {
    actor, method: 'POST', key: randomUUID(), body: { action: 'send', content, parentId },
  });
  return poll(async () => (await request('/runs/' + run.runId, 200, { actor })).value,
    (value) => value.state === 'completed', 'Local reply did not finish.');
}

async function share(actor, room, response, scope, audience) {
  const body = { sourceMessageId: response.messageId, scope, audience, includesAttachments: false };
  const { value: draft } = await request('/conversations/' + room.id + '/share-previews', 200, {
    actor, method: 'POST', body,
  });
  return (await request('/conversations/' + room.id + '/shares', 201, {
    actor, method: 'POST', body: { ...body, revision: draft.revision },
  })).value;
}

function read(published, expected = 200, actor) {
  return request('/shares/read', expected, { actor, method: 'POST', body: { token: published.token } });
}

function sharedReport(actor, published, replyIndex, reason = 'safety', expected = [200, 201]) {
  return request('/reports', expected, { actor, method: 'POST',
    body: { targetType: 'shared_reply', shareToken: published.token, replyIndex, reason } });
}

function moderatorPath(workspace, report) {
  return '/system/assistant/moderation/workspaces/' + workspace + '/reports'
    + (report ? '/' + report.id : '');
}

function detail(workspace, report, expected = 200, actor = operator) {
  return request(moderatorPath(workspace, report), expected, { actor, platform: true });
}

function decide(workspace, report, decision, expected = 200, actor = operator) {
  return request(moderatorPath(workspace, report) + '/decision', expected,
    { actor, method: 'POST', platform: true, body: { decision } });
}

function checkReceipt(receipt, expectedTarget) {
  assert.deepEqual(Object.keys(receipt).sort(), ['createdAt', 'id', 'reason', 'status', 'targetId', 'targetType'].sort());
  assert.equal(receipt.targetId, expectedTarget);
  assert.equal(receipt.targetType, 'shared_reply');
}

async function erase(actor) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(new URL('/api/assistant/v1/privacy/account-erasure', origin), {
      method: 'POST', headers: { Authorization: 'Bearer ' + actor.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: actor.credentials.password, confirmation: 'DELETE' }),
      redirect: 'error', signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 204 || res.status === 401) return;
    assert.equal(res.status, 429, 'Synthetic moderation account cleanup failed.');
    const retry = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    if (attempt < 2) await delay(Number.isFinite(retry) ? Math.min(60, Math.max(1, retry)) * 1000 : 60_000);
  }
  assert.fail('Synthetic moderation account cleanup remained throttled.');
}

let result;
try {
  const owner = await register();
  const viewer = await register();
  const stranger = await register();
  const privateRoom = await conversation(owner);
  const first = await reply(owner, privateRoom, 'Exact fixture evidence ' + 'W'.repeat(1090));
  const second = await reply(owner, privateRoom, 'A separate shared reply', first.messageId);
  const publicLink = await share(owner, privateRoom, second, 'branch', 'link');
  const control = await share(owner, privateRoom, second, 'reply', 'link');
  const { value: visible } = await read(publicLink);
  assert.deepEqual(visible.messages.map(({ role }) => role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(visible.messages[1].content, first.content);
  const { value: controlView } = await read(control);
  await sharedReport(undefined, publicLink, 1, 'safety', 401);
  await sharedReport(viewer, publicLink, 64, 'safety', 400);
  await sharedReport(viewer, publicLink, 0, 'safety', 404);
  await sharedReport(viewer, { token: 'sh_' + 'e'.repeat(43) }, 1, 'safety', 404);
  const attempts = await Promise.all(Array.from({ length: 4 }, () => sharedReport(viewer, publicLink, 1)));
  assert.deepEqual(attempts.map(({ status }) => status).sort(), [200, 200, 200, 201]);
  const report = attempts[0].value;
  assert.ok(attempts.every(({ value }) => value.id === report.id));
  checkReceipt(report, publicLink.id);
  await sharedReport(viewer, publicLink, 3, 'safety', 409);
  await sharedReport(viewer, publicLink, 1, 'spam', 409);
  await detail(owner.workspace, report, 403);
  await detail(owner.workspace, report, [401, 403], viewer);

  const { value: organization } = await request('/system/assistant/organizations', 201, {
    actor: operator, platform: true, method: 'POST', key: randomUUID(),
    body: { ownerAccountId: owner.id, name: 'Shared report fixture scope', seatLimit: 4, confirm: true },
  });
  const orgOwner = { ...owner, workspace: organization.workspaceId };
  const orgViewer = { ...viewer, workspace: organization.workspaceId };
  const forged = { ...stranger, workspace: organization.workspaceId };
  const orgRoom = await conversation(orgOwner);
  const orgReply = await reply(orgOwner, orgRoom, 'Workspace-only shared evidence');
  const workspaceLink = await share(orgOwner, orgRoom, orgReply, 'reply', 'workspace');
  await read(workspaceLink, 404);
  await sharedReport(viewer, workspaceLink, 0, 'privacy', 404);
  await request('/organizations/current/members', 201, {
    actor: orgOwner, method: 'POST', body: { accountId: viewer.id, role: 'member', confirm: true },
  });
  const { value: guardedReport } = await sharedReport(orgViewer, workspaceLink, 0, 'privacy', 201);
  checkReceipt(guardedReport, workspaceLink.id);
  await sharedReport(viewer, workspaceLink, 0, 'privacy', 404);
  await sharedReport(forged, workspaceLink, 0, 'privacy', 403);
  assert.equal((await sharedReport(orgViewer, publicLink, 1, 'safety', 200)).value.id, report.id);
  await mark('review-grant-needed', {
    personalWorkspace: owner.workspace, organizationWorkspace: organization.workspaceId,
  });
  await wait('review-grant-done');

  const { value: dossier } = await detail(owner.workspace, report);
  assert.equal(dossier.targetAvailable, true);
  assert.equal(dossier.preview, [...first.content].slice(0, 1024).join(''));
  assert.equal(dossier.evidenceDigest, createHash('sha256').update(first.content).digest('hex'));
  assert.deepEqual(dossier.audit, []);
  await detail(stranger.workspace, report, 403);
  await detail(organization.workspaceId, report, 404);
  assert.equal((await detail(organization.workspaceId, guardedReport)).value.preview, orgReply.content);
  await decide(owner.workspace, report, 'withdraw', 403);
  await mark('decision-grant-needed');
  await wait('decision-grant-done');

  const { value: legacy } = await request('/reports', 201, {
    actor: owner, method: 'POST',
    body: { targetType: 'assistant_reply', targetId: first.messageId, reason: 'other' },
  });
  await decide(owner.workspace, legacy, 'withdraw', 400);
  assert.equal((await decide(owner.workspace, legacy, 'dismiss')).value.status, 'dismissed');
  assert.equal((await detail(owner.workspace, legacy)).value.audit.length, 1);
  await mark('backup-ready');
  await wait('backup-done');

  const withdrawals = await Promise.all(Array.from({ length: 4 }, () => decide(owner.workspace, report, 'withdraw')));
  assert.ok(withdrawals.every(({ value }) => value.status === 'withdrawn' && value.id === report.id));
  await decide(owner.workspace, report, 'escalate', 409);
  const withdrawn = (await detail(owner.workspace, report)).value;
  assert.equal(withdrawn.targetAvailable, false);
  assert.equal(withdrawn.preview, null);
  assert.equal(withdrawn.audit.length, 1);
  assert.equal(withdrawn.audit[0].decision, 'withdraw');
  assert.equal(withdrawn.audit[0].resultingStatus, 'withdrawn');
  assert.match(withdrawn.audit[0].operatorId, /^[0-9]+$/);
  await read(publicLink, 404);
  assert.deepEqual((await read(control)).value, controlView);
  await request('/conversations/' + privateRoom.id, 200, { actor: owner });
  assert.equal((await decide(organization.workspaceId, guardedReport, 'withdraw')).value.status, 'withdrawn');
  await read(workspaceLink, 404, orgViewer);
  await mark('cutover-ready');
  await wait('restore-done');

  origin = target;
  await read(publicLink, 404);
  await read(workspaceLink, 404, orgViewer);
  assert.deepEqual((await read(control)).value, controlView);
  await request('/conversations/' + privateRoom.id, 200, { actor: owner });
  const restoredCase = (await detail(owner.workspace, report)).value;
  assert.equal(restoredCase.targetAvailable, false);
  assert.equal(restoredCase.preview, null);
  assert.equal((await decide(owner.workspace, report, 'withdraw')).value.status, 'target_unavailable');
  assert.equal((await detail(owner.workspace, report)).value.audit.length, 1);
  assert.equal((await detail(owner.workspace, legacy)).value.report.status, 'dismissed');

  result = {
    result: 'shared_reply_moderation_verified', exactPublicAndWorkspaceAudience: true,
    concurrentReportsDedupe: true, differentFirstPartyAndAdminPrivileges: true,
    exactEvidenceDigestAndBoundedPreview: true, concurrentExactWithdrawalAndAudit: true,
    oldLinksStillRevokedOnRestore: true, legacyReplyReportingUnchanged: true,
  };
} finally {
  const cleanup = await Promise.allSettled(accounts.map(erase));
  for (const item of cleanup) {
    if (item.status === 'rejected') {
      console.error(item.reason.message);
      process.exitCode = 1;
    }
  }
}
if (!process.exitCode) console.log(JSON.stringify(result));
