import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync } from 'node:zlib';

const rgba = [
  0xff102030, 0x80323456, 0xff123456, 0xfff0e0d0,
  0xffccbbaa, 0xff010203, 0x11020304, 0xff123123,
  0xff321321, 0xbf304050, 0xff020304, 0xffffffff,
];

function crc32(input) {
  let crc = 0xffffffff;
  for (const value of input) {
    crc ^= value;
    for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(name, payload) {
  const chunk = Buffer.alloc(12 + payload.length);
  chunk.writeUInt32BE(payload.length);
  chunk.write(name, 4, 4, 'ascii');
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + payload.length)), 8 + payload.length);
  return chunk;
}

function originalPng() {
  const width = 4;
  const height = 3;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const stride = 1 + width * 4;
  const pixels = Buffer.alloc(height * stride);
  for (let i = 0; i < rgba.length; i++) {
    const color = rgba[i];
    const offset = Math.floor(i / width) * stride + 1 + (i % width) * 4;
    pixels[offset] = (color >>> 16) & 255;
    pixels[offset + 1] = (color >>> 8) & 255;
    pixels[offset + 2] = color & 255;
    pixels[offset + 3] = color >>> 24;
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header),
    pngChunk('tEXt', Buffer.from('AssistantProvenance\0untrusted fixture marker')),
    pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}


if (process.argv[2] === '--fixture-base64') {
  console.log(originalPng().toString('base64'));
  process.exit(0);
}

const [address, mode = 'normal', directory, bucketDirectory, restoreAddress] = process.argv.slice(2);
assert.ok(['normal', 'restore', 'disabled', 'offline-scanner', 'quota', 'toggle', 'membership'].includes(mode));
function loopback(raw) {
  const value = new URL(raw);
  assert.ok(value.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(value.hostname)
    && value.port && !['18080', '18090'].includes(value.port) && value.href === value.origin + '/');
  return value;
}

let base = loopback(address);
const restored = mode === 'restore' ? loopback(restoreAddress) : null;
if (restored) assert.notEqual(restored.origin, base.origin);
assert.ok(directory, 'Provide a new evidence directory.');
const evidence = resolve(directory);
const objects = bucketDirectory && bucketDirectory !== '-' ? resolve(bucketDirectory) : null;
await mkdir(evidence, { recursive: true });

async function call(path, status, { actor, method = 'GET', body, raw, key, grant, binary = false, code } = {}) {
  const headers = { Accept: binary ? 'image/png' : 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.accessToken;
    headers['X-Workspace-Id'] = actor.workspace ?? actor.user.workspaceId;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (raw !== undefined) headers['Content-Type'] = 'image/png';
  if (key) headers['Idempotency-Key'] = key;
  if (grant) headers['X-Attachment-Grant'] = grant;
  const response = await fetch(new URL('/api/assistant/v1' + path, base), {
    method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
    redirect: 'error', signal: AbortSignal.timeout(12_000),
  });
  assert.equal(response.status, status, method + ' ' + path);
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
  if (status === 204) return undefined;
  if (binary && response.ok) {
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.match(response.headers.get('content-disposition'), /^attachment;.*image\.png/i);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, Number(response.headers.get('content-length')));
    return bytes;
  }
  const result = await response.json();
  if (code) assert.equal(result.code, code);
  return result;
}

function exists(file) {
  return access(file).then(() => true, failure => {
    if (failure.code !== 'ENOENT') throw failure;
    return false;
  });
}

async function mark(name, value) {
  const file = join(evidence, name + '.json');
  await writeFile(file + '.tmp', JSON.stringify(value) + '\n', { flag: 'wx' });
  await rename(file + '.tmp', file);
}

async function until(label, ask, predicate, timeout = 24_000) {
  const max = Date.now() + timeout;
  while (Date.now() < max) {
    const value = await ask();
    if (predicate(value)) return value;
    await delay(125);
  }
  assert.fail('Timed out: ' + label);
}

function waitFor(name) {
  return until(name, () => exists(join(evidence, name + '.json')), Boolean, 240_000);
}

function credentials() {
  return { username: 'qa-imgedit-' + randomUUID().slice(0, 10), password: 'Qa.LocalImage-' + randomUUID() };
}

const ownerCredentials = credentials();
const account = (action, body) => call('/auth/' + action, action === 'register' ? 201 : 200,
  { method: 'POST', body });
