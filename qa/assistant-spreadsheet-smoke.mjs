import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const api = new URL(process.argv[2]);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname) && api.port && api.port !== '18080',
  'Use a dedicated loopback fixture with synthetic accounts.');
const switchArgument = process.argv.indexOf('--switch');
const evidence = switchArgument === -1 ? undefined : process.argv[switchArgument + 1];
const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const root = '/artifacts';
const actors = [];
const sheet = {
  name: '月度数据',
  rows: [
    ['=1+2', 42.125, true, null, '中文 🦀\r\n', ''],
    ['+1+2', -12.5, false, null, '@SUM(1,2)', '0'],
  ],
};

const inspectPackage = String.raw`
import io, sys, zipfile, xml.etree.ElementTree as ET

def root(package, name):
    return ET.fromstring(package.read(name))

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as package:
    assert not any("externalLinks" in name or "vbaProject" in name for name in package.namelist())
    sheets = root(package, "xl/workbook.xml").findall(".//m:sheet", NS)
    assert len(sheets) == 1 and sheets[0].attrib["name"] == "\u6708\u5ea6\u6570\u636e"
    worksheet = root(package, "xl/worksheets/sheet1.xml")
    assert not worksheet.findall(".//m:f", NS)
    assert not worksheet.findall(".//m:hyperlink", NS)
    assert len(worksheet.findall(".//m:row", NS)) == 2
    cells = {cell.attrib["r"]: cell for cell in worksheet.findall(".//m:c", NS)}
    strings = root(package, "xl/sharedStrings.xml").findall("m:si", NS)
    def value(address):
        return cells[address].findtext("m:v", namespaces=NS)
    def text(address):
        assert cells[address].attrib["t"] == "s"
        return "".join(node.text or "" for node in strings[int(value(address))].findall(".//m:t", NS))
    assert text("A1") == "=1+2" and text("A2") == "+1+2" and text("E2") == "@SUM(1,2)"
    assert text("E1") == "\u4e2d\u6587 \U0001f980\r\n" and text("F1") == "" and text("F2") == "0"
    assert cells["B1"].get("t", "n") == "n" and float(value("B1")) == 42.125
    assert cells["B2"].get("t", "n") == "n" and float(value("B2")) == -12.5
    assert cells["C1"].attrib["t"] == "b" and value("C1") == "1" and value("C2") == "0"
    assert value("D1") is None and value("D2") is None
`;

async function call(path, expected, { actor, method = 'GET', body, raw, key, binary = false } = {}) {
  const headers = { Accept: binary ? xlsx : 'application/json' };
  if (actor) {
    headers.Authorization = "Bearer " + actor.accessToken;
    headers['X-Workspace-Id'] = actor.user.workspaceId;
  }
  if (body || raw) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(new URL('/api/assistant/v1' + path, api), {
    headers, method, body: raw ?? (body ? JSON.stringify(body) : undefined),
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, expected, method + ' ' + path);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
  if (response.status === 204) return undefined;
  if (binary && response.ok) {
    assert.equal(response.headers.get('content-type'), xlsx);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(Number(response.headers.get('content-length')), bytes.length);
    return { bytes, filename: response.headers.get('content-disposition') };
  }
  if (binary) assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i);
  return response.json();
}

async function register() {
  const credentials = { username: 'qa-sheet-' + randomUUID().slice(0, 12), password: 'SheetQ.a!' + randomUUID() };
  const actor = { ...await call('/auth/register', 201, { method: 'POST', body: credentials }), credentials };
  actors.push(actor);
  return actor;
}

async function capabilities(actor, editing) {
  const { capabilities: features } = await call('/capabilities', 200, { actor });
  assert.equal(features.find(({ id }) => id === 'private_artifacts')?.available, true);
  assert.equal(features.find(({ id }) => id === 'private_spreadsheets')?.available, editing);
}

async function readback(actor, artifact, version) {
  const path = root + '/' + artifact.id + '/versions/' + version.id + '/download';
  const { bytes, filename } = await call(path, 200, { actor, binary: true });
  assert.equal(filename, 'attachment; filename="artifact-' + version.number + '.xlsx"');
  const command = process.argv.includes('--wsl-python') ? 'wsl.exe' : process.platform === 'win32' ? 'py.exe' : 'python3';
  const args = command === 'wsl.exe' ? ['--exec', 'python3'] : command === 'py.exe' ? ['-3'] : [];
  execFileSync(command, [...args, '-c', inspectPackage], { input: bytes, timeout: 12_000 });
  return { bytes: bytes.length, path };
}

async function ownerExport(actor, artifact, expectedVersions) {
  const body = await call('/privacy/export', 200, { actor });
  const summary = body.privateArtifacts.find(({ id }) => id === artifact.id);
  assert.equal(summary.format, 'sheet');
  assert.equal(summary.headVersionId, artifact.head.id);
  const version = body.privateArtifactVersions.filter(({ artifactId }) => artifactId === artifact.id)
    .sort((a, b) => a.number - b.number);
  assert.deepEqual(version, expectedVersions);
  assert.ok(version.every((item) => !Object.hasOwn(item, 'content')));
}

async function waitForEditSwitch() {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    try {
      await access(join(evidence, 'sheet-editing-disabled'));
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(250);
  }
  assert.fail('The retained-sheet fixture was not restarted with editing disabled.');
}

