import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18090');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) {
  throw new Error('Use an isolated loopback service with synthetic accounts.');
}
const prefix = '/api/assistant/v1';
const maxPageRows = 64;
const maxPageBytes = 8 * 1024 * 1024;
const privateData = process.argv.includes('--private-data');
const authoredData = process.argv.includes('--m3-data');
const publicationData = process.argv.includes('--artifact-publication');
const artifactData = publicationData || process.argv.includes('--artifact-data');
const projectData = privateData || authoredData || artifactData || process.argv.includes('--project-data');
if (privateData || authoredData || artifactData) {
  assert.ok(origin.port && !['18080', '18090'].includes(origin.port), 'Use an isolated private-data fixture.');
}
const owned = [];
const sessions = [];

async function request(path, status, { method = 'GET', token, workspace, body, key, png } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (workspace) headers['X-Workspace-Id'] = workspace;
  if (body) headers['Content-Type'] = 'application/json';
  if (png) headers['Content-Type'] = 'image/png';
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(new URL(prefix + path, origin), {
    method,
    headers,
    body: png ?? (body ? JSON.stringify(body) : undefined),
    redirect: 'error',
    signal: AbortSignal.timeout(22_000),
  });
  assert.equal(response.status, status, `${method} ${path}`);
  const bytes = response.status === 204 ? undefined : await response.arrayBuffer();
  return { headers: response.headers, bytes, body: bytes && JSON.parse(new TextDecoder().decode(bytes)) };
}

async function register() {
  const credentials = { username: `qa-exp-${randomUUID().slice(0, 14)}`, password: `Qa-Export!${randomUUID()}` };
  const { body } = await request('/auth/register', 201, { method: 'POST', body: credentials });
  const account = { token: body.accessToken, workspace: body.user.workspaceId, user: body.user, credentials };
  sessions.push(account);
  return account;
}

async function conversation(account, title) {
  const { body } = await request('/conversations', 201, { ...account, method: 'POST', body: { title } });
  owned.push([account, body.id]);
  return body.id;
}

async function addProject(account, name) {
  const { body } = await request('/projects', 201, { ...account, method: 'POST', body: { name } });
  return body;
}

async function addMaterial(account, root, name, content) {
  const { body: resource } = await request(root, 201, { ...account, method: 'POST', body: { name, content } });
  return resource;
}

async function analyze(account, root, resource) {
  const { body } = await request(`${root}/${resource.id}/analysis`, 201, {
    ...account, method: 'POST', body: { valueColumn: 'Value' },
  });
  return body;
}

async function prepareProjectData(owner, outsider) {
  const project = await addProject(owner, '合成导出项目');
  const ownerRoot = `/projects/${project.id}/resources`;
  const resource = await addMaterial(owner, ownerRoot, '中文资料 🦀', 'Note,Value\r\n合成一,1.20\r\n合成二,-0.2\r\n');
  const report = await analyze(owner, ownerRoot, resource);
  const discard = await addMaterial(owner, ownerRoot, 'Revoked source', 'Value\n7\n');
  const discardedReport = await analyze(owner, ownerRoot, discard);
  await request(`${ownerRoot}/${discard.id}`, 204, { ...owner, method: 'DELETE' });
  for (let index = 1; index < 58; index++) {
    await addMaterial(owner, ownerRoot, `Synthetic material ${index}`, `Fixture ${index}`);
  }
  const outside = await addProject(outsider, 'Synthetic foreign project');
  const foreignRoot = `/projects/${outside.id}/resources`;
  const foreign = await addMaterial(outsider, foreignRoot, 'Foreign source', 'Value\n99\n');
  const foreignReport = await analyze(outsider, foreignRoot, foreign);
  return { project, outside, resource, report, discard, discardedReport, foreign, foreignReport };
}

async function addMemory(actor, root, content) {
  const { body } = await request(`${root}/entries`, 201, {
    ...actor, method: 'POST', body: { content },
  });
  return body;
}

