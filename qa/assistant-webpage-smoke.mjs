import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const api = new URL(process.argv[2]);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(api.hostname) && api.port && api.port !== '18080',
  'Use a dedicated loopback fixture with synthetic accounts.');
const switchArgument = process.argv.indexOf('--switch');
const evidence = switchArgument === -1 ? undefined : process.argv[switchArgument + 1];
const root = '/artifacts';
const actors = [];
const website = {
  heading: '合成网页 🦀 <script>literal heading</script>',
  introduction: '保留原始换行\r\n第二行',
  sections: [{
    title: '示例 <img src="https://example.invalid/a.png">',
    paragraphs: ['<a href="https://example.invalid/path">纯文本链接</a> & "保留引号"',
      '<form action="https://example.invalid/"><input value="保留标签"></form>'],
  }],
};

async function call(path, expected, { actor, workspace, method = 'GET', body, key, html = false } = {}) {
  const headers = { Accept: html ? 'text/html' : 'application/json' };
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
  if (html && response.ok) {
    assert.match(response.headers.get('content-type') ?? '', /^text\/html;\s*charset=UTF-8$/i);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const policy = response.headers.get('content-security-policy');
    assert.match(policy ?? '', /sandbox; default-src 'none'; style-src 'sha256-[A-Za-z0-9+/]{43}='; base-uri 'none'; form-action 'none'; frame-ancestors 'none'/);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(Number(response.headers.get('content-length')), bytes.length);
    return { bytes, policy, disposition: response.headers.get('content-disposition') };
  }
  if (html) assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i);
  return response.json();
}

async function register() {
  const credentials = { username: 'qa-page-' + randomUUID().slice(0, 12), password: 'PageQ.A!' + randomUUID() };
  const actor = { ...await call('/auth/register', 201, { method: 'POST', body: credentials }), credentials };
  actors.push(actor);
  return actor;
}

async function capabilities(actor, editing) {
  const { capabilities: features } = await call('/capabilities', 200, { actor });
  assert.equal(features.find(({ id }) => id === 'private_artifacts')?.available, true);
  assert.equal(features.find(({ id }) => id === 'private_webpages')?.available, editing);
}

async function verifyBrowser(actor, path) {
  const require = createRequire(new URL('../clients/web/package.json', import.meta.url));
  const { chromium } = require('@playwright/test');
  const target = new URL('/api/assistant/v1' + path, api).href;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const tab = await context.newPage();
    const requests = [];
    await tab.route('**/*', (request) => {
      const outgoing = request.request();
      requests.push(outgoing.url());
      return outgoing.url() === target
        ? request.continue({ headers: { ...outgoing.headers(), Authorization: 'Bearer ' + actor.accessToken,
          'X-Workspace-Id': actor.user.workspaceId } })
        : request.abort();
    });
    const loaded = await tab.goto(target, { waitUntil: 'networkidle' });
    assert.equal(loaded.status(), 200);
    assert.equal(await tab.title(), website.heading);
    assert.equal(await tab.locator('h1').textContent(), website.heading);
    assert.equal(await tab.locator('h2').textContent(), website.sections[0].title);
    assert.deepEqual(await tab.locator('section p').allTextContents(), website.sections[0].paragraphs);
    assert.equal(await tab.locator('script, iframe, img, form, a, link, object, embed, input').count(), 0);
    assert.equal(await tab.locator('[src], [href], [action], [srcdoc], [onload], [onclick]').count(), 0);
    assert.equal(await tab.locator('body').evaluate((body) => getComputedStyle(body).backgroundColor), 'rgb(247, 248, 250)');
    assert.equal(await tab.locator('p').first().evaluate((body) => getComputedStyle(body).whiteSpace), 'pre-wrap');
    assert.deepEqual(requests, [target]);
    await context.close();
  } finally {
    await browser.close();
  }
}

async function rendered(actor, artifact, head) {
  const version = root + '/' + artifact.id + '/versions/' + head.id;
  const preview = await call(version + '/preview', 200, { actor, html: true });
  const download = await call(version + '/download', 200, { actor, html: true });
  assert.equal(preview.disposition, 'inline');
  assert.equal(download.disposition, 'attachment; filename="artifact-' + head.number + '.html"');
  assert.deepEqual(preview.bytes, download.bytes);
  assert.equal(preview.policy, download.policy);
  const text = preview.bytes.toString('utf8');
  assert.match(text, /合成网页 🦀 &lt;script&gt;/u);
  assert.match(text, /保留原始换行\r\n第二行/u);
  assert.match(text, /&lt;img src=&quot;https:\/\/example\.invalid\/a\.png&quot;&gt;/);
  assert.ok(!/<(script|img|form|iframe|a)\b/.test(text));
  const style = text.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.ok(preview.policy.includes("'sha256-" + createHash('sha256').update(style).digest('base64') + "'"));
  return { preview: version + '/preview', download: version + '/download', bytes: preview.bytes.length };
}

async function waitForEditSwitch() {
  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    try {
      await access(join(evidence, 'webpage-editing-disabled'));
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(250);
  }
  assert.fail('The retained webpage fixture did not turn editing off.');
}

