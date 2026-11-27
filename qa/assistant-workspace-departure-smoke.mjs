import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [source, mode, directory, target] = process.argv.slice(2);
assert.ok(['restore', 'automation', 'disabled'].includes(mode), 'Use the isolated workspace departure fixture.');
assert.ok(directory, 'Provide a fresh synthetic evidence directory.');

function loopback(address) {
  const url = new URL(address);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.port && !['18080', '18090'].includes(url.port) && url.pathname === '/'
    && !url.username && !url.password && !url.search && !url.hash);
  return url;
}

let origin = loopback(source);
const restored = target && loopback(target);
assert.equal(Boolean(restored), mode === 'restore');
const evidence = resolve(directory);
await mkdir(evidence, { recursive: true });
const actors = [];

async function request(path, expected, { actor, method = 'GET', body, key, text = false } = {}) {
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
  const data = response.status === 204 ? undefined
    : text && response.ok ? await response.text() : await response.json().catch(() => null);
  assert.equal(response.status, expected, method + ' ' + path + ' → ' + (data?.code ?? ''));
  if (path.endsWith('/leave') || path.endsWith('/leave-preview')) {
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
  }
  return data;
}

async function register() {
  const credentials = { username: 'qa-leave-' + randomUUID().slice(0, 10), password: 'Qa.WorkspaceLeave-' + randomUUID() };
  const { accessToken, user } = await request('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { token: accessToken, id: user.id, workspace: user.workspaceId, username: user.username };
  actors.push(actor);
  return actor;
}

async function mark(name, data) {
  const path = join(evidence, name + '.json');
  await writeFile(path + '.tmp', JSON.stringify(data) + '\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

async function until(name) {
  const path = join(evidence, name + '.json');
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(125);
  }
  assert.fail('Fixture did not complete ' + name + '.json.');
}

async function waitFor(probe, check, label, milliseconds = 30_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const current = await probe();
    if (check(current)) return current;
    await delay(125);
  }
  assert.fail(label);
}

const scoped = (workspace) => '/auth/workspaces/' + workspace;
const preview = (actor, workspace, expected = 200) =>
  request(scoped(workspace) + '/leave-preview', expected, { actor });
const leave = (actor, workspace, membershipRevision, confirm = true, expected = 204) =>
  request(scoped(workspace) + '/leave', expected, { actor, method: 'POST', body: { membershipRevision, confirm } });
const converse = (actor, title) => request('/conversations', 201, { actor, method: 'POST', body: { title } });
const enqueue = (actor, conversationId, content) =>
  request('/conversations/' + conversationId + '/runs', 202, {
    actor, method: 'POST', key: randomUUID(), body: { action: 'send', modelId: 'local-echo', content },
  });
const run = (actor, id, expected = 200) => request('/runs/' + id, expected, { actor });
const readShare = (actor, token, expected = 200) => request('/shares/read', expected, {
  actor, method: 'POST', body: { token },
});
const projects = (actor, name) => request('/projects', 201, { actor, method: 'POST', body: { name } });
const invitations = (projectId) => '/projects/' + projectId + '/collaboration/invitations';

async function share(actor, conversation, source) {
  const shape = { sourceMessageId: source, scope: 'reply', audience: 'workspace' };
  const base = '/conversations/' + conversation.id;
  const checked = await request(base + '/share-previews', 200, { actor, method: 'POST', body: shape });
  return request(base + '/shares', 201, { actor, method: 'POST', body: { ...shape, revision: checked.revision } });
}

async function grant(owner, recipient, id) {
  const created = await request(invitations(id), 201, {
    actor: owner, method: 'POST', body: { recipientUsername: recipient.username, role: 'viewer' },
  });
  await request('/collaboration/invitations/' + created.id + '/accept', 200, {
    actor: recipient, method: 'POST', body: { confirm: true },
  });
  return created;
}

async function exercise(owner) {
  const home = await register();
  const member = { ...home, workspace: owner.workspace };
  const workspace = owner.workspace;
  const personal = await converse(home, 'Independent personal synthetic conversation');
  assert.equal((await preview(home, home.workspace, 403)).code, 'PERSONAL_WORKSPACE');
  assert.equal((await preview(home, workspace, 404)).code, 'NOT_FOUND');
  await request(scoped(workspace) + '/leave-preview', 401);
  await mark('membership-ready', { workspace, ownerAccount: owner.id, member: member.id });
  await until('membership-added');
  const membership = await preview(home, workspace);
  assert.deepEqual(Object.keys(membership).sort(), ['membershipRevision', 'workspaceId']);
  assert.equal(membership.workspaceId, workspace);
  assert.match(membership.membershipRevision, /^[0-9a-f-]{36}$/);
  assert.equal((await leave(home, workspace, membership.membershipRevision, false, 400)).code, 'VALIDATION_ERROR');
  assert.equal((await leave(home, workspace, randomUUID(), true, 409)).code, 'WORKSPACE_MEMBERSHIP_CHANGED');
  assert.ok((await request('/auth/workspaces', 200, { actor: home })).items.some(item => item.id === workspace));
  const ownerProject = await projects(owner, 'Owner project');
  const departingProject = await projects(member, 'Departing user project in organization');
  const inward = await grant(owner, member, ownerProject.id);
  const outward = await grant(member, owner, departingProject.id);

  const sourceConversation = await converse(member, 'Owned workspace published conversation');
  const finishedSource = await enqueue(member, sourceConversation.id, 'Approved text-only workspace share');
  const sourceReply = await waitFor(() => run(member, finishedSource.runId), ({ state }) => state === 'completed',
    'The synthetic source reply did not finish.');
  const linked = await share(member, sourceConversation, sourceReply.messageId);
  assert.equal((await readShare(owner, linked.token)).messages.at(-1).content, sourceReply.content);
  const exported = await request('/conversations/' + sourceConversation.id + '/exports', 202, {
    actor: member, method: 'POST', key: randomUUID(), body: { sourceMessageId: sourceReply.messageId },
  });
  await waitFor(() => request('/jobs/' + exported.id, 200, { actor: member }),
    ({ status, progress }) => status === 'running' && progress === 50, 'Workspace export did not reach its checkpoint.');
  const activeConversation = await converse(member, 'Workspace active generation');
  const queuedConversation = await converse(member, 'Workspace queued generation');
  const content = '必须在有效退出后停止的合成内容'.repeat(160);
  const active = await enqueue(member, activeConversation.id, content);
  await waitFor(() => run(member, active.runId), ({ state, content: output }) => state === 'running' && output.length > 0,
    'The old active run did not start.');
  const queued = await enqueue(member, queuedConversation.id, 'This queued workspace action may never start after departure.');
  const personalRun = await enqueue(home, personal.id, 'Independent personal run should complete.');
  assert.equal(queued.state, 'queued');
  await mark('snapshot-ready', { workspace, member: member.id, membership: membership.membershipRevision,
    active: active.runId, queued: queued.runId, personal: personalRun.runId, grantIn: inward.id, grantOut: outward.id,
    share: linked.id, job: exported.id });
  await until('snapshot-done');

  await leave(home, workspace, membership.membershipRevision);
  const blocked = async () => {
    assert.equal((await request('/auth/me', 403, { actor: member })).code, 'FORBIDDEN');
    assert.equal((await request('/auth/me', 200, { actor: home })).workspaceId, home.workspace);
    assert.ok(!(await request('/auth/workspaces', 200, { actor: home })).items.some(item => item.id === workspace));
    assert.equal((await preview(home, workspace, 404)).code, 'NOT_FOUND');
    await run(member, active.runId, 403);
    await run(member, queued.runId, 403);
    await request('/jobs/' + exported.id, 403, { actor: member });
    await readShare(owner, linked.token, 404);
    assert.deepEqual((await request('/collaboration/projects', 200, { actor: owner })).items, []);
    await leave(home, workspace, membership.membershipRevision);
    await waitFor(() => run(home, personalRun.runId), ({ state }) => state === 'completed',
      'Personal generation was unexpectedly cancelled by another workspace departure.');
  };
  await blocked();
  await mark('revoke-ready', { onlineDepartureVerified: true });
  await until('database-switched');
  origin = restored;
  await blocked();
  await mark('rejoin-ready', { workspace, member: member.id, departedRevision: membership.membershipRevision });
  await until('membership-renewed');
  const renewed = await preview(home, workspace);
  const marker = JSON.parse(await readFile(join(evidence, 'membership-renewed.json'), 'utf8'));
  assert.equal(renewed.membershipRevision, marker.membershipRevision);
  assert.notEqual(renewed.membershipRevision, membership.membershipRevision);
  assert.equal((await leave(home, workspace, membership.membershipRevision, true, 409)).code,
    'WORKSPACE_MEMBERSHIP_CHANGED');
  assert.equal((await request('/auth/me', 200, { actor: member })).workspaceId, workspace);
  await readShare(owner, linked.token, 404);
  assert.equal((await run(member, active.runId)).state, 'cancelled');
  assert.equal((await run(member, queued.runId)).state, 'cancelled');
  assert.equal((await run(member, queued.runId)).content, '');
  assert.equal((await request('/jobs/' + exported.id, 200, { actor: member })).status, 'cancelled');
  assert.deepEqual((await request('/collaboration/projects', 200, { actor: member })).items, []);
  assert.deepEqual((await request('/collaboration/projects', 200, { actor: owner })).items, []);
  const newGrant = await grant(owner, member, ownerProject.id);
  assert.notEqual(newGrant.id, inward.id);
  const newShare = await share(member, sourceConversation, sourceReply.messageId);
  assert.notEqual(newShare.id, linked.id);
  await readShare(owner, linked.token, 404);
  await readShare(owner, newShare.token);
  return { authenticatedSelfDeparture: true, personalWorkspaceProtected: true, personalSessionPreserved: true,
    retiredRoleBothDirections: true, retiredPublisherShare: true, oldSessionScopedReadsDenied: true,
    queuedAndRunningSettled: true, localExportCancelled: true, olderBackupReplay: true,
    reenrollmentRevisionSafe: true, explicitNewAuthorizationOnly: true };
}

async function automation(owner) {
  const home = await register();
  const workspace = owner.workspace;
  const member = { ...home, workspace };
  const schedules = '/automations/reminders';
  const templateRead = (token, expected) => request('/automations/reminder-shares/read', expected, {
    actor: owner, method: 'POST', body: { token },
  });
  const createReminder = (actor, title) => request(schedules, 201, {
    actor, method: 'POST', key: randomUUID(),
    body: { title, startsAtLocal: '2030-06-15T22:10', timeZone: 'Asia/Shanghai', cadence: 'once' },
  });
  const makeTemplate = async (id) => {
    const checked = await request(schedules + '/' + id + '/share-preview', 200, { actor: member, method: 'POST' });
    return request(schedules + '/' + id + '/shares', 201, {
      actor: member, method: 'POST', body: { revision: checked.revision },
    });
  };
  const personalReminder = await createReminder(home, 'Independent personal synthetic reminder');
  await mark('membership-ready', { workspace, ownerAccount: owner.id, member: member.id });
  await until('membership-added');
  const generation = await preview(home, workspace);
  const reminder = await createReminder(member, 'Workspace synthetic reminder');
  assert.equal(reminder.state, 'active');
  const shared = await makeTemplate(reminder.id);
  await templateRead(shared.token, 200);

  const sourceId = 'ba8f4c14-4979-487a-b6af-eefd5aed2001';
  const { items } = await request('/research/sources?limit=10', 200, { actor: member });
  assert.ok(items.some(({ id }) => id === sourceId));
  const plan = await request('/research', 201, {
    actor: member, method: 'POST', key: randomUUID(),
    body: { question: '合成工作空间审核来源研究', sourceIds: [sourceId] },
  });
  const view = '/research/' + plan.id;
  const approve = (revision = plan.revision, expected = 202) => request(view + '/approve', expected, {
    actor: member, method: 'POST', body: { revision },
  });
  await approve();
  await waitFor(() => request(view, 200, { actor: member }), ({ state, progress }) =>
    state === 'running' && progress === 50, 'The approved plan did not reach its first checkpoint.');
  await leave(home, workspace, generation.membershipRevision);
  await request(view, 403, { actor: member });
  await request(schedules + '/' + reminder.id, 403, { actor: member });
  await templateRead(shared.token, 404);
  assert.equal((await request(schedules + '/' + personalReminder.id, 200, { actor: home })).state, 'active');
  await mark('rejoin-ready', { workspace, member: member.id, departedRevision: generation.membershipRevision,
    research: plan.id, reminder: reminder.id, template: shared.id });
  await until('membership-renewed');
  assert.notEqual((await preview(home, workspace)).membershipRevision, generation.membershipRevision);
  assert.equal((await leave(home, workspace, generation.membershipRevision, true, 409)).code,
    'WORKSPACE_MEMBERSHIP_CHANGED');
  const cancelled = await request(view, 200, { actor: member });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.progress, 0);
  await request(view + '/report', 409, { actor: member, text: true });
  assert.equal((await approve(plan.revision, 409)).code, 'CONFLICT');
  assert.equal((await request(schedules + '/' + reminder.id, 200, { actor: member })).state, 'paused');
  await templateRead(shared.token, 404);
  const reopened = await request(schedules + '/' + reminder.id, 200, {
    actor: member, method: 'PATCH', body: { active: true },
  });
  assert.equal(reopened.state, 'active');
  await templateRead(shared.token, 404);
  const newShare = await makeTemplate(reminder.id);
  assert.notEqual(newShare.id, shared.id);
  await templateRead(newShare.token, 200);
  const newPlan = await request(view, 200, {
    actor: member, method: 'PATCH',
    body: { expectedRevision: plan.revision, question: '重新授权后的合成研究', sourceIds: [sourceId] },
  });
  assert.equal(newPlan.revision, plan.revision + 1);
  await approve(newPlan.revision);
  await waitFor(() => request(view, 200, { actor: member }), ({ state }) => state === 'completed',
    'Explicitly reapproved current-scope plan did not complete.');
  const report = await request(view + '/report', 200, { actor: member, text: true });
  assert.match(report, /合成陈述甲/);
  return { activeResearchApprovalCancelled: true, oldReportDenied: true,
    activeCalendarPaused: true, oldReminderTemplateRemainedRevoked: true,
    personalReminderUnchanged: true, freshMembershipRequired: true,
    explicitResearchReapprovalOnly: true, explicitCalendarResumeAndRepublish: true };
}

try {
  const owner = await register();
  const { capabilities } = await request('/capabilities', 200, { actor: owner });
  assert.equal(capabilities.find(({ id }) => id === 'workspace_departure')?.available, mode !== 'disabled');
  const summary = mode === 'restore' ? await exercise(owner)
    : mode === 'automation' ? await automation(owner) : { workspaceDepartureDisabled: true };
  if (mode === 'disabled') {
    assert.equal((await preview(owner, randomUUID(), 403)).code, 'CAPABILITY_UNAVAILABLE');
  }
  await mark('summary', summary);
  console.log(JSON.stringify(summary));
} finally {
  for (const actor of actors) await request('/auth/logout', 204, { actor, method: 'POST' }).catch(() => undefined);
}
