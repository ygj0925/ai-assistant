import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [source, mode, directory, target] = process.argv.slice(2);
assert.ok(['restore', 'enabled', 'disabled'].includes(mode), 'Choose a verification mode.');

function loopback(address) {
  const url = new URL(address);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    url.port && url.port !== '18080' && url.pathname === '/' && !url.username && !url.password &&
    !url.search && !url.hash, 'Use a dedicated loopback API.');
  return url;
}

let origin = loopback(source);
const restored = target && loopback(target);
assert.equal(Boolean(restored), mode === 'restore');
const evidence = directory && resolve(directory);
assert.ok(evidence || mode === 'disabled', 'Provide a fresh directory for the synthetic fixture driver.');
if (evidence) await mkdir(evidence, { recursive: true });

const prefix = '/api/assistant/v1';
const inbox = '/collaboration/invitations';
const shared = '/collaboration/projects';
const sessions = [];
const privateText = 'PRIVATE project material sentinel. Synthetic only.';
const visibleText = '共享文本记录 🧪\n明确提交的测试内容。';

async function call(path, status, { actor, method = 'GET', body } = {}) {
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
  const data = response.status === 204 ? undefined : await response.json().catch(() => null);
  assert.equal(response.status, status, method + ' ' + path + ' → ' + (data?.code ?? ''));
  if (path.includes('/collaboration/')) {
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
  }
  return data;
}