async function addPng(actor, root, png, expected) {
  const { body: uploaded } = await request(root, 202, {
    ...actor, method: 'POST', key: randomUUID(), png,
  });
  const route = `${root}/${uploaded.id}`;
  const deadline = Date.now() + 30_000;
  do {
    const { body } = await request(route, 200, actor);
    if (body.state === expected) return body;
    assert.equal(body.state, 'quarantined', body.errorCode);
    await delay(200);
  } while (Date.now() < deadline);
  assert.fail(`PNG fixture did not reach ${expected}.`);
}

async function preparePrivateData(owner, outsider, materials) {
  const instructions = 'Synthetic instruction erased before export';
  const scope = `/projects/${materials.project.id}`;
  const personal = '/memory';
  const project = `${scope}/memory`;
  await request(`${personal}/settings`, 200, {
    ...owner, method: 'PATCH', body: { enabled: true, referenceHistory: true, instructions },
  });
  const retained = await addMemory(owner, personal, '本人停用后仍保留的手写记忆 🦀');
  const deleted = await addMemory(owner, personal, 'Synthetic retired personal entry');
  const replaced = await addMemory(owner, personal, 'Synthetic source of replaced entry');
  const { body: replacement } = await request(`${personal}/entries/${replaced.id}`, 200, {
    ...owner, method: 'PATCH', body: { content: 'Synthetic active replacement' },
  });
  await request(`${personal}/entries/${deleted.id}`, 204, { ...owner, method: 'DELETE' });
  await request(`${personal}/settings`, 200, {
    ...owner, method: 'PATCH', body: { enabled: false, referenceHistory: false, instructions: '' },
  });
  assert.deepEqual((await request(`${personal}/entries`, 200, owner)).body.items, []);
  await request(`${project}/settings`, 200, { ...owner, method: 'PATCH', body: { enabled: true } });
  const projectEntry = await addMemory(owner, project, 'Owned project-only manual memory');
  await request(`${personal}/settings`, 200, {
    ...outsider, method: 'PATCH', body: { enabled: true, instructions: 'Foreign instruction' },
  });
  const foreignEntry = await addMemory(outsider, personal, 'Foreign manual entry');

  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPgCsj8DwAC7gHDSedwyAAAAABJRU5ErkJggg==', 'base64');
  const corrupt = Buffer.from(image);
  corrupt[corrupt.length - 1] ^= 1;
  const attachments = `${scope}/attachments`;
  const approved = await addPng(owner, attachments, image, 'approved');
  const rejected = await addPng(owner, attachments, corrupt, 'rejected');
  const revoked = await addPng(owner, attachments, image, 'approved');
  await request(`${attachments}/${revoked.id}`, 204, { ...owner, method: 'DELETE' });
  const foreignAttachment = await addPng(outsider, `/projects/${materials.outside.id}/attachments`,
    image, 'approved');
  return { instructions, retained, deleted, replaced, replacement, projectEntry, foreignEntry,
    approved, rejected, revoked, foreignAttachment };
}

