import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function loopback(address) {
  const url = new URL(address);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)
    && url.port && !['18080', '18090'].includes(url.port) && url.pathname === '/' && !url.username && !url.password
    && !url.search && !url.hash, 'Use an isolated local fixture.');
  return url;
}

const prefix = '/api/assistant/v1';
const reminders = '/automations/reminders';
const templates = '/automations/reminder-shares';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const pageMarker = 'Synthetic reviewed webpage';
const reminderMarker = 'Synthetic scheduled material';

/**
 * The operator provider obtains an isolated admin session and grants only the fixture owner scope.
 * It receives the generated workspace ID and yields secrets in memory.
 */
export async function runPublicTargetReports({ source, restored, directory, provisionOperator }) {
  let origin = loopback(source);
  const sourceOrigin = origin;
  const restoreOrigin = restored && loopback(restored);
  assert.equal(Boolean(directory), Boolean(restoreOrigin));
  assert.equal(typeof provisionOperator, 'function');

  async function call(path, expected, { auth, method = 'GET', body, key, html = false } = {}) {
    const headers = { Accept: html ? 'text/html' : 'application/json' };
    if (auth) headers.Authorization = 'Bearer ' + auth.token;
    if (auth?.workspace) headers['X-Workspace-Id'] = auth.workspace;
    if (auth?.cookie) headers.Cookie = auth.cookie;
    if (key) headers['Idempotency-Key'] = key;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(new URL(path, origin), { headers, method,
      body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
      signal: AbortSignal.timeout(12_000) });
    assert.equal(response.status, expected, method + ' ' + path + ' (' + response.status + ')');
    if (path.startsWith(prefix + '/reports') || path.includes('/report-target')) {
      assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
    }
    if (expected === 204) return undefined;
    return html ? Buffer.from(await response.arrayBuffer()) : response.json();
  }

  async function actor() {
    const username = 'qa-public-report-' + randomUUID().slice(0, 9);
    const result = await call(prefix + '/auth/register', 201, { method: 'POST',
      body: { username, password: 'Qa.PublicReport!' + randomUUID() } });
    return { token: result.accessToken, workspace: result.user.workspaceId };
  }

  function website(label) {
    return { heading: label, introduction: label, sections: [{ title: 'Test', paragraphs: ['Synthetic material'] }] };
  }

  async function addSite(owner, projectId, title) {
    const item = await call(prefix + '/artifacts', 201, { auth: owner, method: 'POST', key: randomUUID(),
      body: { projectId, title, format: 'webpage', website: website(title) } });
    return { artifact: item.id, version: item.head.id,
      management: prefix + '/projects/' + projectId + '/artifacts/' + item.id + '/hosting' };
  }

  async function publishSite(owner, item, version, expectedRevision = null) {
    const preview = await call(item.management + '/preview/' + version, 200, { auth: owner });
    return call(item.management, 200, { auth: owner, method: 'PUT', body: {
      versionId: version, contentDigest: preview.contentDigest, expectedRevision, confirm: true,
    } });
  }

  async function publicRead(site, expected) {
    const url = new URL(site.url);
    assert.equal(url.origin, 'http://localhost:' + sourceOrigin.port);
    const siteId = url.pathname.split('/').at(-1);
    assert.match(siteId, uuid);
    assert.equal(url.pathname, '/assistant-sites/' + siteId);
    assert.equal(url.search + url.hash, '');
    url.port = origin.port;
    const response = await fetch(url, { headers: { Accept: 'text/html' }, redirect: 'error',
      signal: AbortSignal.timeout(12_000) });
    assert.equal(response.status, expected, 'Isolated hosted page');
    assert.equal(response.headers.get('x-assistant-publication-revision'), expected === 200 ? site.revision : null);
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
    assert.match(response.headers.get('content-security-policy') ?? '', /^sandbox;/);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { siteId, bytes };
  }

  async function addTemplate(owner, suffix) {
    const scheduled = await call(prefix + reminders, 201, { auth: owner, method: 'POST', key: randomUUID(),
      body: { title: reminderMarker + suffix, startsAtLocal: '2030-06-15T10:45',
        cadence: 'once', timeZone: 'UTC' } });
    const route = prefix + reminders + '/' + scheduled.id;
    const preview = await call(route + '/share-preview', 200, { auth: owner, method: 'POST' });
    const share = await call(route + '/shares', 201, { auth: owner, method: 'POST',
      body: { revision: preview.revision } });
    return { scheduled, share };
  }

  function readTemplate(auth, item, expected = 200) {
    return call(prefix + templates + '/read', expected, { auth, method: 'POST',
      body: { token: item.share.token } });
  }

  function report(auth, body, expected = 201) {
    return call(prefix + '/reports', expected, { auth, method: 'POST', body });
  }

  async function marker(name) {
    await writeFile(join(directory, name), 'ok\n', { flag: 'wx' });
  }

  async function wait(name) {
    for (const deadline = Date.now() + 240_000; Date.now() < deadline;) {
      try {
        await access(join(directory, name));
        return;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await delay(200);
    }
    assert.fail('Missing isolated PostgreSQL fixture marker ' + name);
  }

  const owner = await actor();
  const recipient = await actor();
  const operator = await provisionOperator(owner.workspace);
  try {
    const { capabilities } = await call(prefix + '/capabilities', 200, { auth: recipient });
    assert.equal(capabilities.find(({ id }) => id === 'hosted_site_reporting')?.available, true);
    const project = await call(prefix + '/projects', 201, { auth: owner, method: 'POST',
      body: { name: 'Synthetic public report fixtures' } });
    const page = await addSite(owner, project.id, pageMarker + ' 1');
    const controlPage = await addSite(owner, project.id, 'Independent page');
    const first = await publishSite(owner, page, page.version);
    const siteControl = await publishSite(owner, controlPage, controlPage.version);
    const original = await publicRead(first, 200);
    const targetPath = prefix + '/hosted-sites/' + original.siteId + '/report-target';
    await call(targetPath, 401);
    assert.deepEqual(await call(targetPath, 200, { auth: recipient }),
      { siteId: original.siteId, revision: first.revision, publicUrl: first.url });
    const hostedRequest = { targetType: 'hosted_site', targetId: original.siteId,
      revision: first.revision, reason: 'privacy' };
    await report(undefined, hostedRequest, 401);
    await report(recipient, { ...hostedRequest, revision: randomUUID() }, 404);
    const oldCase = await report(recipient, hostedRequest);
    assert.equal(oldCase.targetId, first.revision);

    const secondVersion = await call(prefix + '/artifacts/' + page.artifact + '/versions', 201,
      { auth: owner, method: 'POST', body: { baseVersionId: page.version,
        title: pageMarker + ' 2', website: website(pageMarker + ' 2') } });
    const current = await publishSite(owner, page, secondVersion.head.id, first.revision);
    assert.equal(current.url, first.url);
    assert.notEqual(current.revision, first.revision);
    const currentPublic = await publicRead(current, 200);
    await report(recipient, hostedRequest, 404);
    const freshRequest = { ...hostedRequest, revision: current.revision };
    const currentCase = await report(recipient, freshRequest);
    assert.deepEqual(await report(recipient, freshRequest, 200), currentCase);
    const ops = '/system/assistant/moderation/workspaces/' + owner.workspace + '/reports/';
    const otherOps = '/system/assistant/moderation/workspaces/' + recipient.workspace + '/reports';
    await call(otherOps, 403, { auth: operator });
    await call(ops + currentCase.id, 401, { auth: recipient });

    function detail(item) {
      return call(ops + item.id, 200, { auth: operator });
    }

    function withdraw(item) {
      return call(ops + item.id + '/decision', 200, { auth: operator, method: 'POST',
        body: { decision: 'withdraw' } });
    }

    assert.equal((await withdraw(oldCase)).status, 'target_unavailable');
    assert.deepEqual((await publicRead(current, 200)).bytes, currentPublic.bytes);
    const template = await addTemplate(owner, '');
    const controlTemplate = await addTemplate(owner, ' independent');
    const view = await readTemplate(recipient, template);
    const reminderRequest = { targetType: 'reminder_share', shareToken: template.share.token,
      revision: view.revision, reason: 'spam' };
    await report(undefined, reminderRequest, 401);
    await report(owner, reminderRequest, 409);
    await report(recipient, { ...reminderRequest, shareToken: controlTemplate.share.token }, 409);
    const reminderCase = await report(recipient, reminderRequest);
    assert.equal(reminderCase.targetId, template.share.id);
    assert.deepEqual(await report(recipient, reminderRequest, 200), reminderCase);
    for (const item of [currentCase, reminderCase]) {
      const open = await detail(item);
      assert.equal(open.targetAvailable, true);
      assert.equal(open.preview ?? null, null);
      assert.match(open.evidenceDigest, /^[0-9a-f]{64}$/);
      const exposed = JSON.stringify({ report: item, detail: open });
      for (const secret of [pageMarker, reminderMarker, template.share.token]) {
        assert.ok(!exposed.includes(secret), 'Report payload exposes synthetic target material');
      }
    }

    if (restoreOrigin) {
      await marker('backup-ready');
      await wait('backup-done');
    }
    for (const item of [currentCase, reminderCase]) {
      const decision = await withdraw(item);
      assert.equal(decision.status, 'withdrawn');
      assert.deepEqual(await withdraw(item), decision);
      const finished = await detail(item);
      assert.equal(finished.targetAvailable, false);
      assert.equal(finished.audit.length, 1);
      assert.equal(finished.audit[0].decision, 'withdraw');
    }

    const privateVersion = prefix + '/artifacts/' + page.artifact + '/versions/' + secondVersion.head.id + '/preview';
    async function checkWithdrawals() {
      await publicRead(current, 404);
      await call(targetPath, 404, { auth: recipient });
      await report(recipient, freshRequest, 404);
      await readTemplate(recipient, template, 404);
      await report(recipient, reminderRequest, 404);
      await publicRead(siteControl, 200);
      await readTemplate(recipient, controlTemplate);
      const kept = await call(privateVersion, 200, { auth: owner, html: true });
      assert.deepEqual(kept, currentPublic.bytes);
      const scheduled = await call(prefix + reminders + '/' + template.scheduled.id, 200, { auth: owner });
      assert.equal(scheduled.state, 'active');
    }
    await checkWithdrawals();
    if (restoreOrigin) {
      await marker('restore-ready');
      await wait('restore-done');
      origin = restoreOrigin;
      await checkWithdrawals();
    }
    return { exactHostedRevision: true, staleReportCannotWithdrawReplacement: true,
      scopedReminderReceipt: true, operatorAuditAndWithdrawal: true, reportMetadataOnly: true,
      privateSourcesAndControlsRemain: true, olderDatabaseReplay: Boolean(restoreOrigin) };
  } finally {
    if (operator.close) await operator.close();
  }
}
