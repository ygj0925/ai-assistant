import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { crc32, deflateSync } from 'node:zlib';

const local = (value) => {
  const url = new URL(value);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.port && url.port !== '18080',
    'Use an isolated loopback API and synthetic accounts.');
  return url;
};
let api = local(process.argv[2]);
const option = (name) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const objectRoot = option('--object-root');
const replay = option('--replay');
const restored = replay && local(process.argv[process.argv.indexOf('--replay') + 2]);
const toggle = option('--toggle');
const publicationEvidence = option('--publication');
const publicationRestore = option('--publication-restore');
const publicationApi = publicationRestore && local(publicationRestore);
const publicationToggle = process.argv.includes('--publication-toggle');
assert.ok([replay, toggle, publicationEvidence].filter(Boolean).length <= 1);
assert.ok(publicationEvidence || !(publicationRestore || publicationToggle));
assert.ok(!publicationRestore || !publicationToggle);
assert.ok(!(restored ?? publicationApi) || (restored ?? publicationApi).port !== api.port);
const actors = [];

function png(red) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  const chunk = (label, data) => {
    const name = Buffer.from(label);
    const bytes = Buffer.alloc(8);
    bytes.writeUInt32BE(data.length);
    bytes.writeUInt32BE(crc32(Buffer.concat([name, data])), 4);
    return Buffer.concat([bytes.subarray(0, 4), name, data, bytes.subarray(4)]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.from([0, red, 38, 120, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function call(path, status, { actor, method = 'GET', key, body, picture, grant, binary = false } = {}) {
  const mime = binary === true ? 'image/png' : binary;
  const headers = { Accept: mime || 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.accessToken;
    headers['X-Workspace-Id'] = actor.workspace ?? actor.user.workspaceId;
  }
  if (body || picture) headers['Content-Type'] = picture ? 'image/png' : 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  if (grant) headers['X-Attachment-Grant'] = grant;
  const response = await fetch(new URL('/api/assistant/v1' + path, api), {
    method, headers, body: picture ?? (body && JSON.stringify(body)),
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, status, method + ' ' + path);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
  if (status === 204) return undefined;
  if (mime && response.ok) {
    assert.equal(response.headers.get('content-type')?.split(';')[0], mime);
    const filename = mime === 'image/png' ? /^attachment;.*image\.png/i : /^attachment;.*artifact\.md/i;
    assert.match(response.headers.get('content-disposition') ?? '', filename);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(Number(response.headers.get('content-length')), bytes.length);
    return bytes;
  }
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i);
  return response.json();
}

async function register() {
  const credentials = { username: 'qa-img-' + randomUUID().slice(0, 10), password: 'Qa-Img!' + randomUUID() };
  const actor = await call('/auth/register', 201, { method: 'POST', body: credentials });
  actors.push({ actor, credentials });
  return { actor, credentials };
}

async function upload(actor, project, picture) {
  const collection = '/projects/' + project.id + '/attachments';
  const pending = await call(collection, 202, { actor, method: 'POST', key: randomUUID(), picture });
  const route = collection + '/' + pending.id;
  const expires = Date.now() + 35_000;
  while (Date.now() < expires) {
    const result = await call(route, 200, { actor });
    if (result.state === 'approved') return { id: result.id, route, picture };
    assert.equal(result.state, 'quarantined', result.errorCode);
    await delay(180);
  }
  assert.fail('The test PNG was not approved by the isolated scanner.');
}

function image(source, altText) {
  return { attachmentId: source.id, altText };
}

async function getGrant(path, actor, expected = 201) {
  return (await call(path + '/download-grant', expected, { actor, method: 'POST' })).token;
}
async function download(path, actor, grant, expected = 200) {
  return call(path + '/download', expected, { actor, grant, binary: true });
}
async function marker(directory, name) {
  const expires = Date.now() + 240_000;
  while (Date.now() < expires) {
    try {
      await access(join(directory, name));
      return;
    } catch (failure) {
      if (failure.code !== 'ENOENT') throw failure;
    }
    await delay(200);
  }
  assert.fail('Fixture driver did not create ' + name);
}
async function missing(path) {
  const expires = Date.now() + 20_000;
  while (Date.now() < expires) {
    try {
      await access(path);
    } catch (failure) {
      if (failure.code === 'ENOENT') return;
      throw failure;
    }
    await delay(200);
  }
  assert.fail('Revoked approved PNG remained in the isolated object store.');
}
async function erase({ actor, credentials }) {
  delete actor.workspace;
  await call('/privacy/account-erasure', 204, {
    actor, method: 'POST',
    body: { confirmation: 'DELETE', currentPassword: credentials.password },
  });
}

async function verifyOwner() {
  const { actor, credentials } = await register();
  const { actor: outsider } = await register();
  const project = await call('/projects', 201, { actor, method: 'POST', body: { name: 'Approved PNG asset fixture' } });
  const other = await call('/projects', 201, { actor, method: 'POST', body: { name: 'Separate project' } });
  const red = await upload(actor, project, png(81));
  const green = await upload(actor, project, png(122));
  const prefix = objectRoot && join(objectRoot, 'assistant-private', actor.user.id, actor.user.workspaceId);
  if (prefix) {
    assert.deepEqual((await readdir(prefix)).sort(), [red.id, green.id].sort());
    assert.deepEqual(await readFile(join(prefix, red.id, 'approved.png')), red.picture);
  }
  const name = 'Retired title should not reappear';
  const body = { projectId: project.id, title: name, format: 'image', image: image(red, '已批准图片') };
  const key = randomUUID();
  await call('/artifacts', 404, { actor, method: 'POST', key, body: { ...body, projectId: other.id } });
  await call('/artifacts', 404, { actor: outsider, method: 'POST', key, body });
  await call('/artifacts', 400, { actor, method: 'POST', key, body: { ...body, image: image(red, 'x'.repeat(161)) } });
  await call('/artifacts', 400, { actor, method: 'POST', key, body: { ...body, content: 'ambiguous' } });
  const first = await call('/artifacts', 201, { actor, method: 'POST', key, body });
  assert.deepEqual(first.head.image, { ...body.image, size: red.picture.length, width: 1, height: 1 });
  assert.equal((await call('/artifacts', 201, { actor, method: 'POST', key, body })).id, first.id);
  const path = '/artifacts/' + first.id;
  const version = (id) => path + '/versions/' + id;
  const at = (artifact) => version(artifact.head.id);
  const revise = (baseVersionId, draft, status = 201) => call(path + '/versions', status, {
    actor, method: 'POST', body: { baseVersionId, title: name, image: draft },
  });
  const roll = (baseVersionId, versionId, status = 201) => call(path + '/rollback', status, {
    actor, method: 'POST', body: { baseVersionId, versionId },
  });
  const second = await revise(first.head.id, image(red, 'Same source, different version'));
  await revise(first.head.id, image(green, 'Stale CAS'), 409);
  const third = await revise(second.head.id, image(green, 'Independent approved source'));
  const fourth = await roll(third.head.id, first.head.id);
  assert.equal(fourth.head.restoredFromVersionId, first.head.id);
  assert.deepEqual(fourth.head.image, first.head.image);
  assert.equal(fourth.head.number, 4);

  await download(at(first), undefined, undefined, 401);
  await getGrant(at(first), outsider, 404);
  await download(at(first), outsider, undefined, 404);
  await download(at(first), actor, undefined, 403);
  const direct = await getGrant(red.route, actor);
  await download(at(first), actor, direct, 403);
  assert.deepEqual(await download(red.route, actor, direct), red.picture);
  const grant = await getGrant(at(first), actor);
  await download(at(second), actor, grant, 403);
  await download(red.route, actor, grant, 403);
  const otherSession = await call('/auth/login', 200, { method: 'POST', body: credentials });
  await download(at(first), otherSession, grant, 403);
  assert.deepEqual(await download(at(first), actor, grant), red.picture);
  await download(at(first), actor, grant, 403);
  const beforePortability = await call('/privacy/export', 200, { actor });
  assert.ok(beforePortability.privateArtifacts.some(({ id }) => id === first.id));
  assert.deepEqual(beforePortability.privateArtifactVersions.find(({ id }) => id === third.head.id).image, third.head.image);
  assert.doesNotMatch(JSON.stringify(beforePortability), /"token"|"approved_digest"|"objectKey"/);
  if (prefix) {
    assert.deepEqual((await readdir(prefix)).sort(), [red.id, green.id].sort(), 'No per-version stored file copy.');
  }

  const retiredGrant = await getGrant(at(fourth), actor);
  if (replay) {
    await writeFile(join(replay, 'backup-ready.json'), JSON.stringify({ artifactId: first.id }), { flag: 'wx' });
    await marker(replay, 'backup-done');
  }
  await call(red.route, 204, { actor, method: 'DELETE' });
  if (prefix) {
    await missing(join(prefix, red.id, 'approved.png'));
    assert.deepEqual(await readFile(join(prefix, green.id, 'approved.png')), green.picture);
  }
  if (replay) {
    await writeFile(join(replay, 'deletion-ready'), '', { flag: 'wx' });
    await marker(replay, 'restore-done');
    api = restored;
  }
  const stub = (await call('/artifacts?projectId=' + project.id, 200, { actor })).items.find(({ id }) => id === first.id);
  assert.ok(stub);
  assert.equal(stub.headAvailable, false);
  assert.equal(stub.headVersionId, fourth.head.id);
  assert.equal(stub.size, 0);
  assert.notEqual(stub.title, name);
  assert.doesNotMatch(JSON.stringify(stub), new RegExp(red.id));
  await call(path, 404, { actor });
  await getGrant(at(fourth), actor, 404);
  await download(at(fourth), actor, retiredGrant, 404);
  assert.deepEqual((await call(path + '/versions?limit=1', 200, { actor })).items.map(({ id }) => id), [third.head.id]);
  assert.deepEqual(await download(at(third), actor, await getGrant(at(third), actor)), green.picture);
  await roll(fourth.head.id, first.head.id, 404);
  const retainedExport = await call('/privacy/export', 200, { actor });
  assert.ok(retainedExport.privateArtifacts.every(({ id }) => id !== first.id));
  assert.deepEqual(retainedExport.privateArtifactVersions.filter(({ artifactId }) => artifactId === first.id).map(({ id }) => id),
    [third.head.id]);
  const recovered = await roll(fourth.head.id, third.head.id);
  assert.equal(recovered.head.number, 5);
  assert.equal(recovered.headAvailable, undefined);
  assert.deepEqual(recovered.head.image, third.head.image);

  if (toggle) {
    await writeFile(join(toggle, 'image-ready.json'), JSON.stringify({ artifactId: first.id }), { flag: 'wx' });
    await marker(toggle, 'disabled-ready');
    await revise(recovered.head.id, image(green, 'Disabled edit'), 403);
    await roll(recovered.head.id, third.head.id, 403);
    await call('/artifacts', 403, { actor, method: 'POST', key: randomUUID(), body: { ...body, image: image(green, '') } });
    assert.deepEqual((await call(path, 200, { actor })).head.image, third.head.image);
    assert.deepEqual(await download(at(recovered), actor, await getGrant(at(recovered), actor)), green.picture);
  }
  await call(path, 204, { actor, method: 'DELETE' });
  await getGrant(at(recovered), actor, 404);
  if (!toggle) {
    await call('/artifacts', 404, { actor, method: 'POST', key, body: { ...body, image: image(green, '') } });
  }
  assert.deepEqual(await download(green.route, actor, await getGrant(green.route, actor)), green.picture);
  console.log(JSON.stringify({
    result: 'approved_png_asset_lineage_verified', revisions: 5, distinctStoredPngs: 2,
    pngBytes: red.picture.length, restore: Boolean(replay), editingToggle: Boolean(toggle),
    historyAfterAttachmentRevocation: 1, portability: true,
  }));
}

async function verifyPublication() {
  const { actor: owner } = await register();
  const { actor: viewer } = await register();
  const { actor: editor } = await register();
  const workspace = owner.user.workspaceId;
  viewer.workspace = workspace;
  editor.workspace = workspace;
  async function checkpoint(name, data = {}) {
    const target = join(publicationEvidence, name);
    await writeFile(target + '.tmp', JSON.stringify(data), { flag: 'wx' });
    await rename(target + '.tmp', target);
  }
  async function verifyFeature(actor, expected) {
    const { capabilities } = await call('/capabilities', 200, { actor });
    assert.equal(capabilities.find(({ id }) => id === 'project_artifact_publications')?.available, true);
    assert.equal(capabilities.find(({ id }) => id === 'project_image_publications')?.available, expected);
  }
  await verifyFeature(owner, true);
  const project = await call('/projects', 201, { actor: owner, method: 'POST',
    body: { name: 'Approved immutable image collaboration' } });
  const invitations = '/projects/' + project.id + '/collaboration/invitations';
  const collection = '/collaboration/projects/' + project.id + '/artifact-publications';
  const invite = async (actor, role) => {
    const record = await call(invitations, 201, {
      actor: owner, method: 'POST', body: { recipientUsername: actor.user.username, role },
    });
    await call('/collaboration/invitations/' + record.id + '/accept', 200, {
      actor, method: 'POST', body: { confirm: true },
    });
    return record;
  };
  const remove = (path) => call(path, 204, { actor: owner, method: 'DELETE' });
  await checkpoint('membership-ready.json', {
    ownerAccount: owner.user.id, workspace, members: [viewer.user.id, editor.user.id],
  });
  await marker(publicationEvidence, 'membership-added.json');
  await call(collection, 404, { actor: viewer });
  const viewerMembership = await invite(viewer, 'viewer');
  await invite(editor, 'editor');

  const red = await upload(owner, project, png(53));
  const green = await upload(owner, project, png(152));
  const prefix = objectRoot && join(objectRoot, 'assistant-private', owner.user.id, workspace);
  const create = (body) => call('/artifacts', 201, {
    actor: owner, method: 'POST', key: randomUUID(), body: { projectId: project.id, ...body },
  });
  const source = await create({ title: 'Reviewed v1', format: 'image', image: image(red, '已审核图像 🐟') });
  const artifact = '/artifacts/' + source.id;
  const at = (version) => artifact + '/versions/' + version.id;
  const revise = (previous, title, body) => call(artifact + '/versions', 201, {
    actor: owner, method: 'POST', body: { baseVersionId: previous.id, title, image: body },
  });
  const sibling = await revise(source.head, 'Same PNG in another version', image(red, '另一份文字'));
  const retained = await revise(sibling.head, 'Second approved object', image(green, '仍可访问'));
  const publish = (actor, draft, version, expected = 201, confirm = true) => call(collection, expected, {
    actor, method: 'POST', body: { artifactId: draft.id, versionId: version.id, confirm },
  });
  await publish(owner, source, source.head, 400, false);
  await publish(editor, source, source.head, 403);
  const first = await publish(owner, source, source.head);
  await publish(owner, source, source.head, 409);
  assert.equal(first.format, 'image');
  assert.equal(first.versionNumber, 1);
  assert.equal(first.sizeBytes, red.picture.length);
  assert.deepEqual((await call(collection, 200, { actor: viewer })).items, [first]);
  const one = collection + '/' + first.id;
  const two = collection + '/' + (await publish(owner, source, sibling.head)).id;
  const three = collection + '/' + (await publish(owner, source, retained.head)).id;
  const { attachmentId, ...safeImage } = source.head.image;
  assert.equal(attachmentId, red.id);
  assert.deepEqual(await call(one, 200, { actor: viewer }), { ...first, image: safeImage });
  await call(artifact, 404, { actor: viewer });
  await call(red.route, 404, { actor: viewer });
  await download(one, undefined, undefined, 401);
  await download(one, viewer, undefined, 403);

  const viewerGrant = await getGrant(one, viewer);
  await download(one, editor, viewerGrant, 403);
  await download(two, viewer, viewerGrant, 403);
  assert.deepEqual(await download(one, viewer, viewerGrant), red.picture);
  await download(one, viewer, viewerGrant, 403);
  const ownerPublicationGrant = await getGrant(one, owner);
  await download(red.route, owner, ownerPublicationGrant, 403);
  await download(at(source.head), owner, ownerPublicationGrant, 403);
  assert.deepEqual(await download(one, owner, ownerPublicationGrant), red.picture);
  const originalGrant = await getGrant(red.route, owner);
  await download(one, owner, originalGrant, 403);
  assert.deepEqual(await download(red.route, owner, originalGrant), red.picture);
  const privateVersionGrant = await getGrant(at(source.head), owner);
  await download(one, owner, privateVersionGrant, 403);
  assert.deepEqual(await download(at(source.head), owner, privateVersionGrant), red.picture);

  const commentOptions = { method: 'POST', key: randomUUID(), body: { content: 'Reviewed image comment' } };
  await call(one + '/comments', 403, { actor: viewer, ...commentOptions });
  const comment = await call(one + '/comments', 201, { actor: editor, ...commentOptions });
  assert.ok((await call(one + '/comments', 200, { actor: viewer })).items.some(({ id }) => id === comment.id));

  const previousRoleToken = await getGrant(one, viewer);
  await remove(invitations + '/' + viewerMembership.id);
  await download(one, viewer, previousRoleToken, 404);
  await call(one + '/comments', 404, { actor: viewer });
  assert.notEqual((await invite(viewer, 'viewer')).id, viewerMembership.id);
  await download(one, viewer, previousRoleToken, 403);
  assert.deepEqual(await download(one, viewer, await getGrant(one, viewer)), red.picture);

  const markdown = '沿用 Markdown\r\n';
  const text = await create({ title: 'Previous format', format: 'markdown', content: markdown });
  const previous = collection + '/' + (await publish(owner, text, text.head)).id;
  assert.equal((await call(previous, 200, { actor: viewer })).content, markdown);
  assert.equal((await call(previous + '/download', 200, { actor: viewer, binary: 'text/markdown' })).toString('utf8'),
    markdown);
  if (prefix) {
    assert.deepEqual((await readdir(prefix)).sort(), [red.id, green.id].sort());
  }

  if (publicationToggle) {
    await checkpoint('publication-disable-ready.json');
    await marker(publicationEvidence, 'publication-disabled.json');
    await verifyFeature(owner, false);
    await call(one, 404, { actor: viewer });
    await getGrant(one, viewer, 404);
    await call(one + '/comments', 404, { actor: editor });
    await remove(three);
    assert.deepEqual(await download(at(source.head), owner, await getGrant(at(source.head), owner)), red.picture);
    assert.equal((await call(previous, 200, { actor: viewer })).content, markdown);
    await checkpoint('publication-enable-ready.json');
    await marker(publicationEvidence, 'publication-enabled.json');
    await verifyFeature(owner, true);
    assert.deepEqual(await download(one, viewer, await getGrant(one, viewer)), red.picture);
    await call(three, 404, { actor: viewer });
  }
  const retiredExplicitGrant = await getGrant(one, editor);
  const retiredSourceGrant = await getGrant(two, editor);
  if (publicationApi) {
    await checkpoint('backup-ready.json', { projectId: project.id });
    await marker(publicationEvidence, 'backup-done');
  }
  await remove(one);
  await download(one, editor, retiredExplicitGrant, 404);
  assert.deepEqual(await download(red.route, owner, await getGrant(red.route, owner)), red.picture);
  await remove(red.route);
  if (prefix) {
    await missing(join(prefix, red.id, 'approved.png'));
    assert.deepEqual(await readFile(join(prefix, green.id, 'approved.png')), green.picture);
  }
  if (publicationApi) {
    await checkpoint('deletion-ready');
    await marker(publicationEvidence, 'restore-done');
    api = publicationApi;
  }
  await getGrant(one, editor, 404);
  await getGrant(two, editor, 404);
  await download(one, editor, retiredExplicitGrant, 404);
  await download(two, editor, retiredSourceGrant, 404);
  await call(two + '/comments', 404, { actor: editor });
  if (!publicationToggle) {
    assert.deepEqual(await download(three, editor, await getGrant(three, editor)), green.picture);
  }
  assert.equal((await call(previous, 200, { actor: viewer })).content, markdown);
  console.log(JSON.stringify({
    result: 'approved_image_publication_verified', exactPngBytes: red.picture.length,
    roleGeneration: true, siblingGrant: true, strictMime: true, separateSourceIdentity: true,
    sourceAndPublicationRevoke: true, restore: Boolean(publicationApi), publicationToggle,
  }));
}

try {
  if (publicationEvidence) await verifyPublication();
  else await verifyOwner();
} finally {
  const cleanup = await Promise.allSettled(actors.map(erase));
  for (const result of cleanup) {
    if (result.status === 'rejected') {
      console.error('Synthetic account cleanup failed:', result.reason.message);
      process.exitCode = 1;
    }
  }
}
