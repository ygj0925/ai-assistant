import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((value) => value.startsWith('--')));
const [source, mode = 'normal', folder, target] = argv.filter((value) => !flags.has(value));
const featureSwitch = flags.has('--switch-off');
const portability = flags.has('--portability');
assert.ok(['normal', 'restore'].includes(mode));
assert.equal(Boolean(folder && target), mode === 'restore');
assert.ok(!featureSwitch || mode === 'restore');
assert.equal(flags.size, Number(featureSwitch) + Number(portability));
const evidence = folder && resolve(folder);
const operator = { token: process.env.ASSISTANT_TEST_ORG_OPERATOR_TOKEN };
const provisionKey = process.env.ASSISTANT_TEST_CATALOG_PROVISION_KEY;
const pilotWorkspace = process.env.ASSISTANT_TEST_CATALOG_WORKSPACE;
assert.ok(operator.token && provisionKey && pilotWorkspace, 'Use the exact isolated administrator and workspace fixture.');
if (evidence) await mkdir(evidence, { recursive: true });
const prefix = '/catalog';
const sessions = [];
let result;

function loopback(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.port && url.port !== '18080' && url.pathname === '/' && !url.username && !url.password
    && !url.search && !url.hash, 'Use the isolated synthetic loopback fixture.');
  return url;
}

let base = loopback(source);
const restored = target && loopback(target);
assert.ok(!restored || restored.port !== base.port);

async function request(path, status, { actor, method = 'GET', body, key, platform = false } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) headers.Authorization = 'Bearer ' + actor.token;
  if (actor?.workspace) headers['X-Workspace-Id'] = actor.workspace;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(new URL((platform ? '' : '/api/assistant/v1') + path, base), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
    signal: AbortSignal.timeout(12_000),
  });
  const data = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  const accepted = Array.isArray(status) ? status : [status];
  assert.ok(accepted.includes(response.status),
    method + ' ' + path + ' → ' + response.status + ' ' + (data?.code ?? ''));
  if (path.startsWith(prefix) || (platform && response.ok && path.includes('/catalog/'))) {
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  }
  return data;
}

async function register() {
  const credentials = { username: 'qa-catalog-' + randomUUID().slice(0, 10), password: 'Qa.Catalog!' + randomUUID() };
  const { user, accessToken } = await request('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { token: accessToken, workspace: user.workspaceId, id: user.id, credentials };
  sessions.push(actor);
  return actor;
}

function create(actor, body) {
  return request('/custom-assistants', 201, { actor, method: 'POST', key: randomUUID(), body });
}

function revise(actor, assistant, name, instructions) {
  return request('/custom-assistants/' + assistant.id + '/versions', 201, {
    actor, method: 'POST', body: { baseVersionId: assistant.head.id, name, instructions },
  });
}

function preview(actor, body, expected = 200) {
  return request(prefix + '/author/preview', expected, { actor, method: 'POST', body });
}

function submit(actor, source, offer, key = randomUUID(), expected = 201, confirm = true) {
  return request(prefix + '/author/releases', expected, {
    actor, method: 'POST', key, body: { ...source, contentDigest: offer.contentDigest, confirm },
  });
}

function item(actor, entryId, status = 200) {
  return request(prefix + '/items/' + entryId, status, { actor });
}

function authorWithdraw(actor, release, expected = 200) {
  return request(prefix + '/author/releases/' + release.id + '/withdraw', expected, {
    actor, method: 'POST', body: { confirm: true },
  });
}

const admin = '/system/assistant/catalog/workspaces/' + pilotWorkspace + '/releases';

function dossier(release, expected = 200, actor = operator, path = admin) {
  return request(path + '/' + release.id, expected, { actor, platform: true });
}

function decide(release, decision, expected = 200) {
  return request(admin + '/' + release.id + '/decision', expected, {
    actor: operator, platform: true, method: 'POST', body: { decision, confirm: true },
  });
}

async function mark(name, object = {}) {
  const destination = join(evidence, name);
  await writeFile(destination + '.tmp', JSON.stringify(object), { flag: 'wx' });
  await rename(destination + '.tmp', destination);
}

async function wait(name) {
  const deadline = Date.now() + 300_000;
  do {
    try {
      await access(join(evidence, name));
      return;
    } catch (failure) {
      if (failure.code !== 'ENOENT') throw failure;
    }
    await delay(150);
  } while (Date.now() < deadline);
  assert.fail('Missing QA fixture marker ' + name);
}

async function erase(actor) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(new URL('/api/assistant/v1/privacy/account-erasure', base), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { Authorization: 'Bearer ' + actor.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: actor.credentials.password, confirmation: 'DELETE' }),
    });
    if (response.status === 204 || response.status === 401) return;
    assert.equal(response.status, 429, 'Synthetic account cleanup failed.');
    const retry = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
    if (attempt < 2) await delay(Number.isFinite(retry) ? Math.min(60, Math.max(1, retry)) * 1000 : 60_000);
  }
  assert.fail('Synthetic account cleanup remained throttled.');
}

