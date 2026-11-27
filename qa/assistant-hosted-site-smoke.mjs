import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function loopback(value) {
  const origin = new URL(value);
  assert.ok(origin.protocol === 'http:' && origin.port && !origin.username && !origin.password
    && ['127.0.0.1', 'localhost'].includes(origin.hostname) && origin.pathname === '/'
    && !origin.hash && !origin.search && !['18080', '18090'].includes(origin.port), 'Use isolated localhost fixtures.');
  return origin;
}

const api = loopback(process.argv[2]);
const mode = process.argv[3] ?? 'enabled';
assert.ok(['enabled', 'restore', 'disabled'].includes(mode));
const evidence = process.argv[4];
const restoredApi = mode === 'restore' ? loopback(process.argv[5]) : undefined;

async function call(path, expected, { actor, method = 'GET', body, key, html, target = api } = {}) {
  const headers = { Accept: html ? 'text/html' : 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.accessToken;
    headers['X-Workspace-Id'] = actor.user.workspaceId;
  }
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(new URL('/api/assistant/v1' + path, target), {
    headers, method, body: body && JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, expected, method + ' ' + path);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
  if (response.status === 204) return undefined;
  return html && response.ok ? Buffer.from(await response.arrayBuffer()) : response.json();
}

async function actor() {
  return call('/auth/register', 201, { method: 'POST', body: {
    username: 'qa-site-' + randomUUID().slice(0, 9), password: 'Site.Qa!' + randomUUID(),
  } });
}

function website(heading) {
  return { heading, introduction: '合成内容 <script>literal</script> & <img src="https://example.invalid/">',
    sections: [{ title: '说明', paragraphs: ['可公开的合成段落。'] }] };
}

async function draft(owner, project, title) {
  const item = await call('/artifacts', 201, { actor: owner, method: 'POST', key: randomUUID(), body: {
    projectId: project.id, format: 'webpage', title, website: website(title),
  } });
  return { id: item.id, first: item.head.id,
    manage: `/projects/${project.id}/artifacts/${item.id}/hosting` };
}

function privatePreview(item, version) {
  return `/artifacts/${item.id}/versions/${version}/preview`;
}

function review(owner, item, version) {
  return call(item.manage + '/preview/' + version, 200, { actor: owner });
}

function publish(owner, item, preview, revision, expected = 200, patch = {}) {
  return call(item.manage, expected, { actor: owner, method: 'PUT', body: {
    versionId: preview.versionId, contentDigest: preview.contentDigest, expectedRevision: revision,
    confirm: true, ...patch,
  } });
}

async function publicRead(value, expected, { method = 'GET', correctHost = true, target = api } = {}) {
  const url = new URL(value);
  assert.equal(url.hostname, 'localhost');
  assert.equal(url.port, api.port);
  assert.match(url.pathname, /^\/assistant-sites\/[0-9a-f-]{36}$/);
  assert.equal(url.search + url.hash, '');
  url.port = target.port;
  if (!correctHost) url.hostname = '127.0.0.1';
  const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'If-None-Match': '"unused-obsolete-etag"' } });
  assert.equal(response.status, expected, `${method} hosted address`);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  assert.match(response.headers.get('cache-control') ?? '', /no-transform/);
  assert.match(response.headers.get('content-security-policy') ?? '', /^sandbox; default-src 'none';/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('etag'), null);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (method === 'HEAD') return assert.equal(bytes.length, 0);
  assert.match(response.headers.get('content-type') ?? '', /^text\/html;\s*charset=UTF-8$/i);
  assert.doesNotMatch(bytes.toString('utf8'), /<(script|img|form|iframe|a)\b/);
  if (expected !== 200) return assert.match(bytes.toString('utf8'), /<h1>站点暂不可用<\/h1>/);
  return bytes;
}

async function mark(name, data) {
  await writeFile(join(evidence, name), JSON.stringify(data) + '\n', { flag: 'wx' });
}

