import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const origin = new URL(process.argv[2]);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && origin.port && origin.port !== '18080',
  'Use a dedicated loopback fixture with synthetic accounts.');
const switchArgument = process.argv.indexOf('--switch');
const evidence = switchArgument === -1 ? undefined : process.argv[switchArgument + 1];
const root = '/artifacts';
const actors = [];

async function call(path, expected, { actor, workspace, method = 'GET', body, key, binary = false } = {}) {
  const headers = { Accept: binary ? 'text/plain' : 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.accessToken;
    headers['X-Workspace-Id'] = workspace ?? actor.user.workspaceId;
  }
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(new URL('/api/assistant/v1' + path, origin), {
    headers, method, body: body ? JSON.stringify(body) : undefined,
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, expected, method + ' ' + path);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
  if (response.status === 204) return undefined;
  if (binary && response.ok) {
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.match(response.headers.get('content-type') ?? '', /^text\/plain;\s*charset=UTF-8$/i);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal(Number(response.headers.get('content-length')), bytes.length);
    return { bytes, filename: response.headers.get('content-disposition') };
  }
  if (binary) assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i);
  return response.json();
}

async function register() {
  const credentials = { username: 'qa-code-' + randomUUID().slice(0, 12), password: 'CodeQ.A!' + randomUUID() };
  const actor = { ...await call('/auth/register', 201, { method: 'POST', body: credentials }), credentials };
  actors.push(actor);
  return actor;
}

async function capabilities(actor, editing) {
  const { capabilities: features } = await call('/capabilities', 200, { actor });
  assert.equal(features.find(({ id }) => id === 'private_artifacts')?.available, true);
  assert.equal(features.find(({ id }) => id === 'private_code_drafts')?.available, editing);
}

async function download(actor, artifact, version, suffix) {
  const path = root + '/' + artifact.id + '/versions/' + version.id + '/download';
  const { bytes, filename } = await call(path, 200, { actor, binary: true });
  assert.equal(filename, 'attachment; filename="artifact-' + version.number + suffix + '"');
  assert.deepEqual(bytes, Buffer.from(version.code.source));
  return path;
}

async function ownerExport(actor, artifact, expectedVersions) {
  const body = await call('/privacy/export', 200, { actor });
  const summary = body.privateArtifacts.find(({ id }) => id === artifact.id);
  assert.equal(summary.format, 'code');
  assert.equal(summary.headVersionId, artifact.head.id);
  const versions = body.privateArtifactVersions.filter(({ artifactId }) => artifactId === artifact.id)
    .sort((a, b) => a.number - b.number);
  assert.deepEqual(versions, expectedVersions);
  for (const item of versions) {
    assert.ok(!Object.hasOwn(item, 'content') && !Object.hasOwn(item, 'sheet') && !Object.hasOwn(item, 'presentation'));
  }
}

async function waitForEditSwitch() {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    try {
      await access(join(evidence, 'code-editing-disabled'));
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(250);
  }
  assert.fail('The retained code fixture did not turn editing off.');
}

