import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function basicPdf(lines) {
  const literals = lines.map(line => '(' + line.replace(/[()\\]/g, '\\$&') + ') Tj\n');
  const stream = 'BT\n/F1 12 Tf\n72 720 Td\n16 TL\n' + literals.join('T*\n') + 'ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]'
      + ' /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream',
  ];
  let pdf = '%PDF-1.4\n';
  let entries = 'xref\n0 6\n0000000000 65535 f \n';
  objects.forEach((value, index) => {
    entries += String(pdf.length).padStart(10, '0') + ' 00000 n \n';
    pdf += (index + 1) + ' 0 obj\n' + value + '\nendobj\n';
  });
  const xref = pdf.length;
  return Buffer.from(pdf + entries + 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'
    + xref + '\n%%EOF\n', 'ascii');
}

const lines = ['Basic PDF contains <em>plain text</em>.', 'Quarter (four) C:\\files'];
const canonical = lines.join('\n') + '\n';
const sourcePdf = basicPdf(lines);
const scanFixture = Buffer.from('%PDF-1.4\nAssistant QA scanner PDF canary 810e3f04.\n');
const [address, mode = 'normal', evidencePath, objectsPath, restoreAddress, restoreOption] = process.argv.slice(2);
if (address === '--profile-fixture-base64') {
  console.log(sourcePdf.toString('base64'));
  process.exit(0);
}
if (address === '--scanner-signature') {
  const hash = createHash('md5').update(scanFixture).digest('hex');
  console.log(hash + ':' + scanFixture.length + ':AssistantQA.Pdf.ScanBeforeParse');
  process.exit(0);
}

function loopback(raw) {
  const url = new URL(raw);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.port && !['18080', '18090'].includes(url.port) && url.href === url.origin + '/',
  'Use only an isolated loopback synthetic fixture.');
  return url.origin;
}

assert.ok(['normal', 'restore', 'disabled', 'offline-scanner', 'general', 'worker-offline',
  'ocr-restore', 'pre-ocr-consumer'].includes(mode));
assert.ok(evidencePath, 'Pass a fresh evidence directory.');
const origin = loopback(address);
const target = ['restore', 'ocr-restore'].includes(mode) ? loopback(restoreAddress) : null;
if (target) assert.notEqual(origin, target);
assert.ok(!restoreOption || target && restoreOption === '--check-disabled');
const evidence = resolve(evidencePath);
const objects = objectsPath && objectsPath !== '-' ? resolve(objectsPath) : null;
await mkdir(evidence, { recursive: true });

async function request(base, path, status, { actor, method = 'GET', key, body,
  mime = 'application/json', accept = 'application/json', grant, review, code } = {}) {
  const headers = { Accept: accept };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.accessToken;
    headers['X-Workspace-Id'] = actor.user.workspaceId;
  }
  if (key) headers['Idempotency-Key'] = key;
  if (grant) headers['X-Attachment-Grant'] = grant;
  if (review) headers['X-Assistant-OCR-Reviewed'] = review;
  if (body !== undefined) headers['Content-Type'] = mime;
  const payload = body !== undefined && mime === 'application/json' ? JSON.stringify(body) : body;
  const response = await fetch(base + '/api/assistant/v1' + path, {
    method, headers, body: payload, redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, status, method + ' ' + path);
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  if (code) assert.equal((await response.json()).code, code);
  return response;
}

async function json(base, path, status, options) {
  return (await request(base, path, status, options)).json();
}

async function marker(name, data) {
  const file = join(evidence, name + '.json');
  await writeFile(file + '.tmp', JSON.stringify(data) + '\n', { flag: 'wx' });
  await rename(file + '.tmp', file);
}

async function until(label, probe, ready, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await probe();
    if (ready(result)) return result;
    await delay(150);
  }
  assert.fail('Timed out: ' + label);
}

function exists(path) {
  return access(path).then(() => true, error => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  });
}

function waitFor(name) {
  return until(name, () => exists(join(evidence, name + '.json')), Boolean, 240_000);
}

