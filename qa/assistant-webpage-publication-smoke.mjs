import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

let origin = new URL(process.argv[2]);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && origin.port && !['18080', '18090'].includes(origin.port),
  'Use a dedicated loopback fixture with synthetic accounts.');
const evidence = process.argv[3];
assert.ok(evidence);
const typed = process.argv.includes('--typed');
const typedSwitch = process.argv.includes('--typed-switch');
const typedRestoreIndex = process.argv.indexOf('--typed-restore');
const typedRestore = typedRestoreIndex < 0 ? null : new URL(process.argv[typedRestoreIndex + 1]);
assert.ok(!typedRestore || (typed && ['127.0.0.1', 'localhost', '[::1]'].includes(typedRestore.hostname)
  && typedRestore.port && !['18080', '18090', origin.port].includes(typedRestore.port)));
assert.ok(!typedSwitch || (typed && !typedRestore));
const actors = [];
const artifacts = '/artifacts';
const content = {
  heading: '获准查看的合成页面 🦀',
  introduction: '第一行\r\n第二行',
  sections: [{ title: '公开给本项目', paragraphs: ['<img src="https://example.invalid/"> & 仅文字'] }],
};

async function call(path, expected, { actor, method = 'GET', body, key, accept, png, grant } = {}) {
  const headers = { Accept: accept ?? 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.accessToken;
    headers['X-Workspace-Id'] = actor.workspace ?? actor.user.workspaceId;
  }
  if (png) headers['Content-Type'] = 'image/png';
  else if (body) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  if (grant) headers['X-Attachment-Grant'] = grant;
  const reply = await fetch(new URL('/api/assistant/v1' + path, origin), {
    headers, method, body: png ?? (body ? JSON.stringify(body) : undefined),
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  assert.equal(reply.status, expected, method + ' ' + path);
  assert.match(reply.headers.get('cache-control') ?? '', /no-store/i);
  if (reply.status === 204) return undefined;
  if (accept && reply.ok) {
    const mediaType = reply.headers.get('content-type') ?? '';
    assert.equal(mediaType.split(';')[0], accept);
    if (accept.startsWith('text/')) assert.match(mediaType, /;\s*charset=UTF-8$/i);
    assert.equal(reply.headers.get('x-content-type-options'), 'nosniff');
    const bytes = Buffer.from(await reply.arrayBuffer());
    assert.equal(Number(reply.headers.get('content-length')), bytes.length);
    return { bytes, disposition: reply.headers.get('content-disposition'),
      csp: reply.headers.get('content-security-policy') };
  }
  if (accept) assert.match(reply.headers.get('content-type') ?? '', /^application\/json\b/i);
  return reply.json();
}

async function register() {
  const credentials = { username: 'qa-pagepub-' + randomUUID().slice(0, 9), password: 'Test.PagePub!' + randomUUID() };
  const actor = { ...await call('/auth/register', 201, { method: 'POST', body: credentials }), credentials };
  actors.push(actor);
  return actor;
}

async function mark(name, data = {}) {
  const target = join(evidence, name + '.json');
  await writeFile(target + '.tmp', JSON.stringify(data) + '\n', { flag: 'wx' });
  await rename(target + '.tmp', target);
}

async function until(name) {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    try {
      await access(join(evidence, name + '.json'));
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(200);
  }
  assert.fail('Fixture marker not available: ' + name);
}

async function capability(actor, enabled) {
  const { capabilities } = await call('/capabilities', 200, { actor });
  assert.equal(capabilities.find(({ id }) => id === 'project_artifact_publications')?.available, true);
  assert.equal(capabilities.find(({ id }) => id === 'project_artifact_comments')?.available, true);
  assert.equal(capabilities.find(({ id }) => id === 'project_webpage_publications')?.available, enabled);
}

async function grant(owner, actor, project, role) {
  const invite = await call('/projects/' + project + '/collaboration/invitations', 201, {
    actor: owner, method: 'POST', body: { recipientUsername: actor.user.username, role },
  });
  await call('/collaboration/invitations/' + invite.id + '/accept', 200,
    { actor, method: 'POST', body: { confirm: true } });
  return invite;
}

async function linkedWebpage(owner, projectId) {
  const conversation = await call('/conversations', 201, { actor: owner, method: 'POST',
    body: { projectId, title: 'Synthetic source for webpage approval' } });
  const reply = await call('/conversations/' + conversation.id + '/runs', 202, {
    actor: owner, method: 'POST', key: randomUUID(),
    body: { action: 'send', modelId: 'local-echo', content: '源回复数据 🦀 <b>字面内容</b>' },
  });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const run = await call('/runs/' + reply.runId, 200, { actor: owner });
    if (run.state === 'completed') {
      const artifact = await call(artifacts, 201, { actor: owner, method: 'POST', key: randomUUID(),
        body: { sourceMessageId: run.messageId, title: '从回复生成网页', format: 'webpage' } });
      assert.equal(artifact.sourceMessageId, run.messageId);
      assert.equal(artifact.projectId, projectId);
      assert.ok(artifact.head.website.sections.flatMap(({ paragraphs }) => paragraphs).join('')
        .includes('源回复数据 🦀'));
      return { conversation, artifact };
    }
    assert.ok(['queued', 'running'].includes(run.state));
    await delay(100);
  }
  assert.fail('Local synthetic webpage source reply did not complete.');
}

async function test(owner, viewer, editor) {
  await capability(owner, true);
  const workspace = owner.user.workspaceId;
  viewer.workspace = workspace;
  editor.workspace = workspace;
  const project = await call('/projects', 201, { actor: owner, method: 'POST', body: { name: 'Synthetic publication' } });
  const scopeKey = '/collaboration/projects/' + project.id + '/artifact-publications';
  const post = (actor, artifact, version, expected = 201, confirm = true) => call(scopeKey, expected, {
    actor, method: 'POST', body: { artifactId: artifact.id, versionId: version.id, confirm },
  });
  const create = (body) => call(artifacts, 201, { actor: owner, method: 'POST', key: randomUUID(),
    body: { projectId: project.id, ...body } });
  await mark('membership-ready', { ownerAccount: owner.user.id, workspace, members: [viewer.user.id, editor.user.id] });
  await until('membership-added');
  await call(scopeKey, 404, { actor: viewer });
  const viewerGrant = await grant(owner, viewer, project.id, 'viewer');
  await grant(owner, editor, project.id, 'editor');
  const draft = await create({ title: 'Private exact original', format: 'webpage', website: content });
  const later = await call(artifacts + '/' + draft.id + '/versions', 201, {
    actor: owner, method: 'POST', body: { baseVersionId: draft.head.id, title: 'New unpublished title',
      website: { ...content, heading: 'Private revised page' } },
  });
  await post(owner, draft, draft.head, 400, false);
  await post(editor, draft, draft.head, 403);
  const approved = await post(owner, draft, draft.head);
  await post(owner, draft, draft.head, 409);
  assert.equal(approved.format, 'webpage');
  assert.equal(approved.versionNumber, 1);
  assert.equal(approved.title, draft.title);
  const route = scopeKey + '/' + approved.id;
  assert.deepEqual((await call(scopeKey, 200, { actor: viewer })).items, [approved]);
  assert.deepEqual(await call(route, 200, { actor: viewer }), { ...approved, website: content });
  const rendered = await call(route + '/preview', 200, { actor: viewer, accept: 'text/html' });
  const downloaded = await call(route + '/download', 200, { actor: viewer, accept: 'text/html' });
  const privatePreview = await call(artifacts + '/' + draft.id + '/versions/' + draft.head.id + '/preview',
    200, { actor: owner, accept: 'text/html' });
  assert.equal(rendered.disposition, 'inline');
  assert.equal(downloaded.disposition, 'attachment; filename="artifact.html"');
  assert.match(rendered.csp ?? '', /sandbox; default-src 'none'; style-src 'sha256-/);
  assert.equal(rendered.csp, privatePreview.csp);
  assert.deepEqual(rendered.bytes, privatePreview.bytes);
  assert.deepEqual(rendered.bytes, downloaded.bytes);
  assert.ok(rendered.bytes.toString('utf8').includes('&lt;img src=&quot;https://example.invalid/'));
  assert.ok(!/<(?:script|img|iframe|form|a)\b/.test(rendered.bytes.toString('utf8')));
  await call(route + '/preview', 401, { accept: 'text/html' });
  await call(artifacts + '/' + draft.id + '/versions/' + later.head.id + '/preview',
    404, { actor: viewer, accept: 'text/html' });

  const commentInput = { content: 'Synthetic linked version comment' };
  await call(route + '/comments', 403, { actor: viewer, method: 'POST', key: randomUUID(), body: commentInput });
  const comment = await call(route + '/comments', 201,
    { actor: editor, method: 'POST', key: randomUUID(), body: commentInput });
  assert.ok((await call(route + '/comments', 200, { actor: viewer })).items.some(({ id }) => id === comment.id));
  const revokeWhileHidden = await post(owner, later, later.head);

  const oldText = '合成起始 Markdown\r\n';
  const oldArtifact = await create({ title: 'Previous Markdown', format: 'markdown', content: oldText });
  const oldPublication = await post(owner, oldArtifact, oldArtifact.head);
  const oldRoute = scopeKey + '/' + oldPublication.id;
  assert.equal((await call(oldRoute, 200, { actor: viewer })).content, oldText);
  assert.equal((await call(oldRoute + '/download', 200, { actor: viewer, accept: 'text/markdown' })).bytes
    .toString('utf8'), oldText);

  if (process.argv.includes('--switch')) {
    await mark('webpage-publication-disable-ready');
    await until('webpage-publication-disabled');
    await capability(owner, false);
    await call(route, 404, { actor: viewer });
    await call(route + '/preview', 404, { actor: viewer, accept: 'text/html' });
    await call(route + '/download', 404, { actor: viewer, accept: 'text/html' });
    await call(route + '/comments', 404, { actor: editor });
    assert.deepEqual((await call(scopeKey, 200, { actor: viewer })).items, [oldPublication]);
    await call(scopeKey + '/' + revokeWhileHidden.id, 204, { actor: owner, method: 'DELETE' });
    const whileDisabled = await create({ title: 'Text while disabled', format: 'text', content: 'Synthetic independent' });
    await post(owner, whileDisabled, whileDisabled.head);
    await mark('webpage-publication-enable-ready');
    await until('webpage-publication-enabled');
    await capability(owner, true);
    assert.deepEqual(await call(route, 200, { actor: viewer }), { ...approved, website: content });
    assert.ok((await call(route + '/comments', 200, { actor: viewer })).items.some(({ id }) => id === comment.id));
    await call(scopeKey + '/' + revokeWhileHidden.id, 404, { actor: viewer });
  }

  const linked = await linkedWebpage(owner, project.id);
  const linkedPublication = await post(owner, linked.artifact, linked.artifact.head);
  const linkedRoute = scopeKey + '/' + linkedPublication.id;
  await call(linkedRoute + '/preview', 200, { actor: viewer, accept: 'text/html' });
  const restriction = '/conversations/' + linked.conversation.id + '/sharing-restriction';
  await call(restriction, 200, { actor: owner, method: 'PUT', body: { restricted: true } });
  await call(linkedRoute + '/preview', 404, { actor: viewer, accept: 'text/html' });
  await call(linkedRoute + '/comments', 404, { actor: viewer });
  await call(restriction, 200, { actor: owner, method: 'PUT', body: { restricted: false } });
  await call(linkedRoute + '/preview', 404, { actor: viewer, accept: 'text/html' });
  const reviewed = await post(owner, linked.artifact, linked.artifact.head);
  const reviewedRoute = scopeKey + '/' + reviewed.id;
  assert.notEqual(reviewed.id, linkedPublication.id);
  await call(reviewedRoute + '/preview', 200, { actor: viewer, accept: 'text/html' });
  await call('/conversations/' + linked.conversation.id, 204, { actor: owner, method: 'DELETE' });
  await call(artifacts + '/' + linked.artifact.id, 404, { actor: owner });
  await call(reviewedRoute + '/preview', 404, { actor: viewer, accept: 'text/html' });

  await call('/projects/' + project.id + '/collaboration/invitations/' + viewerGrant.id,
    204, { actor: owner, method: 'DELETE' });
  await call(route + '/preview', 404, { actor: viewer, accept: 'text/html' });
  await call(route + '/comments', 404, { actor: viewer });
  await call(route + '/preview', 200, { actor: editor, accept: 'text/html' });
  await call(artifacts + '/' + draft.id, 204, { actor: owner, method: 'DELETE' });
  await call(route + '/preview', 404, { actor: editor, accept: 'text/html' });
  await call(route + '/comments', 404, { actor: editor });
  console.log(JSON.stringify({ approvedRevision: 'immutable', scopedPreviewAndDownload: 'passed',
    scopedComments: 'passed', oldMarkdown: 'compatible', grantAndSourceRevocation: 'passed',
    replyGenerationAndSharingRevision: 'passed',
    policyOffRetained: process.argv.includes('--switch') ? 'passed' : undefined }));
}

const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const pptx = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const inspectOffice = String.raw`
import io, sys, zipfile, xml.etree.ElementTree as XML

with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
    names = archive.namelist()
    assert not any("vbaProject" in name or "externalLinks" in name for name in names)
    assert all(b'TargetMode="External"' not in archive.read(name) for name in names if name.endswith(".rels"))
    if sys.argv[1] == "sheet":
        ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        sheet = XML.fromstring(archive.read("xl/worksheets/sheet1.xml"))
        strings = XML.fromstring(archive.read("xl/sharedStrings.xml")).findall("m:si", ns)
        cells = {cell.attrib["r"]: cell for cell in sheet.findall(".//m:c", ns)}
        assert not sheet.findall(".//m:f", ns)
        assert not sheet.findall(".//m:hyperlink", ns)
        assert cells["A1"].get("t") == "s" and cells["A2"].get("t") == "s"
        for key, expected in (("A1", "=1+2"), ("A2", "@SUM(1)")):
            index = int(cells[key].findtext("m:v", namespaces=ns))
            assert strings[index].findtext("m:t", namespaces=ns) == expected
        assert float(cells["B1"].findtext("m:v", namespaces=ns)) == 12.125
        assert cells["C1"].get("t") == "b" and cells["C1"].findtext("m:v", namespaces=ns) == "1"
    else:
        ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
        texts = []
        for i in (1, 2):
            slide = XML.fromstring(archive.read(f"ppt/slides/slide{i}.xml"))
            assert not slide.findall(".//a:hlinkClick", ns)
            texts.append([part.text for part in slide.findall(".//a:t", ns)])
        assert "\u9996\u9875" in texts[0] and "\u5b57\u9762 <b>" in texts[0]
        assert "\u5e2e\u52a9" in texts[1] and "https://example.invalid/" in texts[1]
`;

function validateOffice(bytes, format) {
  const interpreter = process.platform === 'win32' ? ['wsl.exe', '-e', 'python3'] : ['python3'];
  execFileSync(interpreter[0], [...interpreter.slice(1), '-c', inspectOffice, format],
    { input: bytes, timeout: 20_000, stdio: ['pipe', 'pipe', 'pipe'] });
}

async function completedSource(owner, projectId) {
  const project = projectId ? { projectId } : {};
  const conversation = await call('/conversations', 201, { actor: owner, method: 'POST',
    body: { title: 'Synthetic completed reply for typed provenance', ...project } });
  const reply = await call('/conversations/' + conversation.id + '/runs', 202, {
    actor: owner, method: 'POST', key: randomUUID(),
    body: { action: 'send', modelId: 'local-echo', content: 'Review the selected private artifact source.' },
  });
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const run = await call('/runs/' + reply.runId, 200, { actor: owner });
    if (run.state === 'completed') {
      const history = await call('/conversations/' + conversation.id + '/messages', 200, { actor: owner });
      const prompt = history.items.find(({ role }) => role === 'user');
      assert.ok(prompt?.id);
      return { conversationId: conversation.id, messageId: run.messageId, promptId: prompt.id };
    }
    assert.ok(['queued', 'running'].includes(run.state));
    await delay(100);
  }
  assert.fail('The synthetic assistant reply did not finish.');
}

async function typedTest(owner, viewer, editor) {
  const { capabilities } = await call('/capabilities', 200, { actor: owner });
  for (const capabilityId of ['typed_reply_artifacts', 'project_spreadsheet_publications',
    'project_slide_publications', 'project_code_publications', 'project_image_publications']) {
    assert.ok(capabilities.some(({ id, available }) => id === capabilityId && available), capabilityId);
  }
  const workspace = owner.user.workspaceId;
  viewer.workspace = workspace;
  editor.workspace = workspace;
  const project = await call('/projects', 201, { actor: owner, method: 'POST', body: { name: 'Typed review fixture' } });
  const separate = await call('/projects', 201, { actor: owner, method: 'POST', body: { name: 'Different typed scope' } });
  const collection = '/collaboration/projects/' + project.id + '/artifact-publications';
  await mark('membership-ready', { ownerAccount: owner.user.id, workspace, members: [viewer.user.id, editor.user.id] });
  await until('membership-added');
  await call(collection, 404, { actor: viewer });
  const viewerGrant = await grant(owner, viewer, project.id, 'viewer');
  await grant(owner, editor, project.id, 'editor');

  const fixtureGenerator = fileURLToPath(new URL('./assistant-png-attachments-smoke.mjs', import.meta.url));
  const png = Buffer.from(execFileSync(process.execPath, [fixtureGenerator, '--clean-fixture-base64'], {
    timeout: 5000, encoding: 'utf8',
  }).trim(), 'base64');
  const attachmentRoot = '/projects/' + project.id + '/attachments';
  const pending = await call(attachmentRoot, 202, { actor: owner, method: 'POST', key: randomUUID(), png });
  const deadline = Date.now() + 35_000;
  let approved;
  while (Date.now() < deadline) {
    const latest = await call(attachmentRoot + '/' + pending.id, 200, { actor: owner });
    if (latest.state === 'approved') {
      approved = latest;
      break;
    }
    assert.equal(latest.state, 'quarantined');
    await delay(100);
  }
  assert.ok(approved, 'The known synthetic PNG was not approved.');

  const sources = {
    sheet: { field: 'sheet', value: { name: 'Review grid', rows: [['=1+2', 12.125, true], ['@SUM(1)', -5, false]] },
      mime: xlsx, filename: 'artifact.xlsx' },
    slides: { field: 'presentation', value: { slides: [{ title: '首页', bullets: ['字面 <b>'] },
      { title: '帮助', bullets: ['https://example.invalid/'] }] }, mime: pptx, filename: 'artifact.pptx' },
    code: { field: 'code', value: { language: 'python', source: '# 字面 🦀\r\nvalue = "<b>text</b>"\r\n' },
      mime: 'text/plain', filename: 'artifact.py.txt' },
    image: { field: 'image', value: { attachmentId: approved.id, altText: '选中的同项目图片' },
      mime: 'image/png', filename: 'image.png' },
  };
  function draftBody(format) {
    const shape = sources[format];
    return { title: 'Typed review ' + format, format, [shape.field]: shape.value };
  }
  const create = (body, expected = 201, actor = owner) => call(artifacts, expected, {
    actor, method: 'POST', key: randomUUID(), body,
  });
  const linked = (source, format, fields = {}, expected = 201, actor = owner) =>
    create({ sourceMessageId: source.messageId, confirmSource: true, ...draftBody(format), ...fields }, expected, actor);
  const publish = (draft, expected = 201, actor = owner) => call(collection, expected, {
    actor, method: 'POST', body: { artifactId: draft.id, versionId: draft.head.id, confirm: true },
  });
  const getPublication = (id) => collection + '/' + id;
  const privateArtifact = (id) => artifacts + '/' + id;
  const readFormat = async (route, format, actor = viewer, expected = 200) => {
    const shape = sources[format];
    const grant = format === 'image' && expected === 200
      ? (await call(route + '/download-grant', 201, { actor, method: 'POST' })).token : undefined;
    const reply = await call(route + '/download', expected, { actor, grant, accept: shape.mime });
    if (expected === 200) assert.equal(reply.disposition, 'attachment; filename="' + shape.filename + '"');
    return reply;
  };

  const shared = await completedSource(owner, project.id);
  const unfiled = await completedSource(owner);
  await linked(shared, 'sheet', { confirmSource: false }, 400);
  await linked(shared, 'sheet', { projectId: separate.id }, 404);
  await linked({ messageId: shared.promptId }, 'code', {}, 404);
  await linked(shared, 'code', {}, 404, viewer);
  await linked(unfiled, 'image', {}, 400);
  const privateOnly = await linked(unfiled, 'slides');
  assert.equal(privateOnly.sourceMessageId, unfiled.messageId);
  assert.equal(privateOnly.projectId, undefined);
  await publish(privateOnly, 404);
  const linkedRows = {};
  for (const format of Object.keys(sources)) {
    const row = await linked(shared, format, { projectId: project.id });
    assert.equal(row.projectId, project.id);
    assert.equal(row.sourceMessageId, shared.messageId);
    assert.equal(row.head.number, 1);
    const shape = sources[format];
    await call(privateArtifact(row.id) + '/versions', 201, { actor: owner, method: 'POST',
      body: { baseVersionId: row.head.id, title: 'Unreviewed successor ' + format, [shape.field]: shape.value } });
    await publish(row, 403, editor);
    const approvedPublication = await publish(row);
    assert.equal(approvedPublication.versionNumber, 1);
    assert.equal(approvedPublication.format, format);
    const route = getPublication(approvedPublication.id);
    const visible = await call(route, 200, { actor: viewer });
    const { attachmentId, ...visibleImage } = row.head.image ?? {};
    assert.deepEqual(visible, { ...approvedPublication,
      [shape.field]: format === 'image' ? visibleImage : shape.value });
    assert.ok(!attachmentId || !JSON.stringify(visible).includes(attachmentId));
    await call(privateArtifact(row.id), 404, { actor: viewer });
    const exported = await readFormat(route, format);
    if (format === 'sheet' || format === 'slides') validateOffice(exported.bytes, format);
    if (format === 'code') assert.deepEqual(exported.bytes, Buffer.from(shape.value.source, 'utf8'));
    if (format === 'image') assert.deepEqual(exported.bytes, png);
    linkedRows[format] = { row, route };
  }
  if (typedSwitch) {
    const byFormat = {
      sheet: 'project_spreadsheet_publications', slides: 'project_slide_publications',
      code: 'project_code_publications', image: 'project_image_publications',
    };
    const hidden = getPublication((await publish(await create({ ...draftBody('sheet'), projectId: project.id }))).id);
    for (const disabled of ['sheet', 'slides', 'code']) {
      await mark('typed-' + disabled + '-disable-ready');
      await until('typed-' + disabled + '-disabled');
      const { capabilities: switched } = await call('/capabilities', 200, { actor: owner });
      for (const [format, { row, route }] of Object.entries(linkedRows)) {
        assert.equal(switched.find(({ id }) => id === byFormat[format])?.available, format !== disabled);
        await readFormat(route, format, viewer, format === disabled ? 404 : 200);
        if (format === disabled) {
          await call(route + '/comments', 404, { actor: editor });
          await call(privateArtifact(row.id), 200, { actor: owner });
        }
      }
      assert.equal(switched.find(({ id }) => id === 'typed_reply_artifacts')?.available,
        disabled !== 'sheet');
      if (disabled === 'sheet') {
        await linked(shared, 'code', {}, 403);
        await create({ ...draftBody('code'), projectId: project.id });
        await call(hidden, 204, { actor: owner, method: 'DELETE' });
      }
    }
    await mark('typed-publications-enable-ready');
    await until('typed-publications-enabled');
    for (const [format, { route }] of Object.entries(linkedRows)) {
      await readFormat(route, format);
    }
    await call(hidden, 404, { actor: viewer });
  }
  const control = getPublication((await publish(await create({ ...draftBody('sheet'), projectId: project.id }))).id);
  const locked = await completedSource(owner, project.id);
  const lockedRow = await linked(locked, 'code');
  const lockedPublication = getPublication((await publish(lockedRow)).id);
  const erased = await completedSource(owner, project.id);
  const erasedRow = await linked(erased, 'slides');
  const erasedPublication = getPublication((await publish(erasedRow)).id);

  if (typedRestore) {
    await mark('backup-ready', { projectId: project.id });
    await until('backup-done');
  }
  const move = (projectId) => call('/conversations/' + shared.conversationId + '/project', 200, {
    actor: owner, method: 'PUT', body: { projectId },
  });
  await move(separate.id);
  for (const [format, { route }] of Object.entries(linkedRows)) await readFormat(route, format, viewer, 404);
  await move(project.id);
  for (const { row, route } of Object.values(linkedRows)) {
    await call(route, 404, { actor: viewer });
    await call(privateArtifact(row.id), 200, { actor: owner });
    await publish(row, 404);
  }
  const refreshed = await linked(shared, 'code');
  const freshPublication = getPublication((await publish(refreshed)).id);
  await readFormat(freshPublication, 'code');
  await call('/conversations/' + locked.conversationId + '/read-lock', 204,
    { actor: owner, method: 'POST', body: { confirm: true } });
  await call('/conversations/' + erased.conversationId, 204, { actor: owner, method: 'DELETE' });
  if (typedRestore) {
    await mark('cutover-ready');
    await until('restore-done');
    origin = typedRestore;
  }
  for (const { row, route } of Object.values(linkedRows)) {
    await call(route, 404, { actor: editor });
    await call(privateArtifact(row.id), 200, { actor: owner });
  }
  await readFormat(lockedPublication, 'code', editor, 404);
  await readFormat(erasedPublication, 'slides', editor, 404);
  await call(privateArtifact(lockedRow.id), 404, { actor: owner });
  await call(privateArtifact(erasedRow.id), 404, { actor: owner });
  validateOffice((await readFormat(control, 'sheet')).bytes, 'sheet');
  const scopedComment = { method: 'POST', body: { content: 'Review comment' }, key: randomUUID() };
  await call(control + '/comments', 403, { actor: viewer, ...scopedComment });
  await call(control + '/comments', 201, { actor: editor, ...scopedComment });
  await call('/projects/' + project.id + '/collaboration/invitations/' + viewerGrant.id, 204,
    { actor: owner, method: 'DELETE' });
  await readFormat(control, 'sheet', viewer, 404);
  await readFormat(control, 'sheet', editor);

  console.log(JSON.stringify({ result: 'reviewed_typed_reply_collaboration_verified',
    formats: Object.keys(sources), worksheetReader: 'XML', presentationReader: 'XML',
    codeExactCrlf: true, safePngGrant: true, retiredPlacement: true,
    lockedAndErasedSource: true, roleRevocation: true, restore: Boolean(typedRestore), typedSwitch }));
}

try {
  await (typed ? typedTest : test)(await register(), await register(), await register());
  for (const actor of actors) {
    delete actor.workspace;
    await call('/privacy/account-erasure', 204, { actor, method: 'POST',
      body: { currentPassword: actor.credentials.password, confirmation: 'DELETE' } });
  }
} finally {
  for (const actor of actors) await call('/auth/logout', 204, { actor, method: 'POST' }).catch(() => {});
}
