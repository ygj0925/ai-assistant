import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [source, mode, directory, target] = process.argv.slice(2);
assert.ok(['restore', 'disabled'].includes(mode), 'Use the isolated comment/restore fixture.');
assert.ok(directory, 'Provide a new synthetic evidence directory.');

function loopback(address) {
  const value = new URL(address);
  assert.ok(value.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname)
    && value.port && value.port !== '18080' && value.pathname === '/'
    && !value.username && !value.password && !value.search && !value.hash);
  return value;
}

let origin = loopback(source);
const restored = target && loopback(target);
assert.equal(Boolean(restored), mode === 'restore');
const evidence = resolve(directory);
await mkdir(evidence, { recursive: true });
const accounts = [];

async function request(path, expected, { actor, method = 'GET', body, key } = {}) {
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
  assert.equal(response.status, expected, method + ' ' + path + ' → ' + (data?.code ?? ''));
  if (path.includes('/artifact-publications')) {
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
  }
  return data;
}

async function register() {
  const credentials = { username: 'qa-comment-' + randomUUID().slice(0, 10), password: 'Qa.Comment-' + randomUUID() };
  const { accessToken, user } = await request('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { token: accessToken, id: user.id, workspace: user.workspaceId, credentials };
  accounts.push(actor);
  return actor;
}

async function mark(name, data) {
  const path = join(evidence, name + '.json');
  await writeFile(path + '.tmp', JSON.stringify(data) + '\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

async function waitFor(name) {
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

const publications = (project) => '/collaboration/projects/' + project + '/artifact-publications';
const invitations = (project) => '/projects/' + project + '/collaboration/invitations';
const commentPath = (project, publication, id) =>
  publications(project) + '/' + publication + '/comments' + (id ? '/' + id : '');
const list = (actor, project, publication, expected = 200) =>
  request(commentPath(project, publication), expected, { actor });
const create = (actor, project, publication, content, key = randomUUID(), expected = 201) =>
  request(commentPath(project, publication), expected, { actor, method: 'POST', body: { content }, key });
const remove = (actor, path, expected = 204) => request(path, expected, { actor, method: 'DELETE' });

async function publish(owner, project, title) {
  const draft = await request('/artifacts', 201, { actor: owner, method: 'POST', key: randomUUID(),
    body: { projectId: project, title, format: 'markdown', content: '# 合成的固定版本 🧪\n' } });
  return request(publications(project), 201, { actor: owner, method: 'POST',
    body: { artifactId: draft.id, versionId: draft.head.id, confirm: true } });
}

async function grant(owner, recipient, project, role) {
  const invitation = await request(invitations(project), 201, {
    actor: owner, method: 'POST', body: { recipientUsername: recipient.credentials.username, role },
  });
  await request('/collaboration/invitations/' + invitation.id + '/accept', 200, {
    actor: recipient, method: 'POST', body: { confirm: true },
  });
  return invitation;
}

async function exercise(owner) {
  const authorHome = await register();
  const editor = { ...authorHome, workspace: owner.workspace };
  const viewer = { ...await register(), workspace: owner.workspace };
  const project = await request('/projects', 201, { actor: owner, method: 'POST', body: { name: 'Synthetic commenting project' } });
  const otherProject = await request('/projects', 201, { actor: owner, method: 'POST', body: { name: 'Other synthetic project' } });
  const stable = await publish(owner, project.id, 'Comment-bearing published version');
  const withdrawn = await publish(owner, project.id, 'Future withdrawn publication');
  await request(commentPath(project.id, stable.id), 401);
  await mark('membership-ready', { workspace: owner.workspace, ownerAccount: owner.id,
    members: [editor.id, viewer.id] });
  await waitFor('membership-added');
  await list(editor, project.id, stable.id, 404);
  const editorGrant = await grant(owner, editor, project.id, 'editor');
  await grant(owner, viewer, project.id, 'viewer');
  await list(viewer, otherProject.id, stable.id, 404);
  assert.deepEqual((await list(viewer, project.id, stable.id)).items, []);

  const permanent = await create(owner, project.id, stable.id, '作者与读取权限的合成控制评论');
  assert.equal((await create(viewer, project.id, stable.id, 'viewer cannot write', randomUUID(), 403)).code,
    'FORBIDDEN');
  assert.equal((await remove(viewer, commentPath(project.id, stable.id, permanent.id), 403)).code, 'FORBIDDEN');
  assert.equal((await remove(editor, commentPath(project.id, stable.id, permanent.id), 403)).code, 'FORBIDDEN');
  for (const invalid of ['', '  ', '\u0007', '\uD800', '🧪'.repeat(1025)]) {
    assert.equal((await create(editor, project.id, stable.id, invalid, randomUUID(), 400)).code, 'VALIDATION_ERROR');
  }
  assert.equal((await create(editor, project.id, stable.id, '合法正文', 'not-a-uuid', 400)).code, 'VALIDATION_ERROR');
  const lengthLimit = await create(editor, project.id, stable.id, '🧪'.repeat(1024));
  assert.equal(Buffer.byteLength(lengthLimit.content), 4096);
  await remove(editor, commentPath(project.id, stable.id, lengthLimit.id));
  const key = randomUUID();
  const removedBody = '精确保留的评论内容 🧪\n第二行';
  const [deleted, retry] = await Promise.all([
    create(editor, project.id, stable.id, removedBody, key),
    create(editor, project.id, stable.id, removedBody, key),
  ]);
  assert.deepEqual(deleted, retry);
  assert.deepEqual(Object.keys(deleted).sort(), ['authoredByMe', 'canDelete', 'content', 'createdAt', 'id']);
  assert.equal((await create(editor, project.id, stable.id, 'Same request key, changed content', key, 409)).code,
    'CONFLICT');
  const preservedAuthor = await create(editor, project.id, stable.id, '作者离开后仍存在的协作内容');
  const attached = await create(editor, project.id, withdrawn.id, '所属发布撤回时级联删除的评论');
  await remove(editor, commentPath(project.id, withdrawn.id, deleted.id), 404);
  const viewerRows = (await list(viewer, project.id, stable.id)).items;
  assert.equal(viewerRows.length, 3);
  assert.ok(viewerRows.every(({ canDelete, authoredByMe }) => !canDelete && !authoredByMe));
  const authorRows = (await list(editor, project.id, stable.id)).items;
  assert.deepEqual(authorRows.filter(({ authoredByMe, canDelete }) => authoredByMe && canDelete)
    .map(({ id }) => id).sort(), [deleted.id, preservedAuthor.id].sort());

  const quotaPublication = await publish(owner, project.id, 'Quota-only published fixture');
  for (let index = 0; index < 64; index++) {
    await create(owner, project.id, quotaPublication.id, 'Synthetic quota comment ' + index);
  }
  assert.equal((await list(viewer, project.id, quotaPublication.id)).items.length, 64);
  assert.equal((await create(owner, project.id, quotaPublication.id, 'Cannot exceed limit', randomUUID(), 409)).code,
    'CONFLICT');
  await remove(owner, publications(project.id) + '/' + quotaPublication.id);
  await list(viewer, project.id, quotaPublication.id, 404);

  await mark('snapshot-ready', { project: project.id, deleted: deleted.id, control: permanent.id,
    publicationRevoked: withdrawn.id, attached: attached.id, persistentAuthor: preservedAuthor.id,
    grant: editorGrant.id });
  await waitFor('snapshot-done');
  await remove(owner, commentPath(project.id, stable.id, deleted.id));
  assert.equal((await create(editor, project.id, stable.id, removedBody, key, 404)).code, 'NOT_FOUND');
  await remove(owner, publications(project.id) + '/' + withdrawn.id);
  await remove(owner, invitations(project.id) + '/' + editorGrant.id);

  const denied = async () => {
    await list(editor, project.id, stable.id, 404);
    await create(editor, project.id, stable.id, removedBody, key, 404);
    await remove(editor, commentPath(project.id, stable.id, preservedAuthor.id), 404);
    await list(viewer, project.id, withdrawn.id, 404);
    await list(owner, project.id, withdrawn.id, 404);
    const controls = (await list(viewer, project.id, stable.id)).items;
    assert.deepEqual(controls.map(({ id }) => id).sort(), [permanent.id, preservedAuthor.id].sort());
    await remove(owner, commentPath(project.id, stable.id, deleted.id), 404);
  };
  await denied();
  await mark('revoke-ready', { onlineRevocationsVerified: true });
  await waitFor('database-switched');
  origin = restored;
  await denied();
  const refreshed = await grant(owner, editor, project.id, 'editor');
  assert.notEqual(refreshed.id, editorGrant.id);
  assert.equal((await create(editor, project.id, stable.id, removedBody, key, 404)).code, 'NOT_FOUND');
  const fresh = await create(editor, project.id, stable.id, removedBody);
  assert.notEqual(fresh.id, deleted.id);
  await request('/privacy/account-erasure', 204, { actor: authorHome, method: 'POST',
    body: { currentPassword: authorHome.credentials.password, confirmation: 'DELETE' } });
  assert.deepEqual((await list(viewer, project.id, stable.id)).items.map(({ id }) => id), [permanent.id]);
  return { immutablePublicationScope: true, viewerReadonly: true, ownerAndEditorAuthorship: true,
    concurrentIdempotency: true, boundedTextAndQuota: true, oldGrantDenied: true,
    oldCommentRetryDenied: true, publicationCascadeVerified: true, authorErasureVerified: true,
    olderBackupReplay: true, unchangedControl: true, freshRequestReopened: true };
}

try {
  const owner = await register();
  const { capabilities } = await request('/capabilities', 200, { actor: owner });
  assert.equal(capabilities.find(({ id }) => id === 'project_artifact_comments')?.available, mode !== 'disabled');
  const summary = mode === 'restore' ? await exercise(owner)
    : { commentsDisabled: true, publicationAvailable: true };
  if (mode === 'disabled') {
    assert.equal(capabilities.find(({ id }) => id === 'project_artifact_publications')?.available, true);
    assert.equal((await list(owner, randomUUID(), randomUUID(), 403)).code, 'CAPABILITY_UNAVAILABLE');
  }
  await mark('summary', summary);
  console.log(JSON.stringify(summary));
} finally {
  for (const actor of accounts) await request('/auth/logout', 204, { actor, method: 'POST' }).catch(() => undefined);
}
