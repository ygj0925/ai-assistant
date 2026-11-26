import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AssistantClient } from '../packages/contracts/dist/index.js';

function loopback(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'http:' && url.href === url.origin + '/'
    && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  return url.origin;
}

const [source, mode = 'normal', evidence, destination] = process.argv.slice(2);
assert.ok(['normal', 'restore', 'disabled'].includes(mode));
const origin = loopback(source);
const target = mode === 'restore' ? loopback(destination) : undefined;
if (target) assert.notEqual(target, origin);

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPgCsj8DwAC7gHDSedwyAAAAABJRU5ErkJggg==', 'base64');
const body = Buffer.alloc(16_000);
body.writeInt16LE(2700, 0);
body.writeInt16LE(-2700, 2);
function wave(samples, annotation = false) {
  const info = annotation ? Buffer.from('JUNK\u0005\u0000\u0000\u0000hello\u0000', 'latin1') : Buffer.alloc(0);
  const prefix = Buffer.alloc(36);
  prefix.write('RIFF');
  prefix.writeUInt32LE(36 + info.length + samples.length, 4);
  prefix.write('WAVEfmt ', 8);
  prefix.writeUInt32LE(16, 16);
  prefix.writeUInt16LE(1, 20);
  prefix.writeUInt16LE(1, 22);
  prefix.writeUInt32LE(16_000, 24);
  prefix.writeUInt32LE(32_000, 28);
  prefix.writeUInt16LE(2, 32);
  prefix.writeUInt16LE(16, 34);
  const data = Buffer.alloc(8);
  data.write('data');
  data.writeUInt32LE(samples.length, 4);
  return Buffer.concat([prefix, info, data, samples]);
}
const approvedBytes = wave(body);
const withMetadata = new Blob([wave(body, true)], { type: 'audio/wav' });

async function req(base, path, expected, session, { method = 'GET', token, accept = 'application/json' } = {}) {
  const headers = { Accept: accept };
  if (session) {
    headers.Authorization = 'Bearer ' + session.accessToken;
    headers['X-Workspace-Id'] = session.user.workspaceId;
  }
  if (token) headers['X-Attachment-Grant'] = token;
  const response = await fetch(base + '/api/assistant/v1' + path, { method, headers });
  assert.equal(response.status, expected, method + ' ' + path);
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  return response;
}