function report(actor, release, reason, expected = 201) {
  return request(prefix + '/items/' + release.entryId + '/reports', expected, {
    actor, method: 'POST', body: { releaseId: release.id, reason },
  });
}

async function catalogueExport(actor) {
  const document = await request('/privacy/export', 200, { actor });
  assert.equal(document.schemaVersion, 1);
  assert.ok(Array.isArray(document.catalogAuthoredReleases));
  assert.ok(Array.isArray(document.catalogReports));
  for (const row of document.catalogAuthoredReleases) {
    assert.deepEqual(Object.keys(row).sort(),
      ['id', 'entryId', 'kind', 'state', 'versionNumber', 'title', 'summary', 'submittedAt',
        ...(row.decidedAt ? ['decidedAt'] : [])].sort());
  }
  for (const row of document.catalogReports) {
    assert.deepEqual(Object.keys(row).sort(), ['id', 'releaseId', 'reason', 'createdAt'].sort());
  }
  return document;
}

function checkProjection(actual, expectedKind, containsInstructions) {
  const required = ['id','kind','publishedAt','releaseId','summary','title','versionNumber'];
  if (expectedKind === 'assistant' && containsInstructions) required.push('instructions');
  if (expectedKind === 'connector') required.push('connectorId');
  assert.deepEqual(Object.keys(actual).sort(), required.sort());
  assert.equal(actual.kind, expectedKind);
}

