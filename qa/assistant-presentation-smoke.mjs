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
const nativeArgument = process.argv.indexOf('--native-evidence');
const nativeEvidence = nativeArgument === -1 ? undefined : process.argv[nativeArgument + 1];
const pptx = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const root = '/artifacts';
const actors = [];
const presentation = { slides: [
  { title: '合成发展计划 🦀', bullets: ['本季度进展', 'https://example.invalid / <tag>'] },
  { title: '下一步', bullets: [] },
] };

const inspectPackage = String.raw`
import io, sys, zipfile, xml.etree.ElementTree as ET

NS = {
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main"
}
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as package:
    def root(name):
        return ET.fromstring(package.read(name))
    pres = root("ppt/presentation.xml")
    size = pres.find("p:sldSz", NS)
    assert int(size.attrib["cx"]) == 16 * int(size.attrib["cy"]) // 9
    assert len(pres.findall("./p:sldIdLst/p:sldId", NS)) == 2
    shapes = root("ppt/slides/slide1.xml").findall(".//p:sp", NS)
    assert len(shapes) == 2
    def texts(shape):
        return [n.text for n in shape.findall(".//a:t", NS)]
    def size_pt(shape):
        return int(shape.find(".//a:rPr", NS).attrib["sz"]) / 100
    def vertical(shape):
        t = shape.find(".//a:xfrm", NS)
        return int(t.find("a:off", NS).attrib["y"]), int(t.find("a:ext", NS).attrib["cy"])
    assert texts(shapes[0]) == ["\u5408\u6210\u53d1\u5c55\u8ba1\u5212 \U0001f980"]
    assert texts(shapes[1]) == ["\u672c\u5b63\u5ea6\u8fdb\u5c55", "https://example.invalid / <tag>"]
    assert size_pt(shapes[0]) == 34 and size_pt(shapes[1]) == 22
    assert shapes[0].find(".//a:rPr", NS).attrib["b"] in ("true", "1")
    assert len(shapes[1].findall(".//a:buChar", NS)) == 2
    top, height = vertical(shapes[0])
    body_top, body_height = vertical(shapes[1])
    assert top + height < body_top and body_top + body_height <= int(size.attrib["cy"])
    last = root("ppt/slides/slide2.xml").findall(".//p:sp", NS)
    assert len(last) == 1 and texts(last[0]) == ["\u4e0b\u4e00\u6b65"]
    for name in package.namelist():
        assert "vbaProject" not in name and "/embeddings/" not in name
        if name.endswith(".rels"):
            assert not any(rel.get("TargetMode") == "External" for rel in root(name))
`;

async function call(path, expected, { actor, workspace, method = 'GET', body, key, binary = false } = {}) {
  const headers = { Accept: binary ? pptx : 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.accessToken;
    headers['X-Workspace-Id'] = workspace ?? actor.user.workspaceId;
  }
  if (body) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(new URL('/api/assistant/v1' + path, api), {
    headers, method, body: body ? JSON.stringify(body) : undefined,
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  assert.equal(response.status, expected, method + ' ' + path);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
  if (response.status === 204) return undefined;
  if (binary && response.ok) {
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.headers.get('content-type'), pptx);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(Number(response.headers.get('content-length')), bytes.length);
    return { bytes, filename: response.headers.get('content-disposition') };
  }
  if (binary) assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i);
  return response.json();
}

async function register() {
  const credentials = { username: 'qa-slide-' + randomUUID().slice(0, 12), password: 'SlideQ.A!' + randomUUID() };
  const actor = { ...await call('/auth/register', 201, { method: 'POST', body: credentials }), credentials };
  actors.push(actor);
  return actor;
}

async function capabilities(actor, editing) {
  const { capabilities: features } = await call('/capabilities', 200, { actor });
  assert.equal(features.find(({ id }) => id === 'private_artifacts')?.available, true);
  assert.equal(features.find(({ id }) => id === 'private_slides')?.available, editing);
}

async function readback(actor, artifact) {
  const path = root + '/' + artifact.id + '/versions/' + artifact.head.id + '/download';
  const { bytes, filename } = await call(path, 200, { actor, binary: true });
  assert.equal(filename, 'attachment; filename="artifact-' + artifact.head.number + '.pptx"');
  const command = process.argv.includes('--wsl-python') ? 'wsl.exe' : process.platform === 'win32' ? 'py.exe' : 'python3';
  const args = command === 'wsl.exe' ? ['--exec', 'python3'] : command === 'py.exe' ? ['-3'] : [];
  execFileSync(command, [...args, '-c', inspectPackage], { input: bytes, timeout: 12_000 });
  return { bytes, path };
}

async function ownerExport(actor, artifact, expectedVersions) {
  const body = await call('/privacy/export', 200, { actor });
  const summary = body.privateArtifacts.find(({ id }) => id === artifact.id);
  assert.equal(summary.format, 'slides');
  assert.equal(summary.headVersionId, artifact.head.id);
  const versions = body.privateArtifactVersions.filter(({ artifactId }) => artifactId === artifact.id)
    .sort((a, b) => a.number - b.number);
  assert.deepEqual(versions, expectedVersions);
  assert.ok(versions.every((item) => !Object.hasOwn(item, 'content') && !Object.hasOwn(item, 'sheet')));
}