const owner = new AssistantClient({ origin });
const password = 'Qa.Audio-' + randomUUID();
const username = 'qa-audio-' + randomUUID().slice(0, 10);
const session = await owner.register({ username, password });
await owner.replaceSession(session);
const project = await owner.createProject({ name: '合成音频检验项目' });
const path = '/projects/' + project.id;
const binary = path + '/audio-attachments';
function upload(api, bytes, key = randomUUID()) {
  return api.uploadProjectAudioAttachment(project.id, bytes, key);
}
const scopeDenied = { status: 404 };
const identity = randomUUID();
if (mode === 'disabled') {
  await assert.rejects(upload(owner, withMetadata, identity), { status: 403, code: 'CAPABILITY_UNAVAILABLE' });
  assert.deepEqual(await owner.listProjectAudioAttachments(project.id), { items: [] });
  console.log(JSON.stringify({ mode, freshWaveIntakeDenied: true }));
} else {
  const malformed = Buffer.from(approvedBytes);
  malformed.writeUInt32LE(0xfffffffe, 40);
  await assert.rejects(upload(owner, new Blob([malformed])), { status: 400 });
  const otherProject = await owner.createProject({ name: '合成音频隔离对照' });
  const [taken, retained] = await Promise.all([upload(owner, withMetadata, identity), upload(owner, withMetadata)]);
  assert.equal((await upload(owner, withMetadata, identity)).id, taken.id);
  const pngUpload = await owner.uploadProjectAttachment(project.id, new Blob([png], { type: 'image/png' }), randomUUID());
  const deadline = Date.now() + 20_000;
  for (;;) {
    const { items } = await owner.listProjectAudioAttachments(project.id);
    if (items.filter(({ state }) => state === 'approved').length === 2 &&
        (await owner.listProjectAttachments(project.id)).items.some(({ state }) => state === 'approved')) break;
    assert.ok(Date.now() < deadline, 'Timed out awaiting audio and PNG scanning');
    if (items.some(({ state }) => state === 'rejected')) assert.fail('Unexpected scanner rejection');
    await delay(150);
  }
  const [first] = (await owner.listProjectAudioAttachments(project.id)).items;
  assert.equal(first.size, approvedBytes.length);
  assert.deepEqual(first.audio, { sampleRate: 16000, channels: 1, durationMillis: 500 });
  assert.deepEqual((await owner.listProjectAttachments(project.id)).items.map(({ id }) => id), [pngUpload.id]);
  await assert.rejects(owner.deleteProjectAttachment(project.id, taken.id), scopeDenied);
  await assert.rejects(owner.deleteProjectAudioAttachment(project.id, pngUpload.id), scopeDenied);
  await assert.rejects(owner.downloadProjectAudioAttachment(otherProject.id, taken.id), scopeDenied);
  const route = binary + '/' + taken.id;
  assert.match((await req(origin, route + '/download', 401, undefined, { accept: 'audio/wav' })).headers.get('content-type'),
    /^application\/json\b/);
  const second = await owner.login({ username, password });
  const grant = async () => (await req(origin, route + '/download-grant', 201, session, { method: 'POST' })).json();
  const { token } = await grant();
  await req(origin, route + '/download', 403, second, { token, accept: 'audio/wav' });
  const bytes = await req(origin, route + '/download', 200, session, { token, accept: 'audio/wav' });
  assert.equal(bytes.headers.get('content-type'), 'audio/wav');
  assert.match(bytes.headers.get('content-disposition'), /audio\.wav/);
  assert.equal(bytes.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), approvedBytes);
  await req(origin, route + '/download', 403, session, { token, accept: 'audio/wav' });
  const { token: oldToken } = await grant();

  async function marker(name, data) {
    const file = join(evidence, name + '.json');
    await writeFile(file + '.tmp', JSON.stringify(data) + '\n', { flag: 'wx' });
    await rename(file + '.tmp', file);
  }
  async function waitFor(name) {
    const deadline = Date.now() + 240_000;
    for (;;) {
      try { await access(join(evidence, name + '.json')); return; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      assert.ok(Date.now() < deadline, 'Missing recovery marker ' + name);
      await delay(150);
    }
  }

  let exportCursor;
  let audio;
  do {
    const page = await owner.getExportPage(exportCursor);
    audio = page.attachments?.find(({ id }) => id === taken.id);
    exportCursor = page.nextCursor;
  } while (!audio && exportCursor);
  assert.equal(audio?.contentType, 'audio/wav');
  assert.equal(audio?.audio.durationMillis, 500);
  if (target) {
    await marker('backup-ready', { revoked: taken.id, retained: retained.id, isolatedPng: pngUpload.id });
    await waitFor('backup-done');
  }
  await owner.deleteProjectAudioAttachment(project.id, taken.id);
  await req(origin, route + '/download', 404, session, { token: oldToken, accept: 'audio/wav' });
  if (target) {
    await marker('restore-ready', { oldGrantDenied: true });
    await waitFor('restore-done');
    await req(target, route + '/download', 404, session, { token: oldToken, accept: 'audio/wav' });
    const restored = new AssistantClient({ origin: target });
    await restored.replaceSession(session);
    assert.deepEqual((await restored.listProjectAudioAttachments(project.id)).items.map(({ id }) => id), [retained.id]);
    assert.deepEqual(Buffer.from(await (await restored.downloadProjectAudioAttachment(project.id, retained.id)).arrayBuffer()), approvedBytes);
    assert.deepEqual(Buffer.from(await (await restored.downloadProjectAttachment(project.id, pngUpload.id)).arrayBuffer()), png);
    await assert.rejects(upload(restored, withMetadata, identity), scopeDenied);
  }
  const result = { mode, normalizedBytes: approvedBytes.length, originalMetadataRemoved: true, scannerChecksPassed: true,
    sameSessionAndOneUse: true, legacyPngIsolated: true, portableMetadata: true, revokedGrantDenied: true,
    restoredRevocation: !!target };
  if (evidence) await marker('summary', result);
  console.log(JSON.stringify(result));
}
