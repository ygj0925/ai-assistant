import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [source, mode, directory, target] = process.argv.slice(2);
assert.ok(['restore', 'disabled'].includes(mode), 'Use the isolated shared-draft fixture.');
assert.ok(directory, 'Provide a new synthetic evidence directory.');

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
const accounts = [];

async function request(path, expected, { actor, method = 'GET', body, bytes = false, detail = false } = {}) {
  const headers = { Accept: bytes ? 'text/markdown' : 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.token;
    headers['X-Workspace-Id'] = actor.workspace;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL('/api/assistant/v1' + path, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(12_000),
  });
  let data;
  if (response.status !== 204) {
    data = bytes && response.ok
      ? Buffer.from(await response.arrayBuffer()) : await response.json().catch(() => null);
  }
  const statuses = Array.isArray(expected) ? expected : [expected];
  assert.ok(statuses.includes(response.status), method + ' ' + path + ' → ' + response.status + ' ' + (data?.code ?? ''));
  if (path.includes('/shared-drafts')) {
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
  }
  return detail ? { data, status: response.status, headers: response.headers } : data;
}

async function register() {
  const credentials = { username: 'qa-draft-' + randomUUID().slice(0, 10), password: 'Qa.SharedDraft-' + randomUUID() };
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

const root = (project) => '/collaboration/projects/' + project + '/shared-drafts';
const invitations = (project) => '/projects/' + project + '/collaboration/invitations';
const draft = (project, id) => root(project) + '/' + id;
const revision = (project, id, version) => draft(project, id) + '/revisions/' + version;
const remove = (actor, path, expected = 204) => request(path, expected, { actor, method: 'DELETE' });
const create = (actor, project, title, content, confirm = true, expected = 201) =>
  request(root(project), expected, { actor, method: 'POST', body: { title, content, confirm } });
const save = (actor, project, id, baseRevisionId, title, content, expected = 201, detail = false) =>
  request(draft(project, id) + '/revisions', expected, {
    actor, method: 'POST', body: { baseRevisionId, title, content }, detail,
  });
const rollback = (actor, project, id, baseRevisionId, revisionId, expected = 201) =>
  request(draft(project, id) + '/rollback', expected, { actor, method: 'POST', body: { baseRevisionId, revisionId } });

function project(actor, name) {
  return request('/projects', 201, { actor, method: 'POST', body: { name } });
}

async function grant(owner, recipient, projectId, role) {
  const invite = await request(invitations(projectId), 201, {
    actor: owner, method: 'POST', body: { recipientUsername: recipient.credentials.username, role },
  });
  await request('/collaboration/invitations/' + invite.id + '/accept', 200, {
    actor: recipient, method: 'POST', body: { confirm: true },
  });
  return invite;
}

async function readDownload(actor, path, content) {
  const { data, headers } = await request(path + '/download', 200, { actor, bytes: true, detail: true });
  assert.deepEqual(data, Buffer.from(content));
  assert.match(headers.get('content-type') ?? '', /^text\/markdown;\s*charset=UTF-8$/i);
  assert.equal(headers.get('content-disposition'), 'attachment; filename="shared-draft.md"');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.match(headers.get('content-security-policy') ?? '', /sandbox/);
}

async function exercise(owner) {
  const firstHome = await register();
  const first = { ...firstHome, workspace: owner.workspace };
  const second = { ...await register(), workspace: owner.workspace };
  const viewer = { ...await register(), workspace: owner.workspace };
  const main = await project(owner, 'Synthetic Markdown collaboration');
  const outsider = await project(owner, 'Separate private synthetic project');
  await request(root(main.id), 401);
  await mark('membership-ready', { workspace: owner.workspace, ownerAccount: owner.id,
    members: [first.id, second.id, viewer.id] });
  await waitFor('membership-added');
  await request(root(main.id), 404, { actor: first });
  await grant(owner, first, main.id, 'editor');
  const retiredGrant = await grant(owner, second, main.id, 'editor');
  await grant(owner, viewer, main.id, 'viewer');

  assert.equal((await create(first, main.id, 'Editor cannot create', '', true, 403)).code, 'FORBIDDEN');
  assert.equal((await create(owner, main.id, 'Explicit consent required', '', false, 400)).code,
    'VALIDATION_ERROR');
  await request(root(main.id), 400, { actor: owner, method: 'POST',
    body: { title: 'No import', content: '', confirm: true, sourceArtifactId: randomUUID() } });
  assert.equal((await create(owner, main.id, 'Invalid code unit', '\uD800', true, 400)).code, 'VALIDATION_ERROR');
  assert.equal((await create(owner, main.id, 'Invalid control', '\u0007', true, 400)).code, 'VALIDATION_ERROR');
  assert.equal((await create(owner, main.id, 'Too much content', '🧪'.repeat(8193), true, 400)).code,
    'VALIDATION_ERROR');
  const boundary = await create(owner, outsider.id, 'Allowed maximum', '🧪'.repeat(8192));
  assert.equal(Buffer.byteLength(boundary.content), 32768);
  const publication = await create(owner, main.id, 'Original title', '# 原始共有草稿 🧪\n');
  const retired = await create(owner, main.id, 'Owner-deleted draft fixture', '待删除的合成文本');
  const retained = await create(owner, main.id, 'Independent control draft', '应保留的最初版本');
  assert.deepEqual(Object.keys(publication).sort(),
    ['canEdit', 'content', 'id', 'retentionPolicy', 'revisionId', 'title', 'updatedAt', 'versionNumber']);
  assert.equal(publication.retentionPolicy, 'affected_draft_erased');
  assert.equal(publication.versionNumber, 1);
  await request('/artifacts/' + publication.id, 404, { actor: owner });
  await request(draft(outsider.id, publication.id), 404, { actor: owner });
  const selected = await request(draft(main.id, publication.id), 200, { actor: viewer });
  assert.equal(selected.canEdit, false);
  assert.equal(selected.content, publication.content);
  assert.equal((await save(viewer, main.id, publication.id, publication.revisionId, 'Invalid write', '', 403)).code,
    'FORBIDDEN');
  assert.equal((await remove(first, draft(main.id, publication.id), 403)).code, 'FORBIDDEN');

  const contenders = await Promise.all([
    save(first, main.id, publication.id, publication.revisionId, 'First real editor', '编辑者一的版本', [201, 409], true),
    save(second, main.id, publication.id, publication.revisionId, 'Second real editor', '编辑者二的版本', [201, 409], true),
  ]);
  assert.deepEqual(contenders.map(({ status }) => status).sort(), [201, 409]);
  assert.equal(contenders.find(({ status }) => status === 409).data.code, 'CONFLICT');
  const winner = contenders.find(({ status }) => status === 201).data;
  assert.equal(winner.versionNumber, 2);
  assert.equal((await request(draft(main.id, publication.id), 200, { actor: owner })).revisionId,
    winner.revisionId);

  const sensitive = await save(first, main.id, publication.id, winner.revisionId, 'Later author-owned text',
    '账号注销应删除的合成文档片段');
  const derivative = await save(second, main.id, publication.id, sensitive.revisionId, 'Other editor copied content',
    '后续版本保留了这些文字\n' + sensitive.content);
  assert.equal(derivative.versionNumber, 4);
  assert.equal((await rollback(second, main.id, publication.id, winner.revisionId, publication.revisionId, 409)).code,
    'CONFLICT');
  await rollback(second, main.id, publication.id, derivative.revisionId, retained.revisionId, 404);
  const recovered = await rollback(second, main.id, publication.id, derivative.revisionId, publication.revisionId);
  assert.equal(recovered.versionNumber, 5);
  assert.notEqual(recovered.revisionId, publication.revisionId);
  assert.equal(recovered.content, publication.content);
  const history = (await request(draft(main.id, publication.id) + '/revisions', 200, { actor: second })).items;
  assert.deepEqual(history.map(({ versionNumber }) => versionNumber), [5, 4, 3, 2, 1]);
  assert.equal(history[0].authoredByMe, true);
  assert.equal(history[0].restoredFromRevisionId, publication.revisionId);
  assert.equal(history[2].authoredByMe, false);
  assert.ok(history.every((row) => !Object.hasOwn(row, 'content') && !Object.hasOwn(row, 'authorId')));
  await readDownload(viewer, revision(main.id, publication.id, derivative.revisionId), derivative.content);
  await request(revision(main.id, retained.id, derivative.revisionId), 404, { actor: owner });

  let quota = boundary;
  for (let order = 2; order <= 32; order++) {
    quota = await save(owner, outsider.id, quota.id, quota.revisionId, 'Revision ' + order, '');
    assert.equal(quota.versionNumber, order);
  }
  assert.equal((await save(owner, outsider.id, quota.id, quota.revisionId, 'Beyond version quota', '', 409)).code,
    'CONFLICT');
  for (let order = 2; order <= 32; order++) {
    await create(owner, outsider.id, 'Draft quota ' + order, '');
  }
  assert.equal((await request(root(outsider.id), 200, { actor: owner })).items.length, 32);
  assert.equal((await create(owner, outsider.id, 'Beyond draft quota', '', true, 409)).code, 'CONFLICT');

  await mark('snapshot-ready', { project: main.id, retired: retired.id, erased: publication.id,
    control: retained.id, descendant: derivative.revisionId, author: first.id, grant: retiredGrant.id });
  await waitFor('snapshot-done');
  await remove(owner, invitations(main.id) + '/' + retiredGrant.id);
  await request(draft(main.id, publication.id), 404, { actor: second });
  await save(second, main.id, publication.id, recovered.revisionId, 'Old editor cannot save', '拒绝', 404);
  await remove(owner, draft(main.id, retired.id));
  await request('/privacy/account-erasure', 204, { actor: firstHome, method: 'POST',
    body: { currentPassword: firstHome.credentials.password, confirmation: 'DELETE' } });

  const denied = async () => {
    await request(root(main.id), 404, { actor: second });
    await request(draft(main.id, publication.id), 404, { actor: owner });
    await request(draft(main.id, retired.id) + '/revisions', 404, { actor: viewer });
    const blocked = await request(revision(main.id, publication.id, derivative.revisionId) + '/download',
      404, { actor: viewer, bytes: true, detail: true });
    assert.equal(blocked.data.code, 'NOT_FOUND');
    assert.match(blocked.headers.get('content-type') ?? '', /^application\/json\b/i);
    assert.deepEqual((await request(root(main.id), 200, { actor: viewer })).items.map(({ id }) => id),
      [retained.id]);
    await readDownload(viewer, revision(main.id, retained.id, retained.revisionId), retained.content);
  };
  await denied();
  await mark('revoke-ready', { explicitDeletionAndAuthorErasureVerified: true });
  await waitFor('database-switched');
  origin = restored;
  await denied();
  const scope = await grant(owner, second, main.id, 'editor');
  assert.notEqual(scope.id, retiredGrant.id);
  await request(draft(main.id, publication.id), 404, { actor: second });
  const newDraft = await create(owner, main.id, retired.title, retired.content);
  assert.notEqual(newDraft.id, retired.id);
  await request(draft(main.id, retired.id), 404, { actor: second });
  return { twoEditorsCAS: true, immutableHistory: true, rollbackAppends: true,
    projectRoleAndAuthorship: true, exactMarkdownAttachment: true, noPrivateImport: true,
    revisionAndProjectQuotas: true, oldMembershipDenied: true, explicitDraftDeletion: true,
    erasedContributorAndDescendantRemoved: true, olderBackupReplay: true, unaffectedControl: true };
}

try {
  const owner = await register();
  const { capabilities } = await request('/capabilities', 200, { actor: owner });
  assert.equal(capabilities.find(({ id }) => id === 'project_shared_drafts')?.available, mode !== 'disabled');
  const summary = mode === 'restore' ? await exercise(owner)
    : { sharedDraftsDisabled: true, projectCollaborationAvailable: true };
  if (mode === 'disabled') {
    assert.equal(capabilities.find(({ id }) => id === 'project_collaboration')?.available, true);
    assert.equal((await request(root(randomUUID()), 403, { actor: owner })).code, 'CAPABILITY_UNAVAILABLE');
  }
  await mark('summary', summary);
  console.log(JSON.stringify(summary));
} finally {
  for (const actor of accounts) await request('/auth/logout', 204, { actor, method: 'POST' }).catch(() => undefined);
}