async function waitFor(name) {
  for (const end = Date.now() + 240_000; Date.now() < end;) {
    try { await access(join(evidence, name)); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(200);
  }
  assert.fail('Missing backup coordination marker ' + name);
}

const owner = await actor();
const outsider = await actor();
const project = await call('/projects', 201, { actor: owner, method: 'POST', body: { name: '合成公开站点项目' } });
const first = await draft(owner, project, '初次发布');
const control = await draft(owner, project, '同库未受影响对照');
const { capabilities } = await call('/capabilities', 200, { actor: owner });
assert.equal(capabilities.find(({ id }) => id === 'public_webpage_hosting')?.available, mode !== 'disabled');

if (mode === 'disabled') {
  await call(first.manage, 403, { actor: owner });
  await call(first.manage + '/preview/' + first.first, 403, { actor: owner });
  await publish(owner, first, { versionId: first.first, contentDigest: 'a'.repeat(64) }, null, 403);
  await publicRead(`http://localhost:${api.port}/assistant-sites/${randomUUID()}`, 404);
  await call(privatePreview(first, first.first), 200, { actor: owner, html: true });
  console.log(JSON.stringify({ servingOff: true, ownerDraftPreserved: true }));
} else {
  await call(first.manage, 401);
  await call(first.manage, 404, { actor: outsider });
  await call(first.manage + '/preview/' + first.first, 404, { actor: outsider });
  assert.deepEqual(await call(first.manage, 200, { actor: owner }), { release: null });
  const approved = await review(owner, first, first.first);
  const original = await call(privatePreview(first, first.first), 200, { actor: owner, html: true });
  assert.equal(createHash('sha256').update(original).digest('hex'), approved.contentDigest);
  await publish(outsider, first, approved, null, 404);
  await publish(owner, first, approved, null, 400, { confirm: false });
  await publish(owner, first, approved, null, 409, { contentDigest: '0'.repeat(64) });
  const live = await publish(owner, first, approved, null);
  assert.equal(live.versionId, first.first);
  assert.equal(live.accessible, true);
  assert.deepEqual(await publicRead(live.url, 200), original);
  await publicRead(live.url, 200, { method: 'HEAD' });
  await publicRead(live.url, 404, { correctHost: false });
  const unaffected = await publish(owner, control, await review(owner, control, control.first), null);

  const updated = await call(`/artifacts/${first.id}/versions`, 201, { actor: owner, method: 'POST', body: {
    baseVersionId: first.first, title: '下一候选版本', website: website('下一候选版本'),
  } });
  assert.deepEqual(await publicRead(live.url, 200), original);
  if (mode === 'restore') {
    await mark('backup-ready', { snapshotContainsOldRevision: true, independentSiteExists: true });
    await waitFor('backup-done');
  }

  const candidate = await review(owner, first, updated.head.id);
  const changed = await publish(owner, first, candidate, live.revision);
  assert.equal(changed.url, live.url);
  assert.notEqual(changed.revision, live.revision);
  assert.match((await publicRead(live.url, 200)).toString('utf8'), /下一候选版本/);
  await publish(owner, first, approved, live.revision, 409);
  await call(first.manage + '/' + live.revision, 409, { actor: owner, method: 'DELETE' });
  await call(first.manage + '/' + changed.revision, 404, { actor: outsider, method: 'DELETE' });
  const rolledBack = await publish(owner, first, approved, changed.revision);
  assert.equal(rolledBack.url, live.url);
  assert.notEqual(rolledBack.revision, live.revision);
  assert.deepEqual(await publicRead(live.url, 200), original);
  await call(first.manage + '/' + rolledBack.revision, 204, { actor: owner, method: 'DELETE' });
  await publicRead(live.url, 404);
  assert.deepEqual(await call(privatePreview(first, first.first), 200, { actor: owner, html: true }), original);
  const result = { exactImmutableHtml: true, anonymousRead: true, noStoreOrConditionalSnapshot: true,
    wrongHostDenied: true, staleMutationDenied: true, rollbackConfirmed: true, revokeKeptPrivateVersion: true };

  if (mode === 'restore') {
    await mark('restore-ready', { retiredBeforeRestart: true });
    await waitFor('restore-done');
    await publicRead(live.url, 404, { target: restoredApi });
    await publicRead(unaffected.url, 200, { target: restoredApi });
    assert.deepEqual(await call(first.manage, 200, { actor: owner, target: restoredApi }), { release: null });
    const exact = await call(privatePreview(first, first.first), 200, { actor: owner, html: true, target: restoredApi });
    assert.deepEqual(exact, original);
    result.oldBackupDidNotReviveAddress = true;
    result.nonRetiredAddressStillWorks = true;
    await mark('summary.json', result);
  }
  console.log(JSON.stringify(result));
}