const home = await account('register', ownerCredentials);
let owner = home;
if (mode === 'membership') {
  const host = await account('register', credentials());
  owner = { ...home, workspace: host.user.workspaceId };
  await mark('membership-ready', { workspaceId: owner.workspace, ownerId: host.user.id, readerId: home.user.id });
  await waitFor('membership-added');
}
const project = await call('/projects', 201, { actor: owner, method: 'POST', body: { name: '合成图像编辑夹具' } });
const attachments = '/projects/' + project.id + '/attachments';
const direct = id => attachments + '/' + id;
const edits = (id, body, status, options = {}) =>
  call(direct(id) + '/local-image-edits', status,
    { actor: owner, method: 'POST', key: randomUUID(), body, ...options });
const op = { x: 1, y: 0, width: 2, height: 3, rotation: 90, confirm: true };
const getGrant = (path, actor = owner, status = 201) =>
  call(path + '/download-grant', status, { actor, method: 'POST' }).then(result => result.token);
const download = (path, grant, actor = owner, status = 200) =>
  call(path + '/download', status, { actor, grant, binary: true });
const viewFinal = id => until('scan result', () => call(direct(id), 200, { actor: owner }),
  result => ['approved', 'rejected'].includes(result.state));
const rawFile = (id, name) => join(objects, 'assistant-private', owner.user.id, owner.workspace ?? owner.user.workspaceId, id, name);
const claim = Buffer.from('AssistantProvenance\0local_image_edit_v1');

async function ingest() {
  const pending = await call(attachments, 202,
    { actor: owner, method: 'POST', raw: originalPng(), key: randomUUID() });
  const approved = await viewFinal(pending.id);
  assert.equal(approved.state, 'approved');
  assert.equal(approved.localEdit, undefined);
  return approved;
}

const capabilities = await call('/capabilities', 200, { actor: owner });
assert.equal(capabilities.capabilities.find(({ id }) => id === 'project_local_image_edits').available,
  mode !== 'disabled');