async function waitForEditSwitch() {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    try {
      await access(join(evidence, 'slides-editing-disabled'));
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(250);
  }
  assert.fail('The retained presentation fixture did not turn editing off.');
}

async function test(owner, outsider) {
  await capabilities(owner, true);
  const project = await call('/projects', 201, { actor: owner, method: 'POST', body: { name: 'Presentation scope' } });
  const create = (actor, body, expected = 201, key = randomUUID()) =>
    call(root, expected, { actor, method: 'POST', key, body });
  const text = '# 合成兼容性 🦀\r\n';
  const markdown = await create(owner, { projectId: project.id, title: 'Markdown', format: 'markdown', content: text });
  assert.equal(markdown.head.content, text);
  const sheet = { name: 'Typed values', rows: [[12.125, true, '=1+2', null]] };
  const worksheet = await create(owner, { projectId: project.id, title: 'Work sheet', format: 'sheet', sheet });
  assert.deepEqual(worksheet.head.sheet, sheet);
  await call(root + '/' + markdown.id, 204, { actor: owner, method: 'DELETE' });
  await call(root + '/' + worksheet.id, 204, { actor: owner, method: 'DELETE' });

  const draft = { projectId: project.id, title: '合成课件', format: 'slides', presentation };
  const key = randomUUID();
  const first = await create(owner, draft, 201, key);
  assert.equal(first.format, 'slides');
  assert.equal(first.projectId, project.id);
  assert.equal(first.sourceMessageId, undefined);
  assert.equal(first.head.content, undefined);
  assert.deepEqual(first.head.presentation, presentation);
  assert.equal((await create(owner, draft, 201, key)).id, first.id);
  await create(owner, { ...draft, sourceMessageId: randomUUID() }, 400);
  await create(owner, { ...draft, projectId: undefined }, 400);
  await create(owner, { ...draft, content: 'Wrong body' }, 400);
  await create(owner, { ...draft, presentation: { slides: Array(13).fill(presentation.slides[0]) } }, 400);
  await create(owner, { ...draft, presentation: { slides: [{ title: '字'.repeat(61), bullets: [] }] } }, 400);
  await create(owner, { ...draft, presentation: { slides: [{ title: 'Bad', bullets: ['a\nb'] }] } }, 400);
  await create(outsider, draft, 404);
  await call(root + '/' + first.id, 403, { actor: owner, workspace: outsider.user.workspaceId });
  const revise = root + '/' + first.id + '/versions';
  const update = { baseVersionId: first.head.id, title: '演示修订',
    presentation: { slides: [{ title: '修订页', bullets: ['不同的版本'] }] } };
  const second = await call(revise, 201, { actor: owner, method: 'POST', body: update });
  assert.deepEqual(second.head.presentation, update.presentation);
  await call(revise, 409, { actor: owner, method: 'POST', body: update });
  const rollback = root + '/' + first.id + '/rollback';
  const third = await call(rollback, 201, { actor: owner, method: 'POST',
    body: { baseVersionId: second.head.id, versionId: first.head.id } });
  assert.equal(third.head.number, 3);
  assert.equal(third.head.restoredFromVersionId, first.head.id);
  assert.deepEqual(third.head.presentation, presentation);
  const deck = await readback(owner, third);
  if (nativeEvidence) {
    await writeFile(join(nativeEvidence, 'assistant-synthetic-deck.pptx'), deck.bytes, { flag: 'wx' });
  }
  await call(deck.path, 401, { binary: true });
  await call(deck.path, 404, { actor: outsider, binary: true });
  await call('/collaboration/projects/' + project.id + '/artifact-publications', 404, {
    actor: owner, method: 'POST', body: { artifactId: third.id, versionId: third.head.id, confirm: true },
  });
  const expectedVersions = [first.head, second.head, third.head];
  await ownerExport(owner, third, expectedVersions);
  const foreign = await call('/privacy/export', 200, { actor: outsider });
  assert.deepEqual(foreign.privateArtifacts, []);
  assert.deepEqual(foreign.privateArtifactVersions, []);
  if (evidence) {
    await writeFile(join(evidence, 'slides-editing-switch-ready'), '', { flag: 'wx' });
    await waitForEditSwitch();
    await capabilities(owner, false);
    await create(owner, draft, 403);
    await call(revise, 403, { actor: owner, method: 'POST', body: { ...update, baseVersionId: third.head.id } });
    await call(rollback, 403, { actor: owner, method: 'POST',
      body: { baseVersionId: third.head.id, versionId: first.head.id } });
    assert.deepEqual(await call(root + '/' + third.id, 200, { actor: owner }), third);
    await readback(owner, third);
    await ownerExport(owner, third, expectedVersions);
  }
  await call(root + '/' + third.id, 204, { actor: owner, method: 'DELETE' });
  await call(deck.path, 404, { actor: owner, binary: true });
  const removed = await call('/privacy/export', 200, { actor: owner });
  assert.deepEqual(removed.privateArtifacts, []);
  assert.deepEqual(removed.privateArtifactVersions, []);
  console.log(JSON.stringify({ actualOOXMLBytes: deck.bytes.length, styledSlides: 2,
    revisions: expectedVersions.length, ownerScope: 'passed', typedExport: 'passed',
    existingMarkdownAndSheets: 'passed', publicationBlocked: 'passed', erased: 'passed',
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
