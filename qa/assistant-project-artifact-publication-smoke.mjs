import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [source, mode, directory, target] = process.argv.slice(2);
assert.ok(['restore', 'disabled'].includes(mode), 'Use an isolated publication/restore fixture.');

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

const prefix = '/api/assistant/v1';
const publications = (project) => '/collaboration/projects/' + project + '/artifact-publications';
const invitations = (project) => '/projects/' + project + '/collaboration/invitations';
const privateDraft = '/artifacts';
const accounts = [];

async function request(path, expected, { actor, method = 'GET', body, key, bytes = false } = {}) {
  const headers = { Accept: bytes ? 'text/plain, text/markdown' : 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.token;
    headers['X-Workspace-Id'] = actor.workspace;
  }
  if (key) headers['Idempotency-Key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(prefix + path, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  let data;
  if (response.status !== 204) {
    data = bytes && response.ok
      ? Buffer.from(await response.arrayBuffer()) : await response.json().catch(() => null);
  }
  assert.equal(response.status, expected, method + ' ' + path + ' → ' + (data?.code ?? ''));
  if (path.includes('/artifact-publications')) {
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
  }
  return { data, headers: response.headers };
}

async function register() {
  const credentials = { username: 'qa-pub-' + randomUUID().slice(0, 11), password: 'Qa.Publish-' + randomUUID() };
  const { data: { accessToken, user } } = await request('/auth/register', 201, { method: 'POST', body: credentials });
  const account = { token: accessToken, id: user.id, workspace: user.workspaceId, username: user.username };
  accounts.push(account);
  return account;
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

const createProject = (actor, name) => request('/projects', 201, { actor, method: 'POST', body: { name } })
  .then(({ data }) => data);
const createArtifact = (actor, body) => request(privateDraft, 201, { actor, method: 'POST', body, key: randomUUID() })
  .then(({ data }) => data);
const remove = (actor, path, expected = 204) => request(path, expected, { actor, method: 'DELETE' });
const publish = (actor, project, artifactId, versionId, confirm = true, expected = 201) =>
  request(publications(project), expected, { actor, method: 'POST', body: { artifactId, versionId, confirm } })
    .then(({ data }) => data);

async function grant(owner, recipient, project, role) {
  const { data: invite } = await request(invitations(project), 201, {
    actor: owner, method: 'POST', body: { recipientUsername: recipient.username, role },
  });
  await request('/collaboration/invitations/' + invite.id + '/accept', 200, {
    actor: recipient, method: 'POST', body: { confirm: true },
  });
  return invite;
}

async function derive(owner, project, title) {
  const { data: conversation } = await request('/conversations', 201, {
    actor: owner, method: 'POST', body: { title, projectId: project },
  });
  const { data: queued } = await request('/conversations/' + conversation.id + '/runs', 202, {
    actor: owner, method: 'POST', key: randomUUID(),
    body: { action: 'send', modelId: 'local-echo', content: '本地合成文档内容 🧪' },
  });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const { data: run } = await request('/runs/' + queued.runId, 200, { actor: owner });
    if (run.state === 'completed') {
      const artifact = await createArtifact(owner, { sourceMessageId: run.messageId, title, format: 'text' });
      return { conversation, artifact };
    }
    assert.ok(['queued', 'running'].includes(run.state));
    await delay(100);
  }
  assert.fail('Local synthetic source reply did not complete.');
}

async function enabled(owner) {
  const viewer = { ...await register(), workspace: owner.workspace };
  const editor = { ...await register(), workspace: owner.workspace };
  const project = await createProject(owner, 'Approved synthetic publication project');
  const otherProject = await createProject(owner, 'Different owner-only synthetic project');
  const root = publications(project.id);
  const details = (publication) => root + '/' + publication.id;
  const get = (actor, publication, expected, bytes = false) =>
    request(details(publication) + (bytes ? '/download' : ''), expected, { actor, bytes });
  const list = (actor, expected = 200) => request(root, expected, { actor }).then(({ data }) => data.items);
  await request(root, 401);
  await mark('membership-ready', { workspace: owner.workspace, ownerAccount: owner.id, members: [viewer.id, editor.id] });
  await waitFor('membership-added');
  await list(viewer, 404);
  const viewerGrant = await grant(owner, viewer, project.id, 'viewer');
  await grant(owner, editor, project.id, 'editor');

  const original = '# 经授权的初稿\n\nMarkdown <b>literal in text download</b> 🧪\n';
  const revised = '私有编辑后的版本';
  const immutable = await createArtifact(owner, {
    projectId: project.id, title: 'Exact requested original', format: 'markdown', content: original,
  });
  const current = await createArtifact(owner, {
    projectId: project.id, title: 'Continuing control', format: 'text', content: '保留的合成正文',
  });
  const other = await createArtifact(owner, {
    projectId: otherProject.id, title: 'Unrelated synthetic version', format: 'text', content: '单独范围',
  });
  await publish(owner, project.id, immutable.id, immutable.head.id, false, 400);
  await publish(owner, project.id, other.id, other.head.id, true, 404);
  await publish(owner, project.id, immutable.id, current.head.id, true, 404);
  await publish(viewer, project.id, immutable.id, immutable.head.id, true, 403);
  await publish(editor, project.id, immutable.id, immutable.head.id, true, 403);

  const revoked = await publish(owner, project.id, immutable.id, immutable.head.id);
  assert.deepEqual(Object.keys(revoked).sort(),
    ['format', 'id', 'publishedAt', 'sizeBytes', 'title', 'versionNumber']);
  assert.equal(revoked.versionNumber, 1);
  assert.equal(revoked.sizeBytes, Buffer.byteLength(original));
  const unauthenticated = await request(details(revoked) + '/download', 401, { bytes: true });
  assert.equal(unauthenticated.data.code, 'UNAUTHENTICATED');
  assert.match(unauthenticated.headers.get('content-type') ?? '', /^application\/json\b/i);
  await publish(owner, project.id, immutable.id, immutable.head.id, true, 409);
  const { data: head } = await request(privateDraft + '/' + immutable.id + '/versions', 201, {
    actor: owner, method: 'POST',
    body: { baseVersionId: immutable.head.id, title: 'New private head', content: revised },
  });
  assert.equal(head.head.content, revised);
  assert.equal((await get(viewer, revoked, 200)).data.content, original);
  assert.equal((await get(editor, revoked, 200)).data.title, immutable.head.title);
  await request(privateDraft + '/' + immutable.id, 404, { actor: viewer });
  await request(privateDraft + '/' + immutable.id + '/versions/' + immutable.head.id, 404, { actor: editor });
  await remove(editor, details(revoked), 403);
  const { data: bytes, headers } = await get(viewer, revoked, 200, true);
  assert.deepEqual(bytes, Buffer.from(original));
  assert.match(headers.get('content-type') ?? '', /^text\/markdown;\s*charset=UTF-8$/i);
  assert.equal(headers.get('content-disposition'), 'attachment; filename="artifact.md"');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.match(headers.get('content-security-policy') ?? '', /sandbox/);

  const control = await publish(owner, project.id, current.id, current.head.id);
  const deletedDraft = await createArtifact(owner, {
    projectId: project.id, title: 'Delete independent source', format: 'text', content: '源文件删除样本',
  });
  const deleted = await publish(owner, project.id, deletedDraft.id, deletedDraft.head.id);
  const lineage = await derive(owner, project.id, 'Linked source removal fixture');
  const linked = await publish(owner, project.id, lineage.artifact.id, lineage.artifact.head.id);
  const policy = await derive(owner, project.id, 'Sharing policy revision fixture');
  const stoppedByPolicy = await publish(owner, project.id, policy.artifact.id, policy.artifact.head.id);
  assert.equal((await list(editor)).length, 5);

  await mark('snapshot-ready', { project: project.id, revoked: revoked.id, deleted: deleted.id,
    linked: linked.id, policy: stoppedByPolicy.id, control: control.id, viewerGrant: viewerGrant.id,
    deletedDraft: deletedDraft.id, deletedConversation: lineage.conversation.id });
  await waitFor('snapshot-done');
  await remove(owner, details(revoked));
  await remove(owner, privateDraft + '/' + deletedDraft.id);
  await remove(owner, '/conversations/' + lineage.conversation.id);
  const policyRoute = '/conversations/' + policy.conversation.id + '/sharing-restriction';
  await request(policyRoute, 200, { actor: owner, method: 'PUT', body: { restricted: true } });
  const deniedDownload = await get(editor, stoppedByPolicy, 404, true);
  assert.equal(deniedDownload.data.code, 'NOT_FOUND');
  assert.match(deniedDownload.headers.get('content-type') ?? '', /^application\/json\b/i);
  await publish(owner, project.id, policy.artifact.id, policy.artifact.head.id, true, 404);
  await request(policyRoute, 200, { actor: owner, method: 'PUT', body: { restricted: false } });
  await remove(owner, invitations(project.id) + '/' + viewerGrant.id);

  const after = async () => {
    await list(viewer, 404);
    await get(viewer, control, 404);
    await get(viewer, control, 404, true);
    assert.deepEqual((await list(editor)).map(({ id }) => id), [control.id]);
    for (const retired of [revoked, deleted, linked, stoppedByPolicy]) {
      await get(editor, retired, 404);
      await get(editor, retired, 404, true);
    }
    assert.equal((await get(editor, control, 200)).data.content, current.head.content);
    const download = await get(editor, control, 200, true);
    assert.deepEqual(download.data, Buffer.from(current.head.content));
    assert.equal(download.headers.get('content-disposition'), 'attachment; filename="artifact.txt"');
    const { data: originalVersion } = await request(privateDraft + '/' + immutable.id + '/versions/' + immutable.head.id,
      200, { actor: owner });
    assert.equal(originalVersion.content, original);
  };

  await after();
  await mark('revoke-ready', { onlineRevocationsVerified: true });
  await waitFor('database-switched');
  origin = restored;
  await after();
  const fresh = await publish(owner, project.id, immutable.id, immutable.head.id);
  assert.notEqual(fresh.id, revoked.id);
  assert.equal((await get(editor, fresh, 200)).data.content, original);
  const freshPolicy = await publish(owner, project.id, policy.artifact.id, policy.artifact.head.id);
  assert.notEqual(freshPolicy.id, stoppedByPolicy.id);
  await get(editor, freshPolicy, 200);
  await get(editor, stoppedByPolicy, 404);
  return { immutableSelection: true, privateArtifactScope: true, ownerOnlyPublishRevoke: true,
    exactPlainAndMarkdownAttachment: true, oldRoleDenied: true, retiredPublicationDenied: true,
    artifactAndConversationDeletion: true, earlierPolicyRevisionDenied: true, olderBackupReplay: true,
    unchangedControl: true, explicitFreshPublication: true };
}

try {
  const owner = await register();
  const { data: { capabilities } } = await request('/capabilities', 200, { actor: owner });
  assert.equal(capabilities.find(({ id }) => id === 'project_artifact_publications')?.available,
    mode !== 'disabled');
  const summary = mode === 'restore' ? await enabled(owner)
    : { disabled: true, privateArtifactsAvailable: true, projectCollaborationAvailable: true };
  if (mode === 'disabled') {
    assert.equal(capabilities.find(({ id }) => id === 'private_artifacts')?.available, true);
    assert.equal(capabilities.find(({ id }) => id === 'project_collaboration')?.available, true);
    const { data } = await request(publications(randomUUID()), 403, { actor: owner });
    assert.equal(data.code, 'CAPABILITY_UNAVAILABLE');
  }
  await mark('summary', summary);
  console.log(JSON.stringify(summary));
} finally {
  for (const actor of accounts) {
    await request('/auth/logout', 204, { actor, method: 'POST' }).catch(() => undefined);
  }
}