async function ownerExport(actor, artifact, expectedVersions) {
  const body = await call('/privacy/export', 200, { actor });
  const summary = body.privateArtifacts.find(({ id }) => id === artifact.id);
  assert.equal(summary.format, 'webpage');
  assert.equal(summary.headVersionId, artifact.head.id);
  const versions = body.privateArtifactVersions.filter(({ artifactId }) => artifactId === artifact.id)
    .sort((a, b) => a.number - b.number);
  assert.deepEqual(versions, expectedVersions);
  for (const item of versions) {
    assert.ok(!item.content && !item.sheet && !item.presentation && !item.code);
  }
}

async function test(owner, outsider) {
  await capabilities(owner, true);
  const project = await call('/projects', 201, { actor: owner, method: 'POST', body: { name: 'Private webpage' } });
  const create = (actor, body, expected = 201, key = randomUUID()) =>
    call(root, expected, { actor, method: 'POST', key, body });
  const draft = { projectId: project.id, title: '版本化网页', format: 'webpage', website };
  const key = randomUUID();
  const first = await create(owner, draft, 201, key);
  assert.equal(first.format, 'webpage');
  assert.equal(first.sourceMessageId, undefined);
  assert.deepEqual(first.head.website, website);
  assert.equal((await create(owner, draft, 201, key)).id, first.id);
  await create(owner, { ...draft, projectId: undefined }, 400);
  await create(owner, { ...draft, sourceMessageId: randomUUID() }, 400);
  await create(owner, { ...draft, content: '<b>Raw</b>' }, 400);
  await create(owner, { ...draft, website: { ...website, url: 'https://example.invalid/' } }, 400);
  await create(owner, { ...draft, website: { ...website, heading: 'a'.repeat(81) } }, 400);
  await create(owner, { ...draft, website: { ...website, sections: [] } }, 400);
  await create(owner, { ...draft, website: { ...website, sections: [{ title: 'Bad', paragraphs: ['x'.repeat(401)] }] } }, 400);
  await create(outsider, draft, 404);
  const revise = root + '/' + first.id + '/versions';
  const revision = { baseVersionId: first.head.id, title: '修改',
    website: { heading: '新版本', introduction: '', sections: [{ title: '版本内容', paragraphs: ['合成修改'] }] } };
  const second = await call(revise, 201, { actor: owner, method: 'POST', body: revision });
  assert.deepEqual(second.head.website, revision.website);
  await call(revise, 409, { actor: owner, method: 'POST', body: revision });
  const rollback = root + '/' + first.id + '/rollback';
  const third = await call(rollback, 201, { actor: owner, method: 'POST',
    body: { baseVersionId: second.head.id, versionId: first.head.id } });
  assert.equal(third.head.number, 3);
  assert.equal(third.head.restoredFromVersionId, first.head.id);
  assert.deepEqual(third.head.website, website);
  const result = await rendered(owner, third, third.head);
  await verifyBrowser(owner, result.preview);
  for (const route of [result.preview, result.download]) {
    await call(route, 401, { html: true });
    await call(route, 404, { actor: outsider, html: true });
    await call(route, 403, { actor: owner, workspace: outsider.user.workspaceId, html: true });
  }
  const markdown = await create(owner, { projectId: project.id, title: 'Text fixture', format: 'markdown', content: 'text' });
  await call(root + '/' + markdown.id + '/versions/' + markdown.head.id + '/preview', 404, { actor: owner, html: true });
  await call(root + '/' + markdown.id, 204, { actor: owner, method: 'DELETE' });
  await call('/collaboration/projects/' + project.id + '/artifact-publications', 404, {
    actor: owner, method: 'POST', body: { artifactId: third.id, versionId: third.head.id, confirm: true },
  });
  const expectedVersions = [first.head, second.head, third.head];
  await ownerExport(owner, third, expectedVersions);
  const foreign = await call('/privacy/export', 200, { actor: outsider });
  assert.deepEqual(foreign.privateArtifacts, []);
  assert.deepEqual(foreign.privateArtifactVersions, []);
  if (evidence) {
    await writeFile(join(evidence, 'webpage-editing-switch-ready'), '', { flag: 'wx' });
    await waitForEditSwitch();
    await capabilities(owner, false);
    await create(owner, draft, 403);
    await call(revise, 403, { actor: owner, method: 'POST', body: { ...revision, baseVersionId: third.head.id } });
    await call(rollback, 403, { actor: owner, method: 'POST',
      body: { baseVersionId: third.head.id, versionId: first.head.id } });
    assert.deepEqual(await call(root + '/' + third.id, 200, { actor: owner }), third);
    await rendered(owner, third, third.head);
    await ownerExport(owner, third, expectedVersions);
  }
  await call(root + '/' + third.id, 204, { actor: owner, method: 'DELETE' });
  await call(result.preview, 404, { actor: owner, html: true });
  await call(result.download, 404, { actor: owner, html: true });
  const removed = await call('/privacy/export', 200, { actor: owner });
  assert.deepEqual(removed.privateArtifacts, []);
  assert.deepEqual(removed.privateArtifactVersions, []);
  console.log(JSON.stringify({ renderedUtf8Bytes: result.bytes, immutableVersions: expectedVersions.length,
    ownerScope: 'passed', previewAndDownload: 'passed', additionalBrowserRequests: 0,
    typedExport: 'passed', publicationBlocked: 'passed', erased: 'passed',
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
