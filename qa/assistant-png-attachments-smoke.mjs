import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, deflateSync } from 'node:zlib';

function pngChunk(name, data) {
  const type = Buffer.from(name);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

function pngFixture({ flagged = false, metadata = false } = {}) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const pixel = flagged ? [0, 40, 63, 126, 255] : [0, 10, 80, 105, 255];
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    ...(metadata ? [pngChunk('tEXt', Buffer.from('Creator\0Synthetic picture'))] : []),
    pngChunk('IDAT', deflateSync(Buffer.from(pixel))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

if (['--scanner-fixture-base64', '--clean-fixture-base64'].includes(process.argv[2])) {
  console.log(pngFixture({ flagged: process.argv[2] === '--scanner-fixture-base64' }).toString('base64'));
} else {
  await smoke();
}

async function smoke() {
  const origin = new URL(process.argv[2]);
  const verifyScannerRejection = process.argv.includes('--scanner-rejection');
  const verifyExpiry = process.argv.includes('--expiry');
  const fixtureIndex = process.argv.indexOf('--object-root');
  const privateRoot = fixtureIndex < 0 ? undefined : process.argv[fixtureIndex + 1];
  const replayIndex = process.argv.indexOf('--before-upload-replay');
  const replayDirectory = replayIndex < 0 ? undefined : process.argv[replayIndex + 1];
  const snapshotIndex = process.argv.indexOf('--verify-share-snapshot');
  const snapshotDirectory = snapshotIndex < 0 ? undefined : process.argv[snapshotIndex + 1];
  const restored = replayDirectory ? new URL(process.argv[replayIndex + 2]) : undefined;
  assert.ok(fixtureIndex < 0 || privateRoot, 'Provide the isolated rclone bucket directory.');
  assert.ok(replayIndex < 0 || replayDirectory, 'Provide the existing replay evidence directory and restored origin.');
  assert.ok(snapshotIndex < 0 || snapshotDirectory, 'Provide a fresh share membership fixture directory.');
  assert.ok(!snapshotDirectory || !replayDirectory, 'Run each fixture mode independently.');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Use an isolated loopback API.');
  assert.ok(origin.port && !['18080', '18090'].includes(origin.port), 'Use a distinct test service port.');
  if (restored) {
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(restored.hostname));
    assert.ok(restored.port && !['18080', '18090'].includes(restored.port) && restored.port !== origin.port);
  }
  const accounts = [];
  const uploads = [];
  let cleanupOrigin = origin;

  async function request(route, expected, options = {}) {
    const { method = 'GET', actor, workspace, body, png, key, grant } = options;
    const headers = { Accept: route.endsWith('/download') ? 'image/png, application/json' : 'application/json' };
    if (actor) headers.Authorization = `Bearer ${actor.token}`;
    if (workspace ?? actor?.workspace) headers['X-Workspace-Id'] = workspace ?? actor.workspace;
    if (body) headers['Content-Type'] = 'application/json';
    if (png) headers['Content-Type'] = options.mediaType ?? 'image/png';
    if (key) headers['Idempotency-Key'] = key;
    if (grant) headers['X-Attachment-Grant'] = grant;
    const response = await fetch(new URL('/api/assistant/v1' + route, options.api ?? origin), {
      method, headers, body: png ?? (body ? JSON.stringify(body) : undefined),
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    if (response.status !== expected) {
      const error = await response.json().catch(() => ({}));
      assert.equal(response.status, expected, `${method} ${route} ${error.code ?? ''}`);
    }
    assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
    if (expected === 204) return undefined;
    if (expected === 200 && route.endsWith('/download')) {
      assert.match(response.headers.get('content-disposition') ?? '', /^attachment;.*image\.png/i);
      assert.match(response.headers.get('content-type') ?? '', /^image\/png/i);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      const result = Buffer.from(await response.arrayBuffer());
      assert.equal(Number(response.headers.get('content-length')), result.length);
      return result;
    }
    return response.json();
  }

  async function register() {
    const credentials = { username: `qa-png-${randomUUID().slice(0, 12)}`, password: `Qa-Png!${randomUUID()}` };
    const response = await request('/auth/register', 201, { method: 'POST', body: credentials });
    const actor = { token: response.accessToken, id: response.user.id, workspace: response.user.workspaceId, credentials };
    accounts.push(actor);
    return actor;
  }

  async function project(actor, name) {
    const result = await request('/projects', 201, { method: 'POST', actor, body: { name } });
    return `/projects/${result.id}/attachments`;
  }

  async function waitForAttachment(actor, route, state) {
    const deadline = Date.now() + 35_000;
    do {
      const latest = await request(route, 200, { actor });
      if (latest.state === state) return latest;
      assert.equal(latest.state, 'quarantined', latest.errorCode);
      await delay(200);
    } while (Date.now() < deadline);
    assert.fail(`The attachment did not reach ${state}.`);
  }

  function storedPath(actor, attachment) {
    for (const identifier of [actor.id, actor.workspace, attachment]) {
      assert.match(identifier, /^[0-9a-f-]{36}$/);
    }
    return join(privateRoot, 'assistant-private', actor.id, actor.workspace, attachment, 'approved.png');
  }

  async function waitForCleanup(path) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        await access(path);
      } catch (failure) {
        if (failure.code === 'ENOENT') return;
        throw failure;
      }
      await delay(200);
    }
    assert.fail('The private approved object did not disappear.');
  }

  async function waitForMarker(name, directory = replayDirectory) {
    const deadline = Date.now() + 300_000;
    while (Date.now() < deadline) {
      try {
        await access(join(directory, name));
        return;
      } catch (failure) {
        if (failure.code !== 'ENOENT') throw failure;
      }
      await delay(200);
    }
    assert.fail(`Fixture driver did not publish ${name}.`);
  }

  async function replayBeforeUpload() {
    const owner = await register();
    const root = await project(owner, 'Restore before private upload');
    await writeFile(join(replayDirectory, 'backup-ready.json'),
      JSON.stringify({ accountId: owner.id, workspaceId: owner.workspace, root }), { flag: 'wx' });
    await waitForMarker('backup-done');
    const key = randomUUID();
    const png = pngFixture();
    const uploaded = await request(root, 202, { method: 'POST', actor: owner, png, key });
    const route = `${root}/${uploaded.id}`;
    uploads.push([owner, route]);
    await waitForAttachment(owner, route, 'approved');
    if (privateRoot) await access(storedPath(owner, uploaded.id));
    const grant = await request(grantPath(route), 201, { method: 'POST', actor: owner });
    await request(route, 204, { method: 'DELETE', actor: owner });
    await request(route, 404, { actor: owner });
    if (privateRoot) await waitForCleanup(storedPath(owner, uploaded.id));
    await writeFile(join(replayDirectory, 'deletion-ready.json'),
      JSON.stringify({ originalAttachment: uploaded.id }), { flag: 'wx' });
    await waitForMarker('restore-done');
    cleanupOrigin = restored;
    const options = { actor: owner, api: restored };
    assert.deepEqual((await request(root, 200, options)).items, []);
    await request(route, 404, options);
    await request(downloadPath(route), 404, { ...options, grant: grant.token });
    await request(root, 404, { ...options, method: 'POST', png, key });
    assert.deepEqual((await request(root, 200, options)).items, []);
    if (privateRoot) await waitForCleanup(storedPath(owner, uploaded.id));
    console.log(JSON.stringify({ originalGrant: 'blocked', restoredUploadRetry: 'blocked',
      privateObjectStillRemoved: Boolean(privateRoot) }));
  }

  async function verifyShareSnapshot() {
    const owner = await register();
    const viewer = await register();
    const scope = { actor: viewer, workspace: owner.workspace };
    const root = await project(owner, 'Shared transcript with private test attachment');
    const projectId = root.split('/')[2];
    const attachment = await request(root, 202, { method: 'POST', actor: owner, png: pngFixture(), key: randomUUID() });
    const attachmentPath = `${root}/${attachment.id}`;
    uploads.push([owner, attachmentPath]);
    await waitForAttachment(owner, attachmentPath, 'approved');
    const ownGrant = await request(grantPath(attachmentPath), 201, { method: 'POST', actor: owner });
    assert.deepEqual(await request(downloadPath(attachmentPath), 200, { actor: owner, grant: ownGrant.token }), pngFixture());
    await writeFile(join(snapshotDirectory, 'add.json'), JSON.stringify({
      workspaceId: owner.workspace, ownerId: owner.id, readerId: viewer.id,
    }), { flag: 'wx' });
    await waitForMarker('added.json', snapshotDirectory);

    const transcript = await request('/conversations', 201, { method: 'POST', actor: owner,
      body: { title: '合成附件隔离', projectId } });
    const transcriptPath = `/conversations/${transcript.id}`;
    const message = '合成项目只分享快照文字 🦀';
    const run = await request(`${transcriptPath}/runs`, 202, { method: 'POST', actor: owner, key: randomUUID(),
      body: { action: 'send', content: message, modelId: 'local-echo' } });
    let result;
    const deadline = Date.now() + 20_000;
    do {
      result = await request(`/runs/${run.runId}`, 200, { actor: owner });
      if (result.state === 'completed') break;
      assert.ok(['queued', 'running'].includes(result.state), result.state);
      await delay(100);
    } while (Date.now() < deadline);
    assert.equal(result.state, 'completed');

    const selection = { scope: 'reply', sourceMessageId: result.messageId, audience: 'workspace' };
    await request(`${transcriptPath}/share-previews`, 403, { method: 'POST', actor: owner, body: { ...selection, audience: 'link' } });
    const preview = await request(`${transcriptPath}/share-previews`, 200, { method: 'POST', actor: owner, body: selection });
    assert.equal(preview.includesAttachments, false);
    const published = await request(`${transcriptPath}/shares`, 201, { method: 'POST', actor: owner,
      body: { ...selection, revision: preview.revision } });
    const view = await request('/shares/read', 200, { method: 'POST', ...scope, body: { token: published.token } });
    assert.equal(view.includesAttachments, false);
    assert.equal(view.messages.length, 1);
    assert.ok(view.messages[0].content.includes(message));
    assert.ok(!JSON.stringify(view).includes(attachment.id));
    await request(root, 404, scope);
    await request(attachmentPath, 404, scope);
    await request(grantPath(attachmentPath), 404, { method: 'POST', ...scope });
    await request(`/shares/${published.id}`, 204, { method: 'DELETE', actor: owner });
    await request('/shares/read', 404, { method: 'POST', ...scope, body: { token: published.token } });
    console.log(JSON.stringify({ approvedOwnPng: true, memberReadText: true, includesAttachments: false, memberGrant: 404, revokedShare: 404 }));
  }

  const downloadPath = (route) => `${route}/download`;
  const grantPath = (route) => `${route}/download-grant`;
  try {
    if (replayDirectory) {
      await replayBeforeUpload();
      return;
    }
    if (snapshotDirectory) {
      await verifyShareSnapshot();
      return;
    }
    const owner = await register();
    const outsider = await register();
    const root = await project(owner, 'Private PNG fixture');
    const separate = await project(owner, 'Separate project');
    const { capabilities } = await request('/capabilities', 200, { actor: owner });
    assert.equal(capabilities.find(({ id }) => id === 'project_attachments')?.available, true);

    const png = pngFixture({ metadata: true });
    const key = randomUUID();
    await request(root, 401, { method: 'POST', png, key });
    await request(root, 415, { method: 'POST', actor: owner, png, key, mediaType: 'image/jpeg' });
    await request(root, 413, { method: 'POST', actor: owner, png: Buffer.alloc(1_048_577), key });
    await request(root, 400, { method: 'POST', actor: owner, png: Buffer.alloc(64), key });
    const initial = await request(root, 202, { method: 'POST', actor: owner, png, key });
    assert.equal(initial.state, 'quarantined');
    const route = `${root}/${initial.id}`;
    uploads.push([owner, route]);
    const replay = await request(root, 202, { method: 'POST', actor: owner, png, key });
    assert.equal(replay.id, initial.id);
    await request(root, 409, { method: 'POST', actor: owner, png: pngFixture(), key });
    await request(route, 404, { actor: outsider });
    await request(route, 403, { actor: owner, workspace: outsider.workspace });
    await request(`${separate}/${initial.id}`, 404, { actor: owner });

    const approved = await waitForAttachment(owner, route, 'approved');
    assert.equal(approved.width, 1);
    assert.equal(approved.height, 1);
    assert.equal(approved.size, pngFixture().length);
    if (privateRoot) await access(storedPath(owner, initial.id));
    assert.ok((await request(root, 200, { actor: owner })).items.some(({ id }) => id === initial.id));
    assert.equal((await request(downloadPath(route), 403, { actor: owner })).code, 'ATTACHMENT_GRANT_INVALID');
    await request(grantPath(route), 404, { method: 'POST', actor: outsider });

    const grant = await request(grantPath(route), 201, { method: 'POST', actor: owner });
    const expires = Date.parse(grant.expiresAt);
    assert.ok(expires > Date.now() + 55_000 && expires <= Date.now() + 60_000);
    const fresh = await request('/auth/login', 200, { method: 'POST', body: owner.credentials });
    const device = { ...owner, token: fresh.accessToken };
    accounts.push(device);
    assert.equal((await request(downloadPath(route), 403, { actor: device, grant: grant.token })).code,
      'ATTACHMENT_GRANT_INVALID');
    assert.deepEqual(await request(downloadPath(route), 200, { actor: owner, grant: grant.token }), pngFixture());
    await request(downloadPath(route), 403, { actor: owner, grant: grant.token });

    const saveForExpiry = verifyExpiry
      ? await request(grantPath(route), 201, { method: 'POST', actor: owner }) : undefined;
    if (verifyScannerRejection) {
      const rejected = await request(root, 202, {
        method: 'POST', actor: owner, png: pngFixture({ flagged: true }), key: randomUUID(),
      });
      const rejectedRoute = `${root}/${rejected.id}`;
      uploads.push([owner, rejectedRoute]);
      const final = await waitForAttachment(owner, rejectedRoute, 'rejected');
      assert.equal(final.errorCode, 'MALWARE_DETECTED');
      await request(grantPath(rejectedRoute), 409, { method: 'POST', actor: owner });
    }

    if (saveForExpiry) {
      await delay(Math.max(0, Date.parse(saveForExpiry.expiresAt) - Date.now() + 200));
      assert.equal((await request(downloadPath(route), 403, { actor: owner, grant: saveForExpiry.token })).code,
        'ATTACHMENT_GRANT_INVALID');
    }

    const revokeGrant = await request(grantPath(route), 201, { method: 'POST', actor: owner });
    await request(route, 204, { method: 'DELETE', actor: owner });
    await request(route, 404, { actor: owner });
    await request(downloadPath(route), 404, { actor: owner, grant: revokeGrant.token });
    await request(root, 404, { method: 'POST', actor: owner, png, key });
    assert.ok((await request(root, 200, { actor: owner })).items.every(({ id }) => id !== initial.id));
    if (privateRoot) await waitForCleanup(storedPath(owner, initial.id));

    const retained = await request(root, 202, { method: 'POST', actor: owner, png, key: randomUUID() });
    const retainedRoute = `${root}/${retained.id}`;
    uploads.push([owner, retainedRoute]);
    await waitForAttachment(owner, retainedRoute, 'approved');
    if (privateRoot) await access(storedPath(owner, retained.id));
    await request('/privacy/account-erasure', 204, {
      method: 'POST', actor: owner,
      body: { currentPassword: owner.credentials.password, confirmation: 'DELETE' },
    });
    await request(retainedRoute, 401, { actor: owner });
    if (privateRoot) await waitForCleanup(storedPath(owner, retained.id));
    console.log(JSON.stringify({
      cleanPng: 'approved-and-sanitized', boundedUpload: true, retiredKey: 'blocked',
      scannerRejectedFixture: verifyScannerRejection, expiryVerified: verifyExpiry,
      grant: 'session-bound-single-use-revoked', foreignScope: 'denied',
      accountErasure: 'passed', privateObjectCleanup: Boolean(privateRoot),
    }));
  } finally {
    for (const [actor, route] of uploads) {
      await request(route, 204, { method: 'DELETE', actor, api: cleanupOrigin }).catch(() => {});
    }
    for (const actor of accounts) {
      await request('/auth/logout', 204, {
        method: 'POST', actor, api: cleanupOrigin,
      }).catch(() => {});
    }
  }
}