async function register() {
  const credentials = {
    username: 'qa-collab-' + randomUUID().slice(0, 10),
    password: 'Qa.Collab-' + randomUUID(),
  };
  const { accessToken, user } = await call('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { token: accessToken, id: user.id, workspace: user.workspaceId, credentials };
  sessions.push(actor);
  return actor;
}

async function mark(name, data) {
  const path = join(evidence, name + '.json');
  await writeFile(path + '.tmp', JSON.stringify(data) + '\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

async function until(name, milliseconds = 150_000) {
  const path = join(evidence, name + '.json');
  const deadline = Date.now() + milliseconds;
  do {
    try {
      await access(path);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(125);
  } while (Date.now() < deadline);
  throw new Error('Fixture did not produce ' + name + '.json');
}

const endpoint = (id) => '/projects/' + id + '/collaboration/invitations';
const materials = (project, material) => shared + '/' + project + '/materials' + (material ? '/' + material : '');
const membership = (project) => shared + '/' + project + '/membership';
const invite = (owner, project, user, role, status = 201) =>
  call(endpoint(project), status, { actor: owner, method: 'POST', body: { recipientUsername: user, role } });
const accept = (actor, id, confirm = true, status = 200) =>
  call(inbox + '/' + id + '/accept', status, { actor, method: 'POST', body: { confirm } });
const remove = (actor, path, status = 204) => call(path, status, { actor, method: 'DELETE' });
const write = (actor, project, name, content = visibleText, status = 201) =>
  call(materials(project), status, { actor, method: 'POST', body: { name, content } });

async function availability(actor) {
  const { capabilities } = await call('/capabilities', 200, { actor });
  assert.equal(capabilities.find(({ id }) => id === 'project_collaboration')?.available, mode !== 'disabled');
}

async function exercise(owner) {
  const [outside, realViewer, realEditor] = [await register(), await register(), await register()];
  const viewer = { ...realViewer, workspace: owner.workspace };
  const editor = { ...realEditor, workspace: owner.workspace };
  const inOther = { ...outside, workspace: owner.workspace };
  const makeProject = (name) => call('/projects', 201, { actor: owner, method: 'POST',
    body: { name, description: privateText } });
  const project = await makeProject('Synthetic collaboration project');
  const otherProject = await makeProject('Synthetic second project');
  await call(inbox, 401);
  assert.equal((await invite(owner, project.id, viewer.credentials.username, 'viewer', 404)).code, 'NOT_FOUND');
  assert.equal((await invite(owner, project.id, outside.credentials.username, 'viewer', 404)).code, 'NOT_FOUND');
  assert.equal((await call(inbox, 403, { actor: inOther })).code, 'FORBIDDEN');

  await mark('membership-ready', { ownerAccount: owner.id, workspace: owner.workspace, members: [viewer.id, editor.id] });
  await until('membership-added');

  const privateResource = await call('/projects/' + project.id + '/resources', 201, {
    actor: owner, method: 'POST', body: { name: 'Private fixture', content: privateText },
  });
  const privateConversation = await call('/conversations', 201, { actor: owner, method: 'POST',
    body: { title: 'Private conversation fixture', projectId: project.id } });
  const source = await write(owner, project.id, 'Reviewed shared text');
  const survivor = await write(owner, project.id, 'Valid control text');
  assert.deepEqual(Object.keys(source).sort(), ['canDelete', 'content', 'createdAt', 'id', 'name']);
  assert.equal(source.content, visibleText);
  assert.equal(source.canDelete, true);
  assert.equal((await write(owner, project.id, 'Invalid text', '\u0007', 400)).code, 'VALIDATION_ERROR');
  assert.equal((await write(owner, project.id, 'Invalid surrogate', '\uD800', 400)).code, 'VALIDATION_ERROR');
  assert.equal((await write(owner, project.id, 'Over total UTF-8 limit', '🧪'.repeat(4097), 400)).code, 'VALIDATION_ERROR');
  const maximum = await write(owner, project.id, 'Valid total UTF-8 limit', '🧪'.repeat(4096));
  assert.equal(Buffer.byteLength(maximum.content, 'utf8'), 16_384);
  await remove(owner, materials(project.id, maximum.id));
  assert.deepEqual((await call(materials(project.id), 200, { actor: owner })).items
    .map(item => item.id).sort(), [source.id, survivor.id].sort());
  assert.equal((await invite(owner, project.id, owner.credentials.username, 'viewer', 400)).code, 'VALIDATION_ERROR');
  assert.equal((await invite(owner, project.id, viewer.credentials.username, 'owner', 400)).code, 'VALIDATION_ERROR');
  const invitation = await invite(owner, project.id, viewer.credentials.username, 'viewer');
  assert.equal(invitation.recipientUsername, viewer.credentials.username);
  assert.equal(invitation.projectName, project.name);
  assert.equal(invitation.projectId, project.id);
  assert.equal(invitation.state, 'pending');
  assert.equal(Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt), 7 * 86_400_000);
  assert.equal((await invite(owner, project.id, viewer.credentials.username, 'editor', 409)).code, 'CONFLICT');
  assert.deepEqual((await call(inbox, 200, { actor: realViewer })).items, []);
  assert.deepEqual((await call(inbox, 200, { actor: editor })).items, []);
  const offered = (await call(inbox, 200, { actor: viewer })).items;
  assert.equal(offered.length, 1);
  assert.deepEqual(Object.keys(offered[0]).sort(),
    ['createdAt', 'expiresAt', 'id', 'projectId', 'projectName', 'role', 'state']);
  await call(materials(project.id), 404, { actor: viewer });
  await accept(editor, invitation.id, true, 404);
  await accept(realViewer, invitation.id, true, 404);
  await accept(viewer, invitation.id, false, 400);
  const confirmed = await Promise.all([accept(viewer, invitation.id), accept(viewer, invitation.id)]);
  assert.deepEqual(confirmed[0], confirmed[1]);
  assert.equal(confirmed[0].state, 'accepted');
  assert.ok(Date.parse(confirmed[0].acceptedAt) >= Date.parse(invitation.createdAt));
  assert.deepEqual((await call(inbox, 200, { actor: viewer })).items, []);
  assert.deepEqual((await call(shared, 200, { actor: viewer })).items,
    [{ id: project.id, name: project.name, role: 'viewer' }]);
  await call(endpoint(project.id), 404, { actor: viewer });
  await call('/projects/' + project.id, 404, { actor: viewer });
  await call('/projects/' + project.id + '/resources/' + privateResource.id, 404, { actor: viewer });
  await call('/conversations/' + privateConversation.id + '/messages', 404, { actor: viewer });
  await call(materials(project.id, privateResource.id), 404, { actor: viewer });
  await call(materials(otherProject.id, source.id), 404, { actor: viewer });
  const allowed = await call(materials(project.id, source.id), 200, { actor: viewer });
  assert.equal(allowed.content, visibleText);
  assert.equal(allowed.canDelete, false);
  assert.equal((await write(viewer, project.id, 'Viewer cannot publish', visibleText, 403)).code, 'FORBIDDEN');
  assert.equal((await remove(viewer, materials(project.id, source.id), 403)).code, 'FORBIDDEN');

  const editorInvite = await invite(owner, project.id, editor.credentials.username, 'editor');
  await accept(editor, editorInvite.id);
  const editorSample = await write(editor, project.id, 'Editor retains own text');
  const removable = await write(editor, project.id, 'Editor removes own text');
  const canRemove = (await call(materials(project.id), 200, { actor: editor })).items
    .filter(({ canDelete }) => canDelete).map(({ id }) => id).sort();
  assert.deepEqual(canRemove, [editorSample.id, removable.id].sort());
  assert.equal((await remove(editor, materials(project.id, source.id), 403)).code, 'FORBIDDEN');
  await remove(editor, materials(project.id, removable.id));
  await call(materials(project.id, removable.id), 404, { actor: owner });
  const pending = await invite(owner, otherProject.id, viewer.credentials.username, 'viewer');
  await call(materials(otherProject.id), 404, { actor: viewer });
  await mark('workspace-loss-ready', { ownerAccount: owner.id, workspace: owner.workspace, editor: editor.id });
  await until('workspace-member-removed');
  assert.equal((await call(materials(project.id, survivor.id), 403, { actor: editor })).code, 'FORBIDDEN');
  assert.deepEqual((await call(shared, 200, { actor: realEditor })).items, []);
  await mark('workspace-loss-confirmed', { keptGrantBlockedByMembership: true });
  await until('workspace-member-restored');
  await call(materials(project.id, survivor.id), 200, { actor: editor });

  if (mode === 'restore') {
    await mark('snapshot-ready', { project: project.id, revokedGrant: invitation.id, leftGrant: editorInvite.id,
      declinedGrant: pending.id, deletedText: source.id, controlText: survivor.id, authorText: editorSample.id });
    await until('snapshot-done');
  }
  await remove(owner, endpoint(project.id) + '/' + invitation.id);
  await remove(owner, endpoint(project.id) + '/' + invitation.id);
  await remove(editor, membership(project.id));
  await remove(viewer, inbox + '/' + pending.id);
  await remove(owner, materials(project.id, source.id));

  const checkRevoke = async () => {
    assert.deepEqual((await call(shared, 200, { actor: viewer })).items, []);
    assert.deepEqual((await call(shared, 200, { actor: editor })).items, []);
    await call(materials(project.id), 404, { actor: viewer });
    await call(materials(project.id, survivor.id), 404, { actor: viewer });
    await call(materials(project.id, editorSample.id), 404, { actor: editor });
    await accept(viewer, invitation.id, true, 404);
    await accept(editor, editorInvite.id, true, 404);
    await accept(viewer, pending.id, true, 404);
    assert.deepEqual((await call(inbox, 200, { actor: viewer })).items, []);
    await call(materials(project.id, source.id), 404, { actor: owner });
    await call(materials(project.id, survivor.id), 200, { actor: owner });
  };
  await checkRevoke();
  if (mode === 'restore') {
    await mark('revoke-ready', { oldScopesDenied: true });
    await until('database-switched');
    origin = restored;
    await checkRevoke();
  }

  const fresh = await invite(owner, project.id, viewer.credentials.username, 'viewer');
  assert.notEqual(fresh.id, invitation.id);
  await accept(viewer, invitation.id, true, 404);
  await accept(viewer, fresh.id);
  assert.equal((await call(materials(project.id, survivor.id), 200, { actor: viewer })).content, visibleText);
  await call(materials(project.id, source.id), 404, { actor: viewer });
  await call(materials(project.id, editorSample.id), 200, { actor: owner });
  await call('/privacy/account-erasure', 204, { actor: realEditor, method: 'POST',
    body: { currentPassword: realEditor.credentials.password, confirmation: 'DELETE' } });
  await call(materials(project.id, editorSample.id), 404, { actor: owner });
  await call(materials(project.id, editorSample.id), 404, { actor: viewer });
  return { authorizedPrivateProjectsUnchanged: true, explicitTextOnly: true, scopedInbox: true,
    sameWorkspaceMembership: true, currentWorkspaceLossDenied: true, concurrentAcceptanceIdempotent: true, viewerReadonly: true,
    editorOwnWrite: true, existingSessionsRevoked: true, olderBackupReplay: mode === 'restore',
    reInviteWithFreshGrant: true, accountErasureRemovesAuthoredText: true };
}

try {
  const owner = await register();
  await availability(owner);
  const summary = mode === 'disabled'
    ? { defaultDisabled: (await call(inbox, 403, { actor: owner })).code === 'CAPABILITY_UNAVAILABLE' }
    : await exercise(owner);
  if (mode === 'disabled') assert.equal(summary.defaultDisabled, true);
  if (evidence) await mark('summary', summary);
  console.log(JSON.stringify(summary));
} finally {
  for (const actor of sessions) {
    await call('/auth/logout', 204, { actor, method: 'POST' }).catch(() => undefined);
  }
}