const credentials = () => ({ username: 'qa-pdf-' + randomUUID().slice(0, 12), password: 'Qa.Pdf-' + randomUUID() });
const auth = (action, body) => json(origin, '/auth/' + action, action === 'register' ? 201 : 200,
  { method: 'POST', body });
const ownCredentials = credentials();
const owner = await auth('register', ownCredentials);
const project = await json(origin, '/projects', 201,
  { actor: owner, method: 'POST', body: { name: '合成 PDF 夹具' } });
const routes = '/projects/' + project.id;
const attachments = routes + '/pdf-attachments';
const item = id => attachments + '/' + id;

function upload(body, status = 202, options = {}) {
  return status === 202
    ? json(origin, attachments, status, {
      actor: owner, method: 'POST', mime: 'application/pdf', key: randomUUID(), body, ...options,
    })
    : request(origin, attachments, status, {
      actor: owner, method: 'POST', mime: 'application/pdf', key: randomUUID(), body, ...options,
    });
}

const view = (base, id, actor = owner) => json(base, item(id), 200, { actor });
const text = (base, id) => json(base, item(id) + '/text', 200, { actor: owner });
const grant = (base, id, acknowledged = false) => json(base, item(id) + '/download-grant', 201,
  { actor: owner, method: 'POST', review: acknowledged ? 'true' : undefined });
const state = id => until('final validation ' + id,
  () => view(origin, id), record => ['approved', 'rejected'].includes(record.state));
const cap = (record, id) => record.capabilities.some(entry => entry.id === id && entry.available);
const capabilities = base => json(base, '/capabilities', 200, { actor: owner });
const denied = (base, route, code, status, extra = {}) =>
  request(base, route, status, { actor: owner, code, ...extra });
const objectFile = (id, name) =>
  join(objects, 'assistant-private', owner.user.id, owner.user.workspaceId, id, name);

async function exportedAttachments(base) {
  const entries = [];
  let cursor;
  for (let page = 0; page < 16; page++) {
    const query = cursor ? '?cursor=' + encodeURIComponent(cursor) : '';
    const result = await json(base, '/privacy/export' + query, 200, { actor: owner });
    entries.push(...(result.attachments ?? []));
    cursor = result.nextCursor;
    if (!cursor) return entries;
  }
  assert.fail('The synthetic account export exceeded the fixture budget.');
}

async function cleanRaw(id) {
  if (objects) {
    await until('quarantine deletion', () => exists(objectFile(id, 'quarantined')), present => !present);
  }
}

async function download(base, id, token, status, actor = owner, code) {
  return request(base, item(id) + '/download', status, { actor, grant: token, accept: 'text/plain', code });
}

async function assertTextDownload(response, expected = canonical) {
  assert.match(response.headers.get('content-type'), /^text\/plain;\s*charset=utf-8$/i);
  assert.match(response.headers.get('content-disposition'), /^attachment; filename="?extracted\.txt"?$/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(expected));
}