async function prepareAuthoredData(owner, outsider, materials) {
  const registry = '/custom-assistants';
  const schedules = '/automations/reminders';
  const notifications = '/automations/reminder-occurrences';
  const create = async (actor, route, body) => (await request(route, 201, {
    ...actor, method: 'POST', key: randomUUID(), body,
  })).body;
  const sourceRoute = `/projects/${materials.project.id}/resources`;
  const retiredSource = await addMaterial(owner, sourceRoute, 'Retired assistant knowledge', 'Removed after authoring');
  const original = await create(owner, registry, {
    projectId: materials.project.id, name: '自定义导出 🦀', instructions: '合成初版指令',
    resourceIds: [materials.resource.id, retiredSource.id], tools: ['project_resource_lookup'],
  });
  const { body: revised } = await request(`${registry}/${original.id}/versions`, 201, {
    ...owner, method: 'POST', body: { baseVersionId: original.head.id, name: '合成新版',
      instructions: '合成新版指令', resourceIds: [materials.resource.id] },
  });
  const { body: rolledBack } = await request(`${registry}/${original.id}/rollback`, 201, {
    ...owner, method: 'POST', body: { baseVersionId: revised.head.id, versionId: original.head.id },
  });
  await request(`${sourceRoute}/${retiredSource.id}`, 204, { ...owner, method: 'DELETE' });
  const discard = await create(owner, registry, { name: 'Synthetic deleted assistant', instructions: 'Exclude definition' });
  await request(`${registry}/${discard.id}`, 204, { ...owner, method: 'DELETE' });
  const foreign = await create(outsider, registry, { name: 'Foreign assistant', instructions: 'Foreign instructions' });

  const date = (epoch) => new Date(epoch).toISOString().slice(0, 16);
  const schedule = { title: '合成一周提醒', startsAtLocal: date(Date.now() + 86_400_000), timeZone: 'UTC',
    cadence: 'weekly', quietHours: { start: '23:00', end: '07:00' } };
  const weekly = await create(owner, schedules, schedule);
  const { body: paused } = await request(`${schedules}/${weekly.id}`, 200, {
    ...owner, method: 'PATCH', body: { active: false },
  });
  const cancelled = await create(owner, schedules, { ...schedule, title: 'Cancelled schedule' });
  await request(`${schedules}/${cancelled.id}`, 204, { ...owner, method: 'DELETE' });
  const foreignReminder = await create(outsider, schedules, { ...schedule, title: 'Foreign reminder' });
  const nextMinute = Math.ceil((Date.now() + 3000) / 60_000) * 60_000;
  const once = await create(owner, schedules, { title: '合成一次提醒', startsAtLocal: date(nextMinute),
    timeZone: 'UTC', cadence: 'once' });
  const deadline = nextMinute + 15_000;
  while (Date.now() < deadline) {
    const { body: page } = await request(`${notifications}?reminderId=${once.id}`, 200, owner);
    if (page.items.length) {
      const { body: read } = await request(`${notifications}/${page.items[0].id}`, 200, {
        ...owner, method: 'PATCH', body: { read: true },
      });
      const { body: completed } = await request(`${schedules}/${once.id}`, 200, owner);
      assert.equal(completed.state, 'completed');
      assert.equal(read.outcome, 'delivered');
      assert.ok(Number.isFinite(Date.parse(read.readAt)));
      return { original, revised, rolledBack, discard, foreign, retiredSource, paused, cancelled, foreignReminder,
        completed, read };
    }
    await delay(350);
  }
  assert.fail('Local worker did not persist the notification before export.');
}

function assertAuthoredExport(aggregate, outside, authored, materials) {
  const { original, revised, rolledBack, discard, foreign, retiredSource, paused, cancelled, foreignReminder,
    completed, read } = authored;
  const { head, ...summary } = rolledBack;
  assert.deepEqual(aggregate.customAssistants, [{ ...summary, name: head.name,
    headVersionId: head.id, headVersionNumber: head.number }]);
  const expectedVersions = [original, revised, rolledBack].map(({ head }) => ({
    ...head, resourceIds: head.resourceIds.filter((id) => id !== retiredSource.id),
  }));
  assert.deepEqual(aggregate.customAssistantVersions.sort((a, b) => a.number - b.number), expectedVersions);
  assert.ok(aggregate.customAssistantVersions.every(({ resourceIds }) =>
    resourceIds.length === 1 && resourceIds[0] === materials.resource.id));
  assert.deepEqual(new Set(aggregate.reminders.map(({ id }) => id)), new Set([paused.id, completed.id]));
  assert.deepEqual(aggregate.reminders.find(({ id }) => id === paused.id), paused);
  assert.deepEqual(aggregate.reminders.find(({ id }) => id === completed.id), completed);
  assert.deepEqual(aggregate.reminderOccurrences, [read]);
  assert.deepEqual(outside.customAssistants.map(({ id }) => id), [foreign.id]);
  assert.deepEqual(outside.customAssistantVersions, [foreign.head]);
  assert.deepEqual(outside.reminders.map(({ id }) => id), [foreignReminder.id]);
  assert.deepEqual(outside.reminderOccurrences, []);
  const serialized = JSON.stringify(aggregate);
  for (const { id } of [discard, foreign, retiredSource, cancelled, foreignReminder]) assert.ok(!serialized.includes(id));
  assert.ok(!/reminderLinks|cutoff|headEpoch|configEpoch|nextWakeAt|nextSlotDay|nextScheduledAt|nextDeliveryAt/i
    .test(serialized));
}