try {
  await request(prefix + '/items', 401);
  const login = await register();
  const visitor = await register();
  const provision = await request('/system/assistant/organizations', 201, {
    actor: operator, platform: true, method: 'POST', key: provisionKey,
    body: { ownerAccountId: login.id, name: 'Catalogue review QA scope', seatLimit: 3, confirm: true },
  });
  assert.equal(provision.workspaceId, pilotWorkspace);
  const owner = { ...login, workspace: pilotWorkspace };
  if (evidence) {
    await mark('review-grant-needed', { workspaceId: pilotWorkspace });
    await wait('review-grant-done');
  }

  for (const [actor, entitled] of [[owner, true], [visitor, false]]) {
    const { capabilities } = await request('/capabilities', 200, { actor });
    assert.equal(capabilities.find(({ id }) => id === 'reviewed_catalog')?.available, true);
    assert.equal(capabilities.find(({ id }) => id === 'reviewed_catalog_connector_submission')?.available, entitled);
  }

  const originalText = '经过作者确认的公开说明。\nUse literal markup <span>only in examples</span>.';
  const firstDefinition = await create(owner, { name: '审阅目录实际样例', instructions: originalText });
  const sourceVersion = (head, summary = '仅为本地目录复核建立的公开说明') => ({
    kind: 'assistant', assistantId: firstDefinition.id, versionId: head.id, summary,
  });
  const firstInput = sourceVersion(firstDefinition.head);
  const selected = await preview(owner, firstInput);
  assert.equal(selected.instructions, originalText);
  assert.match(selected.contentDigest, /^[a-f0-9]{64}$/);
  await preview(visitor, firstInput, 404);
  await submit(owner, firstInput, selected, randomUUID(), 400, false);
  const forged = { contentDigest: 'f'.repeat(64) };
  assert.equal((await submit(owner, firstInput, forged, randomUUID(), 409)).code, 'CATALOG_RELEASE_CHANGED');

  const firstKey = randomUUID();
  const release = await submit(owner, firstInput, selected, firstKey);
  assert.equal(release.state, 'pending');
  assert.deepEqual(await submit(owner, firstInput, selected, firstKey), release);
  await item(visitor, release.entryId, 404);
  await dossier(release, [401, 403], visitor);
  await dossier(release, 403, operator, '/system/assistant/catalog/workspaces/' + visitor.workspace + '/releases');
  const review = await dossier(release);
  assert.deepEqual(review.preview, selected);
  assert.deepEqual(review.audit.map(({ action }) => action), ['submitted']);
  assert.equal((await decide(release, 'approve')).state, 'published');
  const approved = await item(visitor, release.entryId);
  checkProjection(approved, 'assistant', true);
  assert.equal(approved.instructions, originalText);
  const reportReceipt = await report(visitor, release, 'misleading');
  assert.deepEqual(await report(visitor, release, 'misleading', 200), reportReceipt);
  await report(visitor, release, 'spam', 409);
  assert.deepEqual((await dossier(release)).reports, [reportReceipt]);
  if (portability) {
    const privateReport = await report(owner, release, 'spam');
    const authorExport = await catalogueExport(owner);
    assert.equal(authorExport.catalogAuthoredReleases.length, 1);
    assert.equal(authorExport.catalogAuthoredReleases[0].id, release.id);
    assert.equal(authorExport.catalogAuthoredReleases[0].state, 'published');
    assert.deepEqual(authorExport.catalogReports, []);
    const personalAuthorExport = await catalogueExport(login);
    assert.deepEqual(personalAuthorExport.catalogAuthoredReleases, []);
    assert.deepEqual(personalAuthorExport.catalogReports, [privateReport]);
    const viewerExport = await catalogueExport(visitor);
    assert.deepEqual(viewerExport.catalogAuthoredReleases, []);
    assert.deepEqual(viewerExport.catalogReports, [reportReceipt]);
  }

  const v2 = await revise(owner, firstDefinition, '已确认更新版本', 'Candidate 2 revised instruction.');
  const v3 = await revise(owner, v2, '候选版本的说明', 'Candidate 3 revised instruction.');
  const v2Input = sourceVersion(v2.head);
  const v3Input = sourceVersion(v3.head);
  const next = await submit(owner, v2Input, await preview(owner, v2Input));
  const stale = await submit(owner, v3Input, await preview(owner, v3Input));
  assert.equal((await item(visitor, release.entryId)).instructions, originalText);
  assert.equal((await decide(next, 'approve')).state, 'published');
  assert.equal((await item(visitor, release.entryId)).instructions, v2.head.instructions);
  assert.equal((await decide(stale, 'approve', 409)).code, 'CATALOG_RELEASE_CHANGED');
  assert.equal((await decide(stale, 'reject')).state, 'rejected');
  await report(visitor, release, 'spam', 404);
  const rollbackKey = randomUUID();
  const reverted = await submit(owner, firstInput, selected, rollbackKey);
  assert.equal(reverted.state, 'pending');
  assert.equal(reverted.entryId, release.entryId);
  assert.equal((await decide(reverted, 'approve')).state, 'published');
  assert.equal((await item(visitor, release.entryId)).instructions, originalText);

  const connector = { kind: 'connector' };
  await preview(visitor, connector, 403);
  const fixed = await preview(owner, connector);
  assert.equal(fixed.connectorId, 'fixture_notice');
  assert.equal(fixed.instructions, undefined);
  const pluginKey = randomUUID();
  const plugin = await submit(owner, connector, fixed, pluginKey);
  await item(visitor, plugin.entryId, 404);
  assert.equal((await decide(plugin, 'approve')).state, 'published');
  const approvedPlugin = await item(visitor, plugin.entryId);
  checkProjection(approvedPlugin, 'connector', false);
  assert.equal(approvedPlugin.connectorId, 'fixture_notice');
  const plugins = await request(prefix + '/items?kind=connector&limit=1', 200, { actor: visitor });
  assert.deepEqual(plugins.items.map(({ id }) => id), [plugin.entryId]);
  const list = await request(prefix + '/items?kind=assistant&limit=32', 200, { actor: visitor });
  const found = list.items.find(({ id }) => id === release.entryId);
  assert.ok(found);
  checkProjection(found, 'assistant', false);

  const unrelated = await create(owner, { name: '随后由作者删除的预览', instructions: 'Synthetic provenance.' });
  const erasedInput = { ...sourceVersion(unrelated.head), assistantId: unrelated.id };
  const temporary = await submit(owner, erasedInput, await preview(owner, erasedInput));
  await decide(temporary, 'approve');
  await item(visitor, temporary.entryId);
  const removedReport = portability ? await report(visitor, temporary, 'other') : null;

  const project = await request('/projects', 201, {
    actor: owner, method: 'POST', body: { name: 'Protected catalogue material fixture' },
  });
  const material = await request('/projects/' + project.id + '/resources', 201, {
    actor: owner, method: 'POST', body: { name: 'Owned test material', content: 'Private fixture data' },
  });
  const privateDraft = await create(owner, {
    name: 'Material stays private', instructions: 'Only my own material', projectId: project.id,
    resourceIds: [material.id], tools: ['project_resource_lookup'],
  });
  await preview(owner, { ...sourceVersion(privateDraft.head), assistantId: privateDraft.id }, 400);

  const enrol = () => request('/organizations/current/members', 201, {
    actor: owner, method: 'POST', body: { accountId: visitor.id, role: 'member', confirm: true },
  });
  const enrollment = await enrol();
  const memberAuthor = { ...visitor, workspace: pilotWorkspace };
  const memberSource = await create(memberAuthor, { name: 'Membership-scoped release', instructions: 'Member sample' });
  const memberInput = { ...sourceVersion(memberSource.head), assistantId: memberSource.id };
  const memberRelease = await submit(memberAuthor, memberInput, await preview(memberAuthor, memberInput));
  await decide(memberRelease, 'approve');
  assert.equal((await item(visitor, memberRelease.entryId)).instructions, 'Member sample');

  if (restored) {
    await mark('backup-ready', { workspaceId: pilotWorkspace, releaseId: plugin.id });
    await wait('backup-done');
  }
  await request('/custom-assistants/' + unrelated.id, 204, { actor: owner, method: 'DELETE' });
  await item(visitor, temporary.entryId, 404);
  await dossier(temporary, 404);
  if (portability) {
    assert.ok(!(await catalogueExport(owner)).catalogAuthoredReleases.some(({ id }) => id === temporary.id));
    assert.ok(!(await catalogueExport(visitor)).catalogReports.some(({ id }) => id === removedReport.id));
  }
  const leave = '/auth/workspaces/' + pilotWorkspace + '/leave';
  await request(leave, 204, { actor: memberAuthor, method: 'POST',
    body: { membershipRevision: enrollment.membershipRevision, confirm: true } });
  await item(visitor, memberRelease.entryId, 404);
  await dossier(memberRelease, 404);
  await authorWithdraw(visitor, reverted, 404);
  assert.equal((await authorWithdraw(owner, reverted)).state, 'withdrawn');
  assert.equal((await decide(plugin, 'withdraw')).state, 'withdrawn');
  await item(visitor, reverted.entryId, 404);
  await item(visitor, plugin.entryId, 404);
  if (portability) {
    const disabledAuthor = await catalogueExport(owner);
    for (const id of [reverted.id, plugin.id]) {
      assert.equal(disabledAuthor.catalogAuthoredReleases.find((value) => value.id === id)?.state, 'withdrawn');
    }
    assert.deepEqual((await catalogueExport(visitor)).catalogReports, [reportReceipt]);
  }
  if (restored) {
    await mark('cutover-ready');
    await wait('restore-done');
    base = restored;
    await item(visitor, reverted.entryId, 404);
    await item(visitor, plugin.entryId, 404);
    await item(visitor, temporary.entryId, 404);
    await dossier(temporary, 404);
    await item(visitor, memberRelease.entryId, 404);
    await dossier(memberRelease, 404);
    assert.notEqual((await enrol()).membershipRevision, enrollment.membershipRevision);
    await item(visitor, memberRelease.entryId, 404);
    const history = await request(prefix + '/author/releases?limit=10', 200, { actor: owner });
    for (const id of [reverted.id, plugin.id]) {
      assert.equal(history.items.find((value) => value.id === id)?.state, 'withdrawn');
    }
    await submit(owner, firstInput, selected, rollbackKey, 409);
    await submit(owner, connector, fixed, pluginKey, 409);
    const resubmitted = await submit(owner, firstInput, selected);
    assert.equal(resubmitted.entryId, reverted.entryId);
    assert.equal((await decide(resubmitted, 'approve')).state, 'published');
    assert.equal((await item(visitor, reverted.entryId)).instructions, originalText);
    if (featureSwitch) {
      await mark('disable-ready');
      await wait('disable-done');
      const disabled = await request(prefix + '/items', 403, { actor: visitor });
      assert.equal(disabled.code, 'CAPABILITY_UNAVAILABLE');
      await preview(owner, firstInput, 403);
      const status = await request(prefix + '/author/releases?limit=10', 200, { actor: owner });
      assert.equal(status.items.find(({ id }) => id === resubmitted.id)?.state, 'published');
      assert.equal((await decide(resubmitted, 'withdraw')).state, 'withdrawn');
    }
  }
  result = {
    result: 'scoped_reviewed_catalogue_verified', authenticOperator: true, explicitExactSource: true,
    separateReviewAndViewerScopes: true, approvedAssistantAndFixedConnector: true,
    staleReleaseApprovalBlocked: true, reportDedupe: true, reviewedRollback: true,
    protectedMaterialDenied: true, sourceDeletionAndEmergencyWithdraw: true,
    membershipGenerationRetired: true, restore: Boolean(restored), featureOffAndWithdrawal: featureSwitch,
    scopedCataloguePortability: portability,
  };
} finally {
  const cleanup = await Promise.allSettled(sessions.map(erase));
  for (const entry of cleanup) {
    if (entry.status === 'rejected') {
      console.error(entry.reason.message);
      process.exitCode = 1;
    }
  }
}
if (!process.exitCode) console.log(JSON.stringify(result));