if (mode === 'disabled') {
  const source = await ingest();
  await edits(source.id, op, 403, { code: 'CAPABILITY_UNAVAILABLE' });
  await mark('summary', { mode, approvedOriginalStillUsable: true, editCreationDenied: true });
} else if (mode === 'toggle') {
  const source = await ingest();
  const pending = await edits(source.id, op, 202);
  const baked = await viewFinal(pending.id);
  assert.equal(baked.state, 'approved');
  const before = await download(direct(baked.id), await getGrant(direct(baked.id)));
  await mark('toggle-ready', { approvedEditPresent: true });
  await waitFor('toggle-done');
  const disabled = await call('/capabilities', 200, { actor: owner });
  assert.equal(disabled.capabilities.find(({ id }) => id === 'project_local_image_edits').available, false);
  assert.deepEqual(await download(direct(baked.id), await getGrant(direct(baked.id))), before);
  await edits(source.id, op, 403, { code: 'CAPABILITY_UNAVAILABLE' });
  await call(direct(source.id), 204, { actor: owner, method: 'DELETE' });
  await call(direct(baked.id), 404, { actor: owner, code: 'NOT_FOUND' });
  await mark('summary', { mode, immediatelyRespectsDisabledAdmission: true,
    approvedEditStillReadableWhileSourceAllowed: true, originalWithdrawalStillEnforced: true });
} else if (mode === 'membership') {
  const source = await ingest();
  const key = randomUUID();
  const pending = await edits(source.id, op, 202, { key });
  const baked = await viewFinal(pending.id);
  assert.equal(baked.state, 'approved');
  const token = await getGrant(direct(baked.id));
  const membership = '/auth/workspaces/' + owner.workspace;
  const before = await call(membership + '/leave-preview', 200, { actor: home });
  await call(membership + '/leave', 204, { actor: home, method: 'POST',
    body: { membershipRevision: before.membershipRevision, confirm: true } });
  await call(direct(baked.id), 403, { actor: owner, code: 'FORBIDDEN' });
  if (objects) {
    await until('departed epoch derived object removal', () => exists(rawFile(baked.id, 'approved.png')), present => !present);
    assert.ok(await exists(rawFile(source.id, 'approved.png')));
  }
  await mark('rejoin-ready', { departedRevision: before.membershipRevision, original: source.id, output: baked.id });
  await waitFor('membership-renewed');
  const after = await call(membership + '/leave-preview', 200, { actor: home });
  assert.notEqual(after.membershipRevision, before.membershipRevision);
  await call(direct(baked.id), 404, { actor: owner, code: 'NOT_FOUND' });
  await download(direct(baked.id), token, owner, 404);
  await edits(source.id, op, 404, { key, code: 'NOT_FOUND' });
  assert.equal((await call(direct(source.id), 200, { actor: owner })).state, 'approved');
  const current = await edits(source.id, op, 202);
  assert.equal((await viewFinal(current.id)).state, 'approved');
  await mark('summary', { mode, departureDeniedOldScope: true, oldEditAndGrantRemainDenied: true,
    originalRetainedForNewMembership: true, newConfirmedEditApproved: true });
} else if (mode === 'quota') {
  const source = await ingest();
  const reserved = [];
  for (let slot = 0; slot < 7; slot++) {
    reserved.push(await edits(source.id, op, 202));
  }
  assert.equal(new Set(reserved.map(({ id }) => id)).size, 7);
  const retried = randomUUID();
  await edits(source.id, op, 409, { key: retried, code: 'CONFLICT' });
  assert.equal((await call(attachments, 200, { actor: owner })).items.length, 8);
  await call(direct(reserved[0].id), 204, { actor: owner, method: 'DELETE' });
  const resumed = await edits(source.id, op, 202, { key: retried });
  assert.equal((await viewFinal(resumed.id)).state, 'approved');
  assert.equal((await call(attachments, 200, { actor: owner })).items.length, 8);
  await mark('summary', { mode, attachmentLimit: 8, extraReservationDenied: true, retryAfterRemovalApproved: true });
} else if (mode === 'offline-scanner') {
  const source = await ingest();
  await mark('offline-ready', { originalApproved: true });
  await waitFor('offline-done');
  const pending = await edits(source.id, op, 202);
  assert.equal(pending.state, 'quarantined');
  await getGrant(direct(pending.id), owner, 409);
  const final = await viewFinal(pending.id);
  assert.equal(final.state, 'rejected');
  assert.equal(final.errorCode, 'SCANNER_UNAVAILABLE');
  await getGrant(direct(pending.id), owner, 409);
  if (objects) {
    await until('rejected raw PNG removal', () => exists(rawFile(pending.id, 'quarantined')), present => !present);
    assert.equal(await exists(rawFile(pending.id, 'approved.png')), false);
  }
  await call(direct(pending.id), 204, { actor: owner, method: 'DELETE' });
  await mark('summary', { mode, editRejectedWithoutScanner: true, quotaSlotReleasedByRemoval: true });
} else {
  const original = await ingest();
  const retained = await ingest();
  const originalBytes = await download(direct(original.id), await getGrant(direct(original.id)));
  assert.ok(!originalBytes.includes(Buffer.from('AssistantProvenance')));
  const other = await account('register', credentials());
  await edits(original.id, { ...op, confirm: false }, 400, { code: 'VALIDATION_ERROR' });
  await edits(original.id, { ...op, bogus: true }, 400, { code: 'VALIDATION_ERROR' });
  await edits(original.id, { ...op, width: 4 }, 400, { code: 'VALIDATION_ERROR' });
  await edits(original.id, op, 404, { actor: other, code: 'NOT_FOUND' });
  await edits(original.id, op, 401, { actor: undefined, code: 'UNAUTHENTICATED' });
  assert.equal((await call(attachments, 200, { actor: owner })).items.length, 2);
  const key = randomUUID();
  const pending = await edits(original.id, op, 202, { key });
  assert.equal(pending.state, 'quarantined');
  assert.equal((await edits(original.id, op, 202, { key })).id, pending.id);
  await edits(retained.id, op, 409, { key, code: 'CONFLICT' });
  await edits(original.id, { ...op, x: 0 }, 409, { key, code: 'CONFLICT' });
  const baked = await viewFinal(pending.id);
  const stable = { algorithm: 'local_image_edit_v1', sourceAttachmentId: original.id,
    x: op.x, y: op.y, width: op.width, height: op.height, rotation: op.rotation };
  assert.equal(baked.state, 'approved');
  assert.deepEqual([baked.width, baked.height], [3, 2]);
  assert.deepEqual(baked.localEdit, stable);
  await edits(baked.id, { ...op, width: 1, height: 1 }, 409, { code: 'CONFLICT' });
  const derivativeBytes = await download(direct(baked.id), await getGrant(direct(baked.id)));
  assert.ok(derivativeBytes.includes(claim));
  assert.ok(!derivativeBytes.includes(Buffer.from(original.id)));
  if (objects) {
    await until('cleaned raw transformation', () => exists(rawFile(baked.id, 'quarantined')), value => !value);
    assert.deepEqual(await readFile(rawFile(baked.id, 'approved.png')), derivativeBytes);
  }
  const sameDeviceOnly = await getGrant(direct(baked.id));
  const secondDevice = await account('login', ownerCredentials);
  await download(direct(baked.id), sameDeviceOnly, secondDevice, 403);
  assert.deepEqual(await download(direct(baked.id), sameDeviceOnly), derivativeBytes);
  await download(direct(baked.id), sameDeviceOnly, owner, 403);
  const title = 'Reviewed local edit';
  const asImage = id => ({ attachmentId: id, altText: '精确裁剪合成图' });
  const artifact = await call('/artifacts', 201, { actor: owner, method: 'POST', key: randomUUID(),
    body: { title, projectId: project.id, format: 'image', image: asImage(baked.id) } });
  assert.deepEqual(artifact.head.image.localEdit, stable);
  const artifactPath = '/artifacts/' + artifact.id;
  const version = id => artifactPath + '/versions/' + id;
  const edited = await call(artifactPath + '/versions', 201, { actor: owner, method: 'POST',
    body: { baseVersionId: artifact.head.id, title, image: asImage(retained.id) } });
  assert.equal(edited.head.image.localEdit, undefined);
  await call(artifactPath + '/versions', 409, { actor: owner, method: 'POST',
    body: { baseVersionId: artifact.head.id, title, image: asImage(retained.id) } });
  const rolled = await call(artifactPath + '/rollback', 201, { actor: owner, method: 'POST',
    body: { baseVersionId: edited.head.id, versionId: artifact.head.id } });
  assert.equal(rolled.head.restoredFromVersionId, artifact.head.id);
  assert.deepEqual(rolled.head.image.localEdit, stable);
  assert.deepEqual(await download(version(artifact.head.id), await getGrant(version(artifact.head.id))), derivativeBytes);
  assert.deepEqual(await download(version(rolled.head.id), await getGrant(version(rolled.head.id))), derivativeBytes);

  const members = { ...other, workspace: owner.user.workspaceId };
  await mark('membership-ready', { workspaceId: owner.user.workspaceId, ownerId: owner.user.id, readerId: other.user.id });
  await waitFor('membership-added');
  const invitation = await call('/projects/' + project.id + '/collaboration/invitations', 201,
    { actor: owner, method: 'POST', body: { recipientUsername: other.user.username, role: 'viewer' } });
  await call('/collaboration/invitations/' + invitation.id + '/accept', 200,
    { actor: members, method: 'POST', body: { confirm: true } });
  const publications = '/collaboration/projects/' + project.id + '/artifact-publications';
  const published = await call(publications, 201, { actor: owner, method: 'POST',
    body: { artifactId: artifact.id, versionId: artifact.head.id, confirm: true } });
  const publicPath = publications + '/' + published.id;
  const shared = await call(publicPath, 200, { actor: members });
  assert.equal(shared.image.localEdit, true);
  assert.ok(!JSON.stringify(shared).includes(original.id));
  assert.deepEqual(await download(publicPath, await getGrant(publicPath, members), members), derivativeBytes);
  await call(direct(baked.id), 404, { actor: members, code: 'NOT_FOUND' });
  const exported = await call('/privacy/export', 200, { actor: owner });
  assert.deepEqual(exported.attachments.find(entry => entry.id === baked.id).localEdit, stable);
  assert.ok(!JSON.stringify(exported).includes('sourceDigest'));

  const originalGrant = await getGrant(direct(baked.id));
  const versionGrant = await getGrant(version(rolled.head.id));
  const memberGrant = await getGrant(publicPath, members);
  if (restored) {
    await mark('backup-ready', { accountId: owner.user.id, workspaceId: owner.user.workspaceId,
      projectId: project.id, original: original.id, output: baked.id, retained: retained.id,
      version: rolled.head.id, publication: published.id });
    await waitFor('backup-done');
  }
  await call(direct(original.id), 204, { actor: owner, method: 'DELETE' });
  const denied = async () => {
    await call(direct(baked.id), 404, { actor: owner, code: 'NOT_FOUND' });
    await download(direct(baked.id), originalGrant, owner, 404);
    await download(version(rolled.head.id), versionGrant, owner, 404);
    await call(publicPath, 404, { actor: members, code: 'NOT_FOUND' });
    await download(publicPath, memberGrant, members, 404);
    await edits(original.id, op, 404, { key, code: 'NOT_FOUND' });
    const preserved = await download(version(edited.head.id), await getGrant(version(edited.head.id)));
    assert.deepEqual(preserved, originalBytes);
  };
  await denied();
  if (objects) {
    for (const id of [original.id, baked.id]) {
      await until('approved PNG deleted', () => exists(rawFile(id, 'approved.png')), present => !present);
    }
  }
  if (restored) {
    await mark('restore-ready', { durableOriginalRevoke: true });
    await waitFor('restore-done');
    base = restored;
    await denied();
  }
  await mark('summary', { mode, exactPngDimensions: [baked.width, baked.height], quarantineAndScan: true,
    wrongScopeAndMissingConfirmationDenied: true, currentSourceOriginalOnly: true,
    immutableArtifactVersionsAndRollback: true, privatePublicationScoped: true,
    originalAndDerivedRevoked: true, restoredDenial: !!restored });
}
console.log((await readFile(join(evidence, 'summary.json'), 'utf8')).trim());