async function test(owner, outsider) {
  await capabilities(owner, true);
  const project = await call('/projects', 201, { actor: owner, method: 'POST', body: { name: 'Code draft scope' } });
  const create = (actor, body, expected = 201, key = randomUUID()) =>
    call(root, expected, { actor, method: 'POST', key, body });
  const code = { language: 'javascript', source: 'const sample = "中文 🦀";\r\n\t// <script>literal text</script>\r\n ' };
  const draft = { projectId: project.id, title: '合成代码稿', format: 'code', code };
  const key = randomUUID();
  const initial = await create(owner, draft, 201, key);
  assert.equal(initial.format, 'code');
  assert.equal(initial.projectId, project.id);
  assert.equal(initial.sourceMessageId, undefined);
  assert.equal(initial.head.content, undefined);
  assert.deepEqual(initial.head.code, code);
  assert.ok(initial.size >= Buffer.byteLength(code.source) && initial.size <= 32768);
  assert.equal((await create(owner, draft, 201, key)).id, initial.id);
  await create(owner, { ...draft, code: { ...code, source: 'different request' } }, 409, key);
  await create(owner, { ...draft, projectId: undefined }, 400);
  await create(owner, { ...draft, sourceMessageId: randomUUID() }, 400);
  await create(owner, { ...draft, content: 'wrong alternate representation' }, 400);
  await create(owner, { ...draft, code: { ...code, language: '../script.js' } }, 400);
  await create(owner, { ...draft, code: { ...code, language: 'html' } }, 400);
  await create(owner, { ...draft, code: { ...code, source: 'bad\x00text' } }, 400);
  await create(owner, { ...draft, code: { ...code, source: 'a'.repeat(32769) } }, 413);
  await create(owner, { ...draft, code: { ...code, source: '\\'.repeat(16384) } }, 413);
  await create(outsider, draft, 404);
  await call(root + '/' + initial.id, 403, { actor: owner, workspace: outsider.user.workspaceId });
  const blank = await create(owner, { ...draft, code: { language: 'plaintext', source: '' } });
  await download(owner, blank, blank.head, '.txt');
  await call(root + '/' + blank.id, 204, { actor: owner, method: 'DELETE' });

  const revise = root + '/' + initial.id + '/versions';
  const update = { baseVersionId: initial.head.id, title: '更新后',
    code: { language: 'python', source: '# Python 合成内容\nprint("text")\n' } };
  const second = await call(revise, 201, { actor: owner, method: 'POST', body: update });
  assert.deepEqual(second.head.code, update.code);
  await download(owner, second, second.head, '.py.txt');
  await call(revise, 409, { actor: owner, method: 'POST', body: update });
  const rollback = root + '/' + initial.id + '/rollback';
  const third = await call(rollback, 201, { actor: owner, method: 'POST',
    body: { baseVersionId: second.head.id, versionId: initial.head.id } });
  assert.equal(third.head.number, 3);
  assert.equal(third.head.restoredFromVersionId, initial.head.id);
  assert.deepEqual(third.head.code, code);
  const path = await download(owner, third, third.head, '.js.txt');
  await download(owner, third, second.head, '.py.txt');
  await call(path, 401, { binary: true });
  await call(path, 404, { actor: outsider, binary: true });
  await call('/collaboration/projects/' + project.id + '/artifact-publications', 404, {
    actor: owner, method: 'POST', body: { artifactId: third.id, versionId: third.head.id, confirm: true },
  });
  const expectedVersions = [initial.head, second.head, third.head];
  await ownerExport(owner, third, expectedVersions);
  const foreign = await call('/privacy/export', 200, { actor: outsider });
  assert.deepEqual(foreign.privateArtifacts, []);
  assert.deepEqual(foreign.privateArtifactVersions, []);
  if (evidence) {
    await writeFile(join(evidence, 'code-editing-switch-ready'), '', { flag: 'wx' });
    await waitForEditSwitch();
    await capabilities(owner, false);
    await create(owner, draft, 403);
    await call(revise, 403, { actor: owner, method: 'POST', body: { ...update, baseVersionId: third.head.id } });
    await call(rollback, 403, { actor: owner, method: 'POST',
      body: { baseVersionId: third.head.id, versionId: initial.head.id } });
    assert.deepEqual(await call(root + '/' + third.id, 200, { actor: owner }), third);
    await download(owner, third, third.head, '.js.txt');
    await ownerExport(owner, third, expectedVersions);
  }
  await call(root + '/' + third.id, 204, { actor: owner, method: 'DELETE' });
  await call(path, 404, { actor: owner, binary: true });
  await create(owner, draft, evidence ? 403 : 404, key);
  const removed = await call('/privacy/export', 200, { actor: owner });
  assert.deepEqual(removed.privateArtifacts, []);
  assert.deepEqual(removed.privateArtifactVersions, []);
  console.log(JSON.stringify({ exactSourceBytes: Buffer.byteLength(code.source), fixedTextAttachments: 'passed',
    immutableVersions: expectedVersions.length, ownerScope: 'passed', typedExport: 'passed',
    publicationBlocked: 'passed', erased: 'passed', editingDisabledRetention: evidence ? 'passed' : undefined }));
}

try {
  await test(await register(), await register());
  for (const actor of actors) {
    await call('/privacy/account-erasure', 204, { actor, method: 'POST',
      body: { currentPassword: actor.credentials.password, confirmation: 'DELETE' } });
    await call(root, 401, { actor });
  }
} finally {
  for (const actor of actors) await call('/auth/logout', 204, { actor, method: 'POST' }).catch(() => {});
}