if (mode === 'disabled') {
  const disabled = await capabilities(origin);
  assert.equal(cap(disabled, 'project_pdf_uploads'), false);
  assert.equal(cap(disabled, 'project_pdf_attachments'), false);
  await upload(sourcePdf, 403, { code: 'CAPABILITY_UNAVAILABLE' });
  assert.deepEqual(await json(origin, attachments, 200, { actor: owner }), { items: [] });
  await marker('summary', { mode, uploadDenied: true, scopedListAccessible: true });
} else if (mode === 'offline-scanner') {
  const off = await upload(sourcePdf);
  assert.equal(off.state, 'quarantined');
  await denied(origin, item(off.id) + '/text', 'CONFLICT', 409);
  const final = await state(off.id);
  assert.equal(final.state, 'rejected');
  assert.equal(final.errorCode, 'SCANNER_UNAVAILABLE');
  await denied(origin, item(off.id) + '/download-grant', 'CONFLICT', 409, { method: 'POST' });
  await cleanRaw(off.id);
  if (objects) assert.equal(await exists(objectFile(off.id, 'approved.png')), false);
  await marker('summary', { mode, noApprovalWithoutScanner: true, rawCleaned: !!objects });
} else if (mode === 'general' || mode === 'worker-offline') {
  const profile = await capabilities(origin);
  assert.ok(cap(profile, 'project_pdf_uploads'));
  assert.ok(cap(profile, 'project_general_pdf'));
  const extended = await readFile(process.env.ASSISTANT_TEST_GENERAL_PDF_FILE);
  const expected = '中文\n\né\n';
  const basic = await upload(sourcePdf);
  assert.equal((await state(basic.id)).state, 'approved');
  await assertTextDownload(await download(origin, basic.id, (await grant(origin, basic.id)).token, 200));
  const retry = randomUUID();
  const current = await upload(extended, 202, { key: retry });
  assert.equal((await upload(extended, 202, { key: retry })).id, current.id);
  const outcome = await state(current.id);
  await cleanRaw(current.id);

  if (mode === 'worker-offline') {
    assert.equal(outcome.state, 'rejected');
    assert.equal(outcome.errorCode, 'PDF_EXTRACTOR_UNAVAILABLE');
    await denied(origin, item(current.id) + '/download-grant', 'CONFLICT', 409, { method: 'POST' });
    if (objects) assert.equal(await exists(objectFile(current.id, 'approved.png')), false);
    await marker('summary', { mode, extendedRejected: true, basicStillApproved: true, rawCleaned: !!objects });
  } else {
    assert.equal(outcome.state, 'approved');
    assert.equal(outcome.size, Buffer.byteLength(expected));
    assert.deepEqual(await text(origin, current.id), { id: current.id, text: expected });
    const overflow = await upload(await readFile(process.env.ASSISTANT_TEST_GENERAL_PDF_OVER_PAGES));
    assert.equal((await state(overflow.id)).errorCode, 'INVALID_PDF');
    await denied(origin, item(overflow.id) + '/text', 'CONFLICT', 409);
    await cleanRaw(overflow.id);
    const damaged = Buffer.from(extended.toString('latin1')
      .replace(/startxref\s+\d+\s+%%EOF\s*$/, 'startxref\n1\n%%EOF\n'), 'latin1');
    assert.notDeepEqual(damaged, extended);
    const repaired = await upload(damaged);
    assert.equal((await state(repaired.id)).errorCode, 'INVALID_PDF');
    await cleanRaw(repaired.id);
    await upload(Buffer.from('%PDF-1.8\n'), 400, { code: 'VALIDATION_ERROR' });
    const outsider = await auth('register', credentials());
    await request(origin, item(current.id) + '/text', 404, { actor: outsider, code: 'NOT_FOUND' });
    const device = await auth('login', ownCredentials);
    const { token } = await grant(origin, current.id);
    await download(origin, current.id, token, 403, device, 'ATTACHMENT_GRANT_INVALID');
    await assertTextDownload(await download(origin, current.id, token, 200), expected);
    await download(origin, current.id, token, 403, owner, 'ATTACHMENT_GRANT_INVALID');
    const beforeRemoval = await grant(origin, current.id);
    await request(origin, item(current.id), 204, { actor: owner, method: 'DELETE' });
    await download(origin, current.id, beforeRemoval.token, 404, owner, 'NOT_FOUND');
    if (objects) {
      await until('general text deletion', () => exists(objectFile(current.id, 'approved.png')), present => !present);
    }
    await marker('summary', { mode, extendedTextBytes: Buffer.byteLength(expected), exactUnicode: true,
      maxPagesEnforced: true, redirectedXrefDenied: true, scopedSingleUse: true, revokedGrantDenied: true,
      basicStillApproved: true, rawCleaned: !!objects });
  }
} else if (mode === 'pre-ocr-consumer') {
  const profile = await capabilities(origin);
  assert.ok(cap(profile, 'project_general_pdf'));
  assert.equal(cap(profile, 'project_pdf_ocr'), false);
  const scan = await upload(await readFile(process.env.ASSISTANT_TEST_SCAN_PDF_FILE));
  const embedded = await upload(await readFile(process.env.ASSISTANT_TEST_GENERAL_PDF_FILE));
  assert.equal((await state(scan.id)).errorCode, 'INVALID_PDF');
  await denied(origin, item(scan.id) + '/text', 'CONFLICT', 409);
  await cleanRaw(scan.id);
  if (objects) assert.equal(await exists(objectFile(scan.id, 'approved.png')), false);
  assert.equal((await state(embedded.id)).state, 'approved');
  assert.deepEqual(await text(origin, embedded.id), { id: embedded.id, text: '中文\n\né\n' });
  await marker('summary', { mode, scanRequiredNewConsumerOptIn: true, embeddedExact: true, rawCleaned: !!objects });
} else if (mode === 'ocr-restore') {
  const profile = await capabilities(origin);
  assert.ok(cap(profile, 'project_pdf_ocr'));
  const scanned = await readFile(process.env.ASSISTANT_TEST_SCAN_PDF_FILE);
  const blank = await readFile(process.env.ASSISTANT_TEST_BLANK_PDF_FILE);
  const expected = '扫描件 OCR 文本，可能有误，请对照原件。\n'
    + 'Scanned OCR text may contain errors. Check the original.\n\n中文测试\n工作空间\nENGLISH OCR 12345\n';
  const retained = await upload(scanned);
  const withdrawnKey = randomUUID();
  const withdrawn = await upload(scanned, 202, { key: withdrawnKey });
  assert.equal((await upload(scanned, 202, { key: withdrawnKey })).id, withdrawn.id);
  const invalid = await upload(blank);
  const basic = await upload(sourcePdf);
  for (const entry of [retained, withdrawn]) {
    const approved = await state(entry.id);
    assert.equal(approved.state, 'approved');
    assert.equal(approved.approximateText, true);
    assert.equal(approved.size, Buffer.byteLength(expected));
    assert.deepEqual(await text(origin, entry.id), { id: entry.id, text: expected, approximateText: true });
    await cleanRaw(entry.id);
    if (objects) assert.deepEqual(await readFile(objectFile(entry.id, 'approved.png')), Buffer.from(expected));
  }
  assert.equal((await state(invalid.id)).errorCode, 'INVALID_PDF');
  await cleanRaw(invalid.id);
  if (objects) assert.equal(await exists(objectFile(invalid.id, 'approved.png')), false);
  assert.equal((await state(basic.id)).approximateText, undefined);
  assert.deepEqual(await text(origin, basic.id), { id: basic.id, text: canonical });
  for (const review of [undefined, 'false', 'true, true']) {
    await denied(origin, item(retained.id) + '/download-grant', 'OCR_REVIEW_REQUIRED', 409, { method: 'POST', review });
  }
  const outsider = await auth('register', credentials());
  await request(origin, item(retained.id) + '/download-grant', 404,
    { actor: outsider, method: 'POST', review: 'true', code: 'NOT_FOUND' });
  const otherDevice = await auth('login', ownCredentials);
  const accepted = await grant(origin, retained.id, true);
  await download(origin, retained.id, accepted.token, 403, otherDevice, 'ATTACHMENT_GRANT_INVALID');
  await assertTextDownload(await download(origin, retained.id, accepted.token, 200), expected);
  await download(origin, retained.id, accepted.token, 403, owner, 'ATTACHMENT_GRANT_INVALID');
  const oldAuthorization = await grant(origin, withdrawn.id, true);
  await marker('backup-ready', { retained: retained.id, withdrawn: withdrawn.id });
  await waitFor('backup-done');
  await request(origin, item(withdrawn.id), 204, { actor: owner, method: 'DELETE' });
  await download(origin, withdrawn.id, oldAuthorization.token, 404, owner, 'NOT_FOUND');
  if (objects) await until('OCR derivative deletion', () => exists(objectFile(withdrawn.id, 'approved.png')), present => !present);
  await marker('restore-ready', { withdrawalVerified: true });
  await waitFor('restore-done');
  assert.ok(cap(await capabilities(target), 'project_general_pdf'));
  assert.equal(cap(await capabilities(target), 'project_pdf_ocr'), false);
  await denied(target, item(withdrawn.id) + '/text', 'NOT_FOUND', 404);
  await download(target, withdrawn.id, oldAuthorization.token, 404, owner, 'NOT_FOUND');
  assert.equal((await view(target, retained.id)).approximateText, true);
  assert.deepEqual(await text(target, retained.id), { id: retained.id, text: expected, approximateText: true });
  await denied(target, item(retained.id) + '/download-grant', 'OCR_REVIEW_REQUIRED', 409, { method: 'POST' });
  await assertTextDownload(await download(target, retained.id, (await grant(target, retained.id, true)).token, 200), expected);
  const newlyScanned = await json(target, attachments, 202,
    { actor: owner, method: 'POST', mime: 'application/pdf', key: randomUUID(), body: scanned });
  const disabledScan = await until('new OCR processing disabled', () => view(target, newlyScanned.id),
    record => ['approved', 'rejected'].includes(record.state));
  assert.equal(disabledScan.errorCode, 'INVALID_PDF');
  if (objects) await until('revoked object absent from restored storage',
    () => exists(objectFile(withdrawn.id, 'approved.png')), present => !present);
  await marker('summary', { mode, approximateTextBytes: Buffer.byteLength(expected), basicUnchanged: true,
    noGrantBeforeReview: true, scopeAndDeviceIsolation: true, revokedAfterRestore: true,
    approvedTextReadableWithProcessingOff: true, scansRejectedWithProcessingOff: true,
    blankRejected: true, rawCleaned: !!objects });
} else {
  const enabled = await capabilities(origin);
  assert.equal(cap(enabled, 'project_pdf_uploads'), true);
  assert.equal(cap(enabled, 'project_pdf_attachments'), true);
  await upload(Buffer.from('%PDF-1.7\n'), 400, { code: 'VALIDATION_ERROR' });
  await upload(Buffer.concat([sourcePdf, Buffer.alloc(32 * 1024)]), 413, { code: 'VALIDATION_ERROR' });
  await upload(sourcePdf, 415, { mime: 'application/octet-stream', code: 'VALIDATION_ERROR' });
  const idempotency = randomUUID();
  const removed = await upload(sourcePdf, 202, { key: idempotency });
  assert.equal(removed.state, 'quarantined');
  assert.equal((await upload(sourcePdf, 202, { key: idempotency })).id, removed.id);
  await upload(basicPdf(['other bytes']), 409, { key: idempotency, code: 'CONFLICT' });
  const kept = await upload(sourcePdf);
  const invalid = await upload(Buffer.from(sourcePdf.toString('ascii')
    .replace('0000000009 00000 n ', '0000000010 00000 n ')));
  const infected = await upload(scanFixture);
  const [removedRecord, keptRecord, invalidRecord, scannerRecord] =
    await Promise.all([removed, kept, invalid, infected].map(entry => state(entry.id)));
  assert.equal(removedRecord.state, 'approved');
  assert.equal(keptRecord.state, 'approved');
  assert.equal(removedRecord.size, Buffer.byteLength(canonical));
  assert.equal(removedRecord.width, undefined);
  assert.equal(removedRecord.audio, undefined);
  assert.equal(invalidRecord.errorCode, 'INVALID_PDF');
  assert.equal(scannerRecord.errorCode, 'MALWARE_DETECTED');
  for (const entry of [invalid, infected]) {
    await denied(origin, item(entry.id) + '/text', 'CONFLICT', 409);
    await denied(origin, item(entry.id) + '/download-grant', 'CONFLICT', 409, { method: 'POST' });
    if (objects) assert.equal(await exists(objectFile(entry.id, 'approved.png')), false);
  }
  for (const entry of [removed, kept, invalid, infected]) await cleanRaw(entry.id);
  if (objects) {
    for (const entry of [removed, kept]) {
      assert.deepEqual(await readFile(objectFile(entry.id, 'approved.png')), Buffer.from(canonical));
    }
  }
  assert.deepEqual(await text(origin, removed.id), { id: removed.id, text: canonical });
  const outsider = await auth('register', credentials());
  await request(origin, item(removed.id) + '/text', 401, { code: 'UNAUTHENTICATED' });
  await request(origin, item(removed.id) + '/text', 404, { actor: outsider, code: 'NOT_FOUND' });
  const otherProject = await json(origin, '/projects', 201,
    { actor: owner, method: 'POST', body: { name: '无权跨项目读取' } });
  await denied(origin, '/projects/' + otherProject.id + '/pdf-attachments/' + removed.id + '/text', 'NOT_FOUND', 404);
  await denied(origin, routes + '/attachments/' + removed.id, 'NOT_FOUND', 404);
  const second = await auth('login', ownCredentials);
  const { token } = await grant(origin, removed.id);
  await download(origin, removed.id, token, 403, second, 'ATTACHMENT_GRANT_INVALID');
  await assertTextDownload(await download(origin, removed.id, token, 200));
  await download(origin, removed.id, token, 403, owner, 'ATTACHMENT_GRANT_INVALID');
  const exported = await exportedAttachments(origin);
  const metadata = exported.find(entry => entry.id === removed.id);
  assert.equal(metadata.contentType, 'text/plain');
  assert.equal(metadata.size, Buffer.byteLength(canonical));
  assert.ok(!JSON.stringify(metadata).includes('Quarter'));
  const { token: oldToken } = await grant(origin, removed.id);
  if (target) {
    await marker('backup-ready', {
      accountId: owner.user.id, workspaceId: owner.user.workspaceId, projectId: project.id,
      revoked: removed.id, retained: kept.id,
    });
    await waitFor('backup-done');
  }
  await request(origin, item(removed.id), 204, { actor: owner, method: 'DELETE' });
  await denied(origin, item(removed.id) + '/text', 'NOT_FOUND', 404);
  await download(origin, removed.id, oldToken, 404, owner, 'NOT_FOUND');
  if (objects) {
    await until('canonical object deletion',
      () => exists(objectFile(removed.id, 'approved.png')), present => !present);
  }
  if (target) {
    await marker('restore-ready', { liveRevocation: true });
    await waitFor('restore-done');
    await denied(target, item(removed.id) + '/text', 'NOT_FOUND', 404);
    await download(target, removed.id, oldToken, 404, owner, 'NOT_FOUND');
    await request(target, attachments, 404, { actor: owner, method: 'POST', mime: 'application/pdf',
      body: sourcePdf, key: idempotency, code: 'NOT_FOUND' });
    assert.deepEqual(await text(target, kept.id), { id: kept.id, text: canonical });
    await assertTextDownload(await download(target, kept.id, (await grant(target, kept.id)).token, 200));
    const after = await exportedAttachments(target);
    assert.ok(after.some(entry => entry.id === kept.id));
    assert.ok(after.every(entry => entry.id !== removed.id));
    if (restoreOption) {
      const { token: disabledToken } = await grant(target, kept.id);
      await marker('disabled-ready', { retainedControlAfterRestore: true });
      await waitFor('disabled-done');
      const off = await capabilities(target);
      assert.equal(cap(off, 'project_pdf_uploads'), false);
      assert.equal(cap(off, 'project_pdf_attachments'), true);
      assert.equal((await view(target, kept.id)).state, 'approved');
      await denied(target, item(kept.id) + '/text', 'CAPABILITY_UNAVAILABLE', 403);
      await denied(target, item(kept.id) + '/download-grant', 'CAPABILITY_UNAVAILABLE', 403, { method: 'POST' });
      await download(target, kept.id, disabledToken, 403, owner, 'CAPABILITY_UNAVAILABLE');
      await request(target, item(kept.id), 204, { actor: owner, method: 'DELETE' });
      assert.deepEqual((await json(target, attachments, 200, { actor: owner })).items
        .map(entry => entry.id).includes(kept.id), false);
    }
  }
  await marker('summary', {
    mode, scannerPrecededParsing: true, xrefChecked: true, exactTextBytes: Buffer.byteLength(canonical),
    protectedCanonicalDownload: true, scopeAndDeviceIsolation: true, ownerMetadataOnly: true,
    rawObjectsRemoved: !!objects, revokeDeniesOldDownload: true, oldSnapshotDenied: !!target,
    retainedMetadataAndRemovalWhenDisabled: !!restoreOption,
  });
}
console.log((await readFile(join(evidence, 'summary.json'), 'utf8')).trim());