async function test(owner, outsider) {
  await capabilities(owner, true);
  const project = await call('/projects', 201, { actor: owner, method: 'POST', body: { name: 'Private worksheet scope' } });
  const originalText = '# 合成文稿 🦀\r\n';
  const markdown = await call(root, 201, { actor: owner, method: 'POST', key: randomUUID(),
    body: { projectId: project.id, title: 'Text compatibility', format: 'markdown', content: originalText } });
  assert.equal(markdown.head.content, originalText);
  const editedMarkdown = await call(root + '/' + markdown.id + '/versions', 201, {
    actor: owner, method: 'POST', body: { baseVersionId: markdown.head.id,
      title: 'Text compatibility', content: originalText + '合成修改' },
  });
  assert.equal(editedMarkdown.head.content, originalText + '合成修改');
  await call(root + '/' + markdown.id, 204, { actor: owner, method: 'DELETE' });
  const input = { projectId: project.id, title: '月度实测', format: 'sheet', sheet };
  const create = (actor, body, expected = 201, key = randomUUID()) =>
    call(root, expected, { actor, method: 'POST', key, body });
  const key = randomUUID();
  const initial = await create(owner, input, 201, key);
  assert.equal(initial.format, 'sheet');
  assert.equal(initial.projectId, project.id);
  assert.equal(initial.sourceMessageId, undefined);
  assert.deepEqual(initial.head.sheet, sheet);
  assert.equal(initial.head.content, undefined);
  assert.ok(initial.size > 0 && initial.size <= 32 * 1024);
  assert.equal((await create(owner, input, 201, key)).id, initial.id);
  await create(owner, { ...input, content: 'Invalid alternate representation' }, 400);
  await create(owner, { ...input, sourceMessageId: randomUUID() }, 400);
  await create(owner, { ...input, sheet: { name: 'Ragged', rows: [[true, false], [null]] } }, 400);
  await create(owner, { ...input, sheet: { name: 'Too many columns', rows: [Array(17).fill(null)] } }, 400);
  await create(owner, { ...input, sheet: { name: 'Too many rows', rows: Array.from({ length: 65 }, () => [null]) } }, 400);
  await create(owner, { ...input, sheet: { name: 'Too much content', rows: Array.from({ length: 34 }, () => ['a'.repeat(1024)]) } }, 413);
  const raw = JSON.stringify({ ...input, sheet: { name: 'Precision', rows: [[null]] } })
    .replace('[[null]]', '[[0.100000000000000000001]]');
  await call(root, 400, { actor: owner, method: 'POST', key: randomUUID(), raw });
  await create(outsider, input, 404);
  const blank = await create(owner, { ...input, sheet: { name: 'Blank', rows: [[null, null], [null, null]] } });
  assert.deepEqual(blank.head.sheet.rows, [[null, null], [null, null]]);
  await call(root + '/' + blank.id, 204, { actor: owner, method: 'DELETE' });

  const revisionRoute = root + '/' + initial.id + '/versions';
  const revision = { baseVersionId: initial.head.id, title: 'Edited grid',
    sheet: { name: 'Revision', rows: [[17, false, 'Edited', null]] } };
  const modified = await call(revisionRoute, 201, { actor: owner, method: 'POST', body: revision });
  assert.deepEqual(modified.head.sheet, revision.sheet);
  await call(revisionRoute, 409, { actor: owner, method: 'POST', body: revision });
  const rollbackRoute = root + '/' + initial.id + '/rollback';
  const rolled = await call(rollbackRoute, 201, { actor: owner, method: 'POST',
    body: { baseVersionId: modified.head.id, versionId: initial.head.id } });
  assert.equal(rolled.head.number, 3);
  assert.equal(rolled.head.restoredFromVersionId, initial.head.id);
  assert.deepEqual(rolled.head.sheet, sheet);
  const workbook = await readback(owner, rolled, rolled.head);
  await call(workbook.path, 401, { binary: true });
  await call(workbook.path, 404, { actor: outsider, binary: true });
  const published = '/collaboration/projects/' + project.id + '/artifact-publications';
  await call(published, 404, { actor: owner, method: 'POST',
    body: { artifactId: rolled.id, versionId: rolled.head.id, confirm: true } });
  const expectedVersions = [initial.head, modified.head, rolled.head];
  await ownerExport(owner, rolled, expectedVersions);
  const foreign = await call('/privacy/export', 200, { actor: outsider });
  assert.deepEqual(foreign.privateArtifacts, []);
  assert.deepEqual(foreign.privateArtifactVersions, []);

  if (evidence) {
    await writeFile(join(evidence, 'sheet-editing-switch-ready'), '', { flag: 'wx' });
    await waitForEditSwitch();
    await capabilities(owner, false);
    await create(owner, input, 403);
    await call(revisionRoute, 403, { actor: owner, method: 'POST',
      body: { ...revision, baseVersionId: rolled.head.id } });
    await call(rollbackRoute, 403, { actor: owner, method: 'POST',
      body: { baseVersionId: rolled.head.id, versionId: initial.head.id } });
    const fetched = await call(root + '/' + rolled.id, 200, { actor: owner });
    assert.deepEqual(fetched, rolled);
    await readback(owner, rolled, rolled.head);
    await ownerExport(owner, rolled, expectedVersions);
  }
  await call(root + '/' + rolled.id, 204, { actor: owner, method: 'DELETE' });
  await call(workbook.path, 404, { actor: owner, binary: true });
  const erased = await call('/privacy/export', 200, { actor: owner });
  assert.deepEqual(erased.privateArtifacts, []);
  assert.deepEqual(erased.privateArtifactVersions, []);
  console.log(JSON.stringify({ actualOOXMLBytes: workbook.bytes, literalCells: 'passed',
    existingMarkdown: 'passed',
    exactDecimalRejection: 'passed', ownerScope: 'passed', immutableVersions: expectedVersions.length,
    typedDataExport: 'passed', publicationBlocked: 'passed', erased: 'passed',
    editingDisabledRetention: evidence ? 'passed' : undefined }));
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
