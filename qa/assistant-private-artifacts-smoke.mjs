import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const artifacts = '/artifacts';
const actors = [];
const replayIndex = process.argv.indexOf('--replay');
const evidence = replayIndex === -1 ? undefined : process.argv[replayIndex + 1];
const restored = evidence ? isolated(process.argv[replayIndex + 2]) : undefined;
let api = isolated(process.argv[2]);

function isolated(value) {
  const url = new URL(value);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.port && !['18080', '18090'].includes(url.port),
    'Use a dedicated loopback fixture with synthetic accounts.');
  return url;
}

async function request(route, status, { actor, workspace, method = 'GET', body, key, file = false } = {}) {
  const headers = { Accept: file ? 'text/plain, text/markdown' : 'application/json' };
  if (actor) headers.Authorization = `Bearer ${actor.accessToken}`;
  if (workspace ?? actor?.user.workspaceId) headers['X-Workspace-Id'] = workspace ?? actor.user.workspaceId;
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(new URL(`/api/assistant/v1${route}`, api), {
    method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  assert.ok((Array.isArray(status) ? status : [status]).includes(response.status),
    `${method} ${route} returned ${response.status}, expected ${status}`);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  if (file && !response.ok) assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i);
  const content = response.status === 204 ? undefined
    : file && response.ok ? Buffer.from(await response.arrayBuffer()) : await response.json();
  return { status: response.status, body: content, headers: response.headers };
}

async function register() {
  const credentials = { username: `qa-artefact-${randomUUID().slice(0, 14)}`, password: `Test.Artefact!${randomUUID()}` };
  const { body } = await request('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { ...body, credentials };
  actors.push(actor);
  return actor;
}

async function project(actor) {
  return (await request('/projects', 201, { actor, method: 'POST', body: { name: 'Private artifact fixture' } })).body;
}

const versionRoute = (artifact, version) => `${artifacts}/${artifact.id}/versions/${version.id}`;

async function completedReply(actor, projectId) {
  const { body: conversation } = await request('/conversations', 201, {
    actor, method: 'POST', body: { title: 'Synthetic source reply', ...(projectId ? { projectId } : {}) },
  });
  const { body: queued } = await request(`/conversations/${conversation.id}/runs`, 202, {
    actor, method: 'POST', key: randomUUID(), body: { action: 'send', modelId: 'local-echo', content: '合成回复 🦀' },
  });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { body: run } = await request(`/runs/${queued.runId}`, 200, { actor });
    if (run.state === 'completed') {
      assert.ok(run.messageId);
      assert.match(run.content, /合成回复 🦀/u);
      const { body: history } = await request(`/conversations/${conversation.id}/messages`, 200, { actor });
      const prompt = history.items.find(({ role }) => role === 'user');
      assert.ok(prompt?.id);
      return { conversationId: conversation.id, messageId: run.messageId, promptId: prompt.id,
        content: run.content };
    }
    assert.ok(['queued', 'running'].includes(run.state));
    await delay(100);
  }
  assert.fail('Local synthetic reply did not complete.');
}

async function create(actor, body, key = randomUUID(), status = 201) {
  return (await request(artifacts, status, { actor, method: 'POST', key, body })).body;
}

async function exactDownload(actor, artifact, version, extension, content) {
  const { body, headers } = await request(`${versionRoute(artifact, version)}/download`, 200, { actor, file: true });
  assert.match(headers.get('content-type') ?? '', extension === 'md' ? /^text\/markdown;charset=UTF-8$/i : /^text\/plain;charset=UTF-8$/i);
  assert.equal(headers.get('content-disposition'), `attachment; filename="artifact-${version.number}.${extension}"`);
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.match(headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(Number(headers.get('content-length')), Buffer.byteLength(content));
  assert.deepEqual(body, Buffer.from(content));
}

async function waitForMarker(name) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    try {
      await access(join(evidence, name));
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(200);
  }
  assert.fail(`Restore fixture did not publish ${name}.`);
}

async function normal(owner) {
  const foreign = await register();
  const home = await project(owner);
  const unrelated = await project(owner);
  const outsiderProject = await project(foreign);
  const { body: capabilities } = await request('/capabilities', 200, { actor: owner });
  assert.equal(capabilities.capabilities.find(({ id }) => id === 'private_artifacts')?.available, true);
  await request(artifacts, 401);
  await request(artifacts, 403, { actor: owner, workspace: foreign.user.workspaceId });
  const content = '# 合成文稿 🦀\r\n\t外部脚本标记只作为文本\r\n<script>synthetic-inert</script>\n ';
  const authored = { projectId: home.id, title: 'UTF-8 draft', format: 'markdown', content };
  const key = randomUUID();
  const first = await create(owner, authored, key);
  assert.equal(first.headVersionId, first.head.id);
  assert.equal(first.headVersionNumber, 1);
  assert.equal(first.head.artifactId, first.id);
  assert.equal(first.head.content, content);
  assert.equal(first.size, Buffer.byteLength(content));
  assert.equal(first.sourceMessageId, undefined);
  await request(versionRoute(first, first.head) + '/download', 401, { file: true });
  assert.equal((await create(owner, authored, key)).id, first.id);
  await create(owner, { ...authored, content: 'Changed request' }, key, 409);
  await create(owner, { ...authored, format: 'html' }, randomUUID(), 400);
  await create(owner, { ...authored, content: 'a\x00b' }, randomUUID(), 400);
  await create(owner, { ...authored, content: '🦀'.repeat(8193) }, randomUUID(), 413);
  await create(foreign, authored, randomUUID(), 404);
  await create(owner, { ...authored, projectId: outsiderProject.id }, randomUUID(), 404);
  await exactDownload(owner, first, first.head, 'md', content);

  const race = await Promise.all([1, 2].map((number) => request(`${artifacts}/${first.id}/versions`, [201, 409], {
    actor: owner, method: 'POST',
    body: { baseVersionId: first.head.id, title: `Concurrent revision ${number}`, content: `Revision ${number}` },
  })));
  assert.deepEqual(race.map(({ status }) => status).sort(), [201, 409]);
  const second = race.find(({ status }) => status === 201).body;
  assert.equal(second.head.number, 2);
  const { body: rolledBack } = await request(`${artifacts}/${first.id}/rollback`, 201, {
    actor: owner, method: 'POST', body: { baseVersionId: second.head.id, versionId: first.head.id },
  });
  assert.equal(rolledBack.head.number, 3);
  assert.equal(rolledBack.head.restoredFromVersionId, first.head.id);
  assert.equal(rolledBack.head.title, first.title);
  await exactDownload(owner, rolledBack, rolledBack.head, 'md', content);
  await exactDownload(owner, first, second.head, 'md', second.head.content);
  const { body: original } = await request(versionRoute(first, first.head), 200, { actor: owner });
  assert.deepEqual(original, first.head);
  await request(versionRoute(first, first.head) + '/download', 404, { actor: foreign, file: true });
  await request(`${artifacts}/${first.id}`, 404, { actor: foreign, method: 'DELETE' });
  const { body: history } = await request(`${artifacts}/${first.id}/versions?limit=1`, 200, { actor: owner });
  assert.ok(history.nextCursor);
  assert.equal(history.items[0].number, 3);
  assert.equal(history.items[0].content, undefined);
  const { body: older } = await request(`${artifacts}/${first.id}/versions?cursor=${encodeURIComponent(history.nextCursor)}`,
    200, { actor: owner });
  assert.deepEqual(older.items.map(({ number }) => number), [2, 1]);
  assert.equal(older.nextCursor, null);
  await request(`${artifacts}?cursor=${encodeURIComponent(history.nextCursor)}`, 400, { actor: owner });

  const source = await completedReply(owner, home.id);
  const replyInput = { sourceMessageId: source.messageId, title: 'From completed reply', format: 'text' };
  const replyKey = randomUUID();
  await create(owner, { ...replyInput, projectId: unrelated.id }, randomUUID(), 404);
  await create(foreign, replyInput, randomUUID(), 404);
  await create(owner, { ...replyInput, sourceMessageId: source.promptId }, randomUUID(), 404);
  const derived = await create(owner, replyInput, replyKey);
  assert.equal(derived.sourceMessageId, source.messageId);
  assert.equal(derived.projectId, home.id);
  assert.equal(derived.head.content, source.content);
  await exactDownload(owner, derived, derived.head, 'txt', source.content);
  const { body: catalog } = await request(`${artifacts}?projectId=${home.id}&limit=1`, 200, { actor: owner });
  assert.ok(catalog.nextCursor);
  assert.equal(catalog.items[0].head, undefined);
  assert.equal(catalog.items[0].content, undefined);
  const { body: rest } = await request(
    `${artifacts}?projectId=${home.id}&cursor=${encodeURIComponent(catalog.nextCursor)}`, 200, { actor: owner });
  assert.deepEqual(new Set([catalog.items[0].id, rest.items[0].id]), new Set([derived.id, first.id]));
  await request(`${artifacts}?cursor=${encodeURIComponent(catalog.nextCursor)}`, 400, { actor: foreign });
  await request(`/conversations/${source.conversationId}`, 204, { actor: owner, method: 'DELETE' });
  await request(`${artifacts}/${derived.id}`, 404, { actor: owner });
  await request(versionRoute(derived, derived.head) + '/download', 404, { actor: owner, file: true });
  await create(owner, replyInput, replyKey, 404);
  await request(`${artifacts}/${first.id}`, 204, { actor: owner, method: 'DELETE' });
  await request(versionRoute(first, first.head), 404, { actor: owner });
  await create(owner, authored, key, 404);
  const boundary = '🦀'.repeat(8192);
  let limit = await create(owner, { ...authored, title: 'Version boundary', content: boundary });
  assert.equal(limit.size, 32768);
  await exactDownload(owner, limit, limit.head, 'md', boundary);
  for (let version = 2; version <= 32; version++) {
    const savedVersion = await request(`${artifacts}/${limit.id}/versions`, 201, { actor: owner, method: 'POST',
      body: { baseVersionId: limit.head.id, title: limit.title, content: '' } });
    limit = savedVersion.body;
    assert.equal(limit.head.number, version);
  }
  await request(`${artifacts}/${limit.id}/versions`, 409, { actor: owner, method: 'POST',
    body: { baseVersionId: limit.head.id, title: limit.title, content: 'Over the version quota' } });
  console.log(JSON.stringify({ sourceCapture: 'passed', compareAndSwap: 'passed', exactDownloads: 'passed',
    ownerAndCursorScope: 'passed', sourceAndArtifactErasure: 'passed', retainedVersions: 3,
    versionLimit: limit.headVersionNumber, maxBytes: Buffer.byteLength(boundary), oversized: 413 }));
}

async function replay(owner) {
  assert.notEqual(restored.port, api.port);
  const home = await project(owner);
  const source = await completedReply(owner, home.id);
  const replyInput = { sourceMessageId: source.messageId, title: 'Restored associated reply draft', format: 'text' };
  const erasedInput = { projectId: home.id, title: 'Restore independent draft', format: 'markdown', content: 'Old body' };
  const erasedKey = randomUUID();
  const replyKey = randomUUID();
  const reply = await create(owner, replyInput, replyKey);
  const erased = await create(owner, erasedInput, erasedKey);
  const retained = await create(owner, { ...erasedInput, title: 'Retained synthetic artifact', content: 'Still visible 🦀' });
  await writeFile(join(evidence, 'backup-ready.json'), JSON.stringify({ ownerId: owner.user.id, workspaceId: owner.user.workspaceId }),
    { flag: 'wx' });
  await waitForMarker('backup-done');
  await request(`/conversations/${source.conversationId}`, 204, { actor: owner, method: 'DELETE' });
  await request(`${artifacts}/${erased.id}`, 204, { actor: owner, method: 'DELETE' });
  const newKey = randomUUID();
  const after = await create(owner, { ...erasedInput, title: 'Created and erased after snapshot' }, newKey);
  await request(`${artifacts}/${after.id}`, 204, { actor: owner, method: 'DELETE' });
  await writeFile(join(evidence, 'deletion-ready.json'), '{}', { flag: 'wx' });
  await waitForMarker('restore-done');
  api = restored;
  for (const draft of [reply, erased, after]) {
    await request(`${artifacts}/${draft.id}`, 404, { actor: owner });
    await request(versionRoute(draft, draft.head) + '/download', 404, { actor: owner, file: true });
  }
  await create(owner, replyInput, replyKey, 404);
  await create(owner, erasedInput, erasedKey, 404);
  await create(owner, { ...erasedInput, title: 'Created and erased after snapshot' }, newKey, 404);
  await exactDownload(owner, retained, retained.head, 'md', retained.head.content);
  console.log(JSON.stringify({ sourceDeletionReplay: 'passed', artifactDeletionReplay: 'passed',
    preCreationKeyReplay: 'denied', unappliedArtifact: 'retained' }));
}

try {
  const owner = await register();
  if (evidence) await replay(owner);
  else await normal(owner);
  for (const actor of actors) {
    await request('/privacy/account-erasure', 204, { actor, method: 'POST',
      body: { currentPassword: actor.credentials.password, confirmation: 'DELETE' } });
    await request(artifacts, 401, { actor });
  }
} finally {
  for (const actor of actors) await request('/auth/logout', 204, { actor, method: 'POST' }).catch(() => {});
}