async function complete(account, id, content) {
  const { body: queued } = await request(`/conversations/${id}/runs`, 202, {
    ...account, method: 'POST', body: { action: 'send', modelId: 'local-echo', content }, key: randomUUID(),
  });
  const deadline = Date.now() + 20_000;
  do {
    const { body } = await request(`/runs/${queued.runId}`, 200, account);
    if (body.state === 'completed') return body;
    assert.ok(['queued', 'running'].includes(body.state), 'fixture model did not complete');
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail('fixture generation timed out');
}

async function prepareArtifacts(owner, outsider, materials, saved) {
  const routes = '/artifacts';
  const create = async (actor, body) => (await request(routes, 201, {
    ...actor, method: 'POST', body, key: randomUUID(),
  })).body;
  const revise = async (artifact, content) => (await request(`${routes}/${artifact.id}/versions`, 201, {
    ...owner, method: 'POST', body: { baseVersionId: artifact.head.id, title: artifact.title, content },
  })).body;
  const exact = '合成的文稿 🦀\r\n\t保留尾部空格 \r\n';
  const initial = await create(owner, { projectId: materials.project.id, title: 'Data rights draft',
    format: 'markdown', content: exact });
  const changed = await revise(initial, 'Synthetic intermediate text');
  const { body: rolledBack } = await request(`${routes}/${initial.id}/rollback`, 201, {
    ...owner, method: 'POST', body: { baseVersionId: changed.head.id, versionId: initial.head.id },
  });
  let publication;
  if (publicationData) {
    const path = `/collaboration/projects/${materials.project.id}/artifact-publications`;
    ({ body: publication } = await request(path, 201, { ...owner, method: 'POST',
      body: { artifactId: rolledBack.id, versionId: rolledBack.head.id, confirm: true } }));
    assert.equal(publication.versionNumber, 3);
    assert.ok(publication.id && publication.id !== rolledBack.id && publication.id !== rolledBack.head.id);
  }
  const derived = await create(owner, { sourceMessageId: saved.messageId, title: '保留回复引用', format: 'text' });
  const foreign = await create(outsider, { projectId: materials.outside.id, title: 'Foreign private draft',
    format: 'text', content: 'Foreign version body' });
  const discarded = await create(owner, { projectId: materials.project.id, title: 'Revoked private draft',
    format: 'text', content: 'Revoked version body' });
  await request(`${routes}/${discarded.id}`, 204, { ...owner, method: 'DELETE' });
  const doomedConversation = await conversation(owner, 'Synthetic artifact source to erase');
  const doomedReply = await complete(owner, doomedConversation, 'Synthetic reply to erase before export');
  const doomed = await create(owner, { sourceMessageId: doomedReply.messageId, title: 'Withdrawn source draft',
    format: 'text' });
  await request(`/conversations/${doomedConversation}`, 204, { ...owner, method: 'DELETE' });
  const summaries = [rolledBack, derived];
  const versions = [initial.head, changed.head, rolledBack.head, derived.head];
  for (let index = 0; index < 2; index++) {
    let current = await create(owner, { projectId: materials.project.id, title: `Version paging ${index}`,
      format: 'text', content: '' });
    versions.push(current.head);
    for (let revision = 2; revision <= 28; revision++) {
      current = await revise(current, 'Synthetic version ' + revision);
      versions.push(current.head);
    }
    summaries.push(current);
  }
  return { summaries, versions, initial, exact, foreign, discarded, doomed, publication };
}

function assertArtifactExport(aggregate, outside, drafts) {
  const { summaries, versions, initial, exact, foreign, discarded, doomed } = drafts;
  assert.deepEqual(aggregate.privateArtifacts, summaries.map(({ head, ...summary }) => summary)
    .sort((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual(aggregate.privateArtifactVersions, versions.slice().sort((a, b) => a.id.localeCompare(b.id)));
  const original = aggregate.privateArtifactVersions.find(({ id }) => id === initial.head.id);
  assert.deepEqual(Buffer.from(original.content), Buffer.from(exact));
  const { head: foreignVersion, ...foreignSummary } = foreign;
  assert.deepEqual(outside.privateArtifacts, [foreignSummary]);
  assert.deepEqual(outside.privateArtifactVersions, [foreignVersion]);
  const serialized = JSON.stringify([aggregate.privateArtifacts, aggregate.privateArtifactVersions]);
  for (const row of [foreign, discarded, doomed]) {
    assert.ok(!serialized.includes(row.id));
    assert.ok(!serialized.includes(row.head.id));
  }
  assert.ok(!/sourceConversationId|privateArtifactProjection|publication|requestDigest|collaborationId/i.test(serialized));
}

function exportPath(cursor) {
  return '/privacy/export' + (cursor === undefined ? '' : '?cursor=' + encodeURIComponent(cursor));
}

async function exportPage(account, cursor) {
  const { headers, body, bytes } = await request(exportPath(cursor), 200, account);
  assert.match(headers.get('cache-control') ?? '', /no-store/);
  assert.match(headers.get('content-disposition') ?? '', /attachment;.*assistant-data\.json/);
  assert.match(headers.get('content-type') ?? '', /^application\/json/i);
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(Number(headers.get('content-length')), bytes.byteLength);
  assert.ok(bytes.byteLength <= maxPageBytes);
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.workspaceId, account.workspace);
  assert.equal(body.account.id, account.user.id);
  assert.ok(Number.isFinite(Date.parse(body.exportedAt)));
  const sections = ['conversations', 'messages', 'runs'];
  if (projectData) sections.push('projectResources', 'analyses');
  if (privateData) sections.push('memorySettings', 'memoryEntries', 'attachments');
  if (authoredData) sections.push('customAssistants', 'customAssistantVersions', 'reminders', 'reminderOccurrences');
  if (artifactData) sections.push('privateArtifacts', 'privateArtifactVersions');
  for (const section of sections) assert.ok(Array.isArray(body[section]), `Missing export section ${section}`);
  assert.ok(sections.reduce((length, section) => length + body[section].length, body.projects?.length ?? 0)
    <= maxPageRows);
  return body;
}

let owner;
try {
  owner = await register();
  const outsider = await register();
  const foreign = await conversation(outsider, 'Synthetic workspace outside the export');
  const discard = await conversation(owner, 'Synthetic deleted content');
  const discardedRun = await complete(owner, discard, '合成删掉的消息与运行');
  const kept = await conversation(owner, '保留的合成会话');
  const saved = await complete(owner, kept, '中文与 emoji 🦀');
  for (let index = 0; index < maxPageRows + 2; index++) {
    await conversation(owner, `Synthetic pagination ${index}`);
  }
  await request(`/conversations/${discard}`, 204, { ...owner, method: 'DELETE' });
  const discardIndex = owned.findIndex(([, id]) => id === discard);
  owned.splice(discardIndex, 1);
  const materials = projectData ? await prepareProjectData(owner, outsider) : undefined;
  const data = privateData ? await preparePrivateData(owner, outsider, materials) : undefined;
  const authored = authoredData ? await prepareAuthoredData(owner, outsider, materials) : undefined;
  const drafts = artifactData ? await prepareArtifacts(owner, outsider, materials, saved) : undefined;

  await request(exportPath(), 401);
  await request(exportPath(), 403, { ...owner, workspace: outsider.workspace });
  await request(exportPath('!invalid'), 400, owner);

  const first = await exportPage(owner);
  assert.ok(first.nextCursor);
  await request(exportPath(first.nextCursor), 400, outsider);
  const aggregate = { conversations: [], messages: [], runs: [] };
  if (materials) Object.assign(aggregate, { projects: [], projectResources: [], analyses: [] });
  if (data) Object.assign(aggregate, { memorySettings: [], memoryEntries: [], attachments: [] });
  if (authored) Object.assign(aggregate, { customAssistants: [], customAssistantVersions: [], reminders: [], reminderOccurrences: [] });
  if (drafts) Object.assign(aggregate, { privateArtifacts: [], privateArtifactVersions: [] });
  const cursors = new Set();
  let artifactContinuation = false;
  let page = first;
  for (let pageNumber = 0; ; pageNumber++) {
    assert.ok(pageNumber < 5, 'fixture did not reach a final page');
    if (drafts?.publication) assert.ok(!JSON.stringify(page).includes(drafts.publication.id));
    for (const key of Object.keys(aggregate)) aggregate[key].push(...page[key]);
    if (page.nextCursor === null) break;
    assert.equal(typeof page.nextCursor, 'string');
    if (drafts && page.privateArtifactVersions.length > 0) artifactContinuation = true;
    assert.ok(!cursors.has(page.nextCursor));
    cursors.add(page.nextCursor);
    page = await exportPage(owner, page.nextCursor);
  }

  assert.equal(aggregate.conversations.length, maxPageRows + 3);
  assert.equal(aggregate.messages.length, 2);
  assert.equal(aggregate.runs.length, 1);
  for (const [section, values] of Object.entries(aggregate)) {
    const keys = values.map(({ id, scope, projectId }) => section === 'memorySettings' ? scope + ':' + projectId : id);
    assert.equal(new Set(keys).size, values.length);
  }
  assert.ok(aggregate.conversations.some(({ id }) => id === kept));
  assert.ok(!aggregate.conversations.some(({ id }) => id === discard || id === foreign));
  assert.ok(aggregate.messages.every(({ conversationId }) => conversationId === kept));
  assert.match(aggregate.messages.find(({ role }) => role === 'user').content, /中文与 emoji 🦀/u);
  assert.equal(aggregate.runs[0].id, saved.runId);
  assert.notEqual(aggregate.runs[0].id, discardedRun.runId);
  assert.equal(aggregate.runs[0].responseMessageId, saved.messageId);
  assert.equal(aggregate.runs[0].modelId, 'local-echo');
  assert.ok(!/password|tokenDigest|idempotencyKey|leaseToken|requestDigest|evidenceDigest/i.test(JSON.stringify(aggregate)));
  assert.deepEqual(Object.keys(first.account).sort(), ['createdAt', 'id', 'preferences', 'username']);
  if (materials) {
    assert.ok(cursors.size >= 2, 'project materials must extend the shared export pagination');
    assert.deepEqual(aggregate.projects.map(({ id }) => id), [materials.project.id]);
    assert.equal(aggregate.projectResources.length, 58);
    assert.ok(aggregate.projectResources.every(({ projectId }) => projectId === materials.project.id));
    const exportedResource = aggregate.projectResources.find(({ id }) => id === materials.resource.id);
    assert.deepEqual(exportedResource, { ...materials.resource, projectId: materials.project.id });
    assert.ok(aggregate.projectResources.every(({ id }) => ![materials.discard.id, materials.foreign.id].includes(id)));
    assert.deepEqual(aggregate.analyses, [{ ...materials.report, artifactCsv: 'row,value\r\n1,1.2\r\n2,-0.2\r\n' }]);
    assert.ok(!JSON.stringify(aggregate.analyses).includes(materials.discardedReport.id));
    const outside = await exportPage(outsider);
    assert.deepEqual(outside.projectResources.map(({ id }) => id), [materials.foreign.id]);
    assert.deepEqual(outside.analyses.map(({ id }) => id), [materials.foreignReport.id]);
    if (authored) assertAuthoredExport(aggregate, outside, authored, materials);
    if (drafts) {
      assert.ok(artifactContinuation, 'private artifact version data must continue across a shared page boundary');
      if (drafts.publication) assert.ok(!JSON.stringify(outside).includes(drafts.publication.id));
      assertArtifactExport(aggregate, outside, drafts);
    }
    if (data) {
      assert.deepEqual(aggregate.memorySettings, [
        { scope: 'personal', enabled: false, referenceHistory: false, instructions: '' },
        { scope: 'project', projectId: materials.project.id, enabled: true },
      ]);
      assert.deepEqual(new Set(aggregate.memoryEntries.map(({ id }) => id)),
        new Set([data.retained.id, data.replacement.id, data.projectEntry.id]));
      assert.deepEqual(aggregate.memoryEntries.find(({ id }) => id === data.retained.id),
        { ...data.retained, scope: 'personal' });
      assert.deepEqual(aggregate.memoryEntries.find(({ id }) => id === data.projectEntry.id),
        { ...data.projectEntry, scope: 'project', projectId: materials.project.id });
      assert.ok(aggregate.memoryEntries.every(({ id }) =>
        ![data.deleted.id, data.replaced.id, data.foreignEntry.id].includes(id)));
      assert.deepEqual(aggregate.attachments, [{
        id: data.approved.id, projectId: materials.project.id, contentType: 'image/png',
        size: data.approved.size, width: data.approved.width, height: data.approved.height,
        createdAt: data.approved.createdAt,
      }]);
      assert.ok(aggregate.attachments.every(({ id }) =>
        ![data.rejected.id, data.revoked.id, data.foreignAttachment.id].includes(id)));
      assert.deepEqual(outside.memoryEntries.map(({ id }) => id), [data.foreignEntry.id]);
      assert.deepEqual(outside.attachments.map(({ id }) => id), [data.foreignAttachment.id]);
      assert.ok(!JSON.stringify(aggregate).includes(data.instructions));
      assert.ok(!/memoryEpoch|historyEpoch|instructionsEpoch|approvedDigest|storageKey|grantToken|artifactBytes/i
        .test(JSON.stringify(aggregate)));
    }
  }

  await request('/auth/logout', 204, { ...owner, method: 'POST' });
  await request(exportPath(first.nextCursor), 401, owner);
  const { body: restored } = await request('/auth/login', 200, { method: 'POST', body: owner.credentials });
  owner.token = restored.accessToken;
  if (authored || drafts) {
    for (const session of sessions) {
      await request('/privacy/account-erasure', 204, { ...session, method: 'POST',
        body: { currentPassword: session.credentials.password, confirmation: 'DELETE' },
      });
      await request(exportPath(), 401, session);
    }
  }
  console.log(JSON.stringify({ pages: cursors.size + 1, exportedConversations: aggregate.conversations.length,
    exportedRuns: aggregate.runs.length, exportedProjectResources: aggregate.projectResources?.length,
    exportedAnalyses: aggregate.analyses?.length, exportedMemorySettings: aggregate.memorySettings?.length,
    exportedRetainedMemoryEntries: aggregate.memoryEntries?.length,
    exportedApprovedAttachments: aggregate.attachments?.length,
    exportedCustomAssistants: aggregate.customAssistants?.length,
    exportedCustomVersions: aggregate.customAssistantVersions?.length,
    exportedReminders: aggregate.reminders?.length, exportedReminderOccurrences: aggregate.reminderOccurrences?.length,
    exportedPrivateArtifacts: aggregate.privateArtifacts?.length,
    exportedPrivateArtifactVersions: aggregate.privateArtifactVersions?.length,
    collaborationPublicationExcluded: drafts?.publication ? true : undefined,
    scopeAndRevocation: 'passed', deletedData: 'excluded' }));
} finally {
  for (const [account, id] of owned) {
    await request(`/conversations/${id}`, 204, { ...account, method: 'DELETE' }).catch(() => {});
  }
  for (const session of sessions) {
    if (projectData) {
      await request('/privacy/account-erasure', 204, { ...session, method: 'POST',
        body: { currentPassword: session.credentials.password, confirmation: 'DELETE' },
      }).catch(() => {});
    }
    await request('/auth/logout', 204, { ...session, method: 'POST' }).catch(() => {});
  }
}

