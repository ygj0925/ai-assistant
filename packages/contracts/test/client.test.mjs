import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { AssistantApiError, AssistantClient, decodeRunEvents, StreamProtocolError } from '../dist/index.js';

const origin = 'http://127.0.0.1:18080';
const session = {
  accessToken: 'synthetic-test-token',
  expiresAt: '2026-11-22T13:00:00Z',
  user: { id: 'user_one', username: 'account_one', workspaceId: 'workspace_one', preferences: { locale: 'zh-CN', theme: 'system' } },
};
const fixture = await readFile(new URL('../examples/run-events.sse', import.meta.url), 'utf8');

async function collect(source) {
  const values = [];
  for await (const value of source) values.push(value);
  return values;
}

async function* oneCharacterAtATime(text) {
  for (const character of text) yield character;
}

function asStream(text) {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

test('account requests use versioned paths and separate guest requests from scoped requests', async () => {
  const seen = [];
  const client = new AssistantClient({
    origin,
    fetch: async (url, init) => {
      seen.push({ url, init });
      if (url.endsWith('/auth/register')) return Response.json(session, { status: 201 });
      if (url.endsWith('/auth/logout')) return new Response(null, { status: 204 });
      return Response.json(session.user);
    },
  });

  await client.replaceSession(session);
  assert.equal(await client.register({ username: 'account_one', password: 'synthetic-password' }).then(x => x.user.id), session.user.id);
  assert.deepEqual(await client.updatePreferences({ theme: 'dark' }), session.user);
  await client.logout();
  await client.getAccount();

  const [register, preference, logout, guest] = seen;
  assert.equal(register.url, origin + '/api/assistant/v1/auth/register');
  assert.equal(register.init.headers.get('authorization'), null);
  assert.equal(register.init.headers.get('content-type'), 'application/json');
  assert.equal(preference.init.headers.get('authorization'), 'Bearer synthetic-test-token');
  assert.equal(preference.init.headers.get('x-workspace-id'), 'workspace_one');
  assert.equal(preference.init.method, 'PATCH');
  assert.equal(logout.init.credentials, 'omit');
  assert.equal(guest.init.headers.get('authorization'), null);
});

test('lists model IDs and versions for the authenticated workspace', async () => {
  const models = [{ id: 'local-echo', version: 'synthetic-v1' }];
  const client = new AssistantClient({
    origin,
    fetch: async (url, init) => {
      assert.equal(url, origin + '/api/assistant/v1/models');
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.get('authorization'), 'Bearer synthetic-test-token');
      assert.equal(init.headers.get('x-workspace-id'), 'workspace_one');
      return Response.json({ models });
    },
  });
  await client.replaceSession(session);
  assert.deepEqual(await client.listModels(), { models });
});

test('permits a same-origin correlation cookie only when starting reviewed SSO enrollment', async () => {
  const requests = [];
  const client = new AssistantClient({ origin, fetch: async (url, request) => {
    requests.push({ path: new URL(url).pathname, ...request });
    if (url.endsWith('/revoke')) return new Response(null, { status: 204 });
    return Response.json(url.endsWith('/start') ? { authorizationUrl: origin + '/fixture' }
      : { eligible: true, linked: false });
  } });
  await client.replaceSession(session);
  assert.deepEqual(await client.getOrganizationSsoLink(), { eligible: true, linked: false });
  await client.startOrganizationSsoLink('synthetic-password');
  await client.revokeOrganizationSsoLink('synthetic-password');
  assert.deepEqual(requests.map(({ path, method, credentials }) => [path, method, credentials]), [
    ['/api/assistant/v1/organization-sso/link', 'GET', 'omit'],
    ['/api/assistant/v1/organization-sso/link/start', 'POST', 'same-origin'],
    ['/api/assistant/v1/organization-sso/link/revoke', 'POST', 'omit'],
  ]);
  for (const { headers, body } of requests) {
    assert.equal(headers.get('x-workspace-id'), session.user.workspaceId);
    if (body) assert.deepEqual(JSON.parse(body), { currentPassword: 'synthetic-password', confirm: true });
  }
});

test('only sends OCR acknowledgement on the relevant grant request', async () => {
  const requests = [];
  const client = new AssistantClient({ origin, fetch: async (url, request) => {
    requests.push(request.headers.get('x-assistant-ocr-reviewed'));
    if (url.endsWith('/download-grant')) return Response.json({ token: 'synthetic-local-grant' }, { status: 201 });
    assert.equal(request.headers.get('x-attachment-grant'), 'synthetic-local-grant');
    return new Response('fixture\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  } });
  await client.replaceSession(session);
  await client.downloadProjectPdfAttachment('fixture-project', 'fixture-text');
  await client.downloadProjectPdfAttachment('fixture-project', 'fixture-scan', undefined, true);
  assert.deepEqual(requests, [null, null, 'true', null]);
});

test('scopes personal and project memory and drops a cancelled temporary response', async () => {
  const seen = [];
  let finish;
  const client = new AssistantClient({
    origin,
    fetch: async (url, init) => {
      seen.push({ url: new URL(url), init });
      if (url.endsWith('/temporary-chat')) return new Promise((resolve) => { finish = resolve; });
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({ enabled: true });
    },
  });
  await client.replaceSession(session);
  await client.updateMemorySettings({ enabled: true, instructions: '个人指令' });
  await client.listMemories('project A', { limit: 12, cursor: 'next+one' });
  await client.deleteMemory('entry one', 'project A');
  await client.setConversationSharingRestriction('conversation one', true);
  const scope = new AbortController();
  const pending = client.replyToTemporaryChat('临时', scope.signal);
  const result = assert.rejects(pending, { name: 'AbortError' });
  scope.abort();
  finish(Response.json({ content: '内部测试', modelId: 'local-echo' }));
  await result;
  assert.deepEqual(seen.map(({ url, init }) => [init.method, url.pathname.slice('/api/assistant/v1'.length)]), [
    ['PATCH', '/memory/settings'],
    ['GET', '/projects/project%20A/memory/entries'],
    ['DELETE', '/projects/project%20A/memory/entries/entry%20one'],
    ['PUT', '/conversations/conversation%20one/sharing-restriction'],
    ['POST', '/temporary-chat'],
  ]);
  assert.deepEqual(JSON.parse(seen[0].init.body), { enabled: true, instructions: '个人指令' });
  assert.equal(seen[1].url.searchParams.get('cursor'), 'next+one');
  assert.deepEqual(JSON.parse(seen[3].init.body), { restricted: true });
  assert.deepEqual(JSON.parse(seen[4].init.body), { content: '临时' });
  assert.equal(seen[4].init.signal.aborted, true);
  assert.ok(seen.every(({ init }) => init.headers.get('x-workspace-id') === session.user.workspaceId));
});

test('sends a PNG as raw bytes and uses a scoped private grant only on download', async () => {
  const seen = [];
  const project = 'project one';
  const id = 'image one';
  const source = '/api/assistant/v1/projects/project%20one/attachments';
  const asset = '/api/assistant/v1/artifacts/protected%20asset/versions/old%20version';
  const attachment = { id, state: 'quarantined', size: 4, createdAt: '2026-11-24T00:00:00Z' };
  const image = new Blob([Uint8Array.of(137, 80, 78, 71)], { type: 'image/png' });
  const key = '619aa0b4-e1ab-4fa0-872e-5d7def4d3520';
  const client = new AssistantClient({
    origin,
    fetch: async (url, init) => {
      seen.push({ url, init });
      if (url.endsWith('/download-grant')) {
        return Response.json({ token: 'fixture-only', expiresAt: '2026-11-24T00:01:00Z' }, { status: 201 });
      }
      if (url.endsWith('/download')) return new Response(image, { headers: { 'Content-Type': 'image/png' } });
      return Response.json(attachment, { status: 202 });
    },
  });
  await client.replaceSession(session);
  assert.deepEqual(await client.uploadProjectAttachment(project, image, key), attachment);
  assert.deepEqual(new Uint8Array(await (await client.downloadProjectAttachment(project, id)).arrayBuffer()),
    new Uint8Array(await image.arrayBuffer()));
  assert.deepEqual(new Uint8Array(await (await client.downloadArtifactVersion('protected asset', 'old version', 'image')).arrayBuffer()),
    new Uint8Array(await image.arrayBuffer()));
  assert.deepEqual(seen.map(({ url, init }) => [url.slice(origin.length), init.method]), [
    [source, 'POST'],
    [source + '/image%20one/download-grant', 'POST'],
    [source + '/image%20one/download', 'GET'],
    [asset + '/download-grant', 'POST'],
    [asset + '/download', 'GET'],
  ]);
  assert.equal(seen[0].init.body, image);
  assert.equal(seen[0].init.headers.get('content-type'), 'image/png');
  assert.equal(seen[0].init.headers.get('idempotency-key'), key);
  assert.equal(seen[1].init.headers.get('x-attachment-grant'), null);
  assert.equal(seen[2].init.headers.get('x-attachment-grant'), 'fixture-only');
  assert.equal(seen[3].init.headers.get('x-attachment-grant'), null);
  assert.equal(seen[4].init.headers.get('x-attachment-grant'), 'fixture-only');
  assert.ok(seen.every(({ init }) => init.headers.get('x-workspace-id') === session.user.workspaceId));
});

test('passes scoped research revisions and reminder controls through the versioned API', async () => {
  const seen = [];
  const api = new AssistantClient({
    origin,
    fetch: async (url, init) => {
      const request = new URL(url);
      seen.push({ request, init });
      if (request.pathname.endsWith('/report')) {
        return new Response('已审核的合成报告', { headers: { 'Content-Type': 'text/plain; charset=UTF-8' } });
      }
      return Response.json({ items: [], nextCursor: null });
    },
  });
  await api.replaceSession(session);
  await api.listResearchSources({ cursor: 'opaque+c', limit: 20 });
  await api.reviseResearchTask('task A', { expectedRevision: 1, question: '范围', sourceIds: ['source B'] });
  await api.approveResearchTask('task A', 2);
  assert.equal(await (await api.downloadResearchReport('task A', 2)).text(), '已审核的合成报告');
  const reminder = { title: '示例', startsAtLocal: '2026-11-24T13:00', timeZone: 'Asia/Shanghai', cadence: 'daily' };
  await api.createReminder(reminder, '6ceabbd4-f1ad-4d45-b0be-320e1949a2b5');
  await api.updateReminderState('reminder A', false);
  await api.listReminderOccurrences({ reminderId: 'reminder A', limit: 20 });
  await api.markReminderOccurrenceRead('occurrence B');
  assert.deepEqual(seen.map(({ request, init }) => [init.method, request.pathname.slice('/api/assistant/v1'.length)]), [
    ['GET', '/research/sources'],
    ['PATCH', '/research/task%20A'],
    ['POST', '/research/task%20A/approve'],
    ['GET', '/research/task%20A/report'],
    ['POST', '/automations/reminders'],
    ['PATCH', '/automations/reminders/reminder%20A'],
    ['GET', '/automations/reminder-occurrences'],
    ['PATCH', '/automations/reminder-occurrences/occurrence%20B'],
  ]);
  assert.equal(seen[0].request.searchParams.get('cursor'), 'opaque+c');
  assert.deepEqual(JSON.parse(seen[1].init.body), { expectedRevision: 1, question: '范围', sourceIds: ['source B'] });
  assert.deepEqual(JSON.parse(seen[2].init.body), { revision: 2 });
  assert.equal(seen[3].request.searchParams.get('revision'), '2');
  assert.equal(seen[4].init.headers.get('idempotency-key'), '6ceabbd4-f1ad-4d45-b0be-320e1949a2b5');
  assert.deepEqual(JSON.parse(seen[4].init.body), reminder);
  assert.deepEqual(JSON.parse(seen[5].init.body), { active: false });
  assert.equal(seen[6].request.searchParams.get('reminderId'), 'reminder A');
  assert.deepEqual(JSON.parse(seen[7].init.body), { read: true });
  assert.ok(seen.every(({ init }) => init.headers.get('x-workspace-id') === session.user.workspaceId));
});

test('keeps reminder share tokens in scoped JSON bodies and omits them from management URLs', async () => {
  const requests = [];
  const api = new AssistantClient({
    origin,
    fetch: async (url, init) => {
      requests.push({ url: new URL(url), init });
      return init.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({});
    },
  });
  await api.replaceSession(session);
  const token = 'fixture-private-share-token';
  await api.previewReminderShare('reminder A');
  await api.publishReminderShare('reminder A', 'preview-owner');
  await api.listReminderShares('reminder A');
  await api.readReminderShare(token);
  await api.applyReminderShare({ token, revision: 'preview-recipient', confirm: true });
  await api.revokeReminderShare('share B');
  assert.deepEqual(requests.map(({ url, init }) => [init.method, url.pathname.slice('/api/assistant/v1'.length)]), [
    ['POST', '/automations/reminders/reminder%20A/share-preview'],
    ['POST', '/automations/reminders/reminder%20A/shares'],
    ['GET', '/automations/reminders/reminder%20A/shares'],
    ['POST', '/automations/reminder-shares/read'],
    ['POST', '/automations/reminder-shares/apply'],
    ['DELETE', '/automations/reminder-shares/share%20B'],
  ]);
  assert.ok(requests.every(({ url, init }) => !url.href.includes(token) && url.search === ''
    && init.headers.get('x-workspace-id') === session.user.workspaceId));
  assert.deepEqual(JSON.parse(requests[1].init.body), { revision: 'preview-owner' });
  assert.deepEqual(JSON.parse(requests[3].init.body), { token });
  assert.deepEqual(JSON.parse(requests[4].init.body), { token, revision: 'preview-recipient', confirm: true });
});

test('scopes artifact histories and checks the declared download media type', async () => {
  const requests = [];
  const content = '# 合成 UTF-8 🦀\n';
  const api = new AssistantClient({
    origin,
    fetch: async (url, init) => {
      const request = new URL(url);
      requests.push({ request, init });
      if (request.pathname.endsWith('/download')) {
        return new Response(content, { headers: { 'Content-Type': 'text/markdown; charset=UTF-8' } });
      }
      return Response.json({});
    },
  });
  await api.replaceSession(session);
  await api.createArtifact({ sourceMessageId: 'reply A', title: '测试', format: 'markdown' }, 'fixture-key');
  await api.rollbackArtifact('doc A', { baseVersionId: 'current', versionId: 'prior' });
  assert.equal(await (await api.downloadArtifactVersion('doc A', 'prior', 'markdown')).text(), content);
  await assert.rejects(api.downloadArtifactVersion('doc A', 'prior', 'text'));
  await api.publishProjectArtifact('project A', { artifactId: 'doc A', versionId: 'prior', confirm: true });
  assert.equal(await (await api.downloadProjectArtifactPublication('project A', 'publication B', 'markdown')).text(), content);
  assert.equal(requests[0].init.headers.get('idempotency-key'), 'fixture-key');
  assert.deepEqual(JSON.parse(requests[0].init.body), { sourceMessageId: 'reply A', title: '测试', format: 'markdown' });
  assert.equal(requests[1].request.pathname, '/api/assistant/v1/artifacts/doc%20A/rollback');
  assert.equal(requests[2].request.pathname, '/api/assistant/v1/artifacts/doc%20A/versions/prior/download');
  assert.equal(requests[4].request.pathname, '/api/assistant/v1/collaboration/projects/project%20A/artifact-publications');
  assert.deepEqual(JSON.parse(requests[4].init.body), { artifactId: 'doc A', versionId: 'prior', confirm: true });
  assert.equal(requests[5].request.pathname, '/api/assistant/v1/collaboration/projects/project%20A/artifact-publications/publication%20B/download');
  assert.ok(requests.every(({ init }) => init.headers.get('x-workspace-id') === session.user.workspaceId));
});

test('requires explicit invitation confirmation and keeps shared materials under a separate project route', async () => {
  const seen = [];
  const api = new AssistantClient({
    origin,
    fetch: async (url, init) => {
      seen.push({ pathname: new URL(url).pathname, init });
      return Response.json({ items: [] });
    },
  });
  await api.replaceSession(session);
  await api.inviteProjectMember('project A', { recipientUsername: 'member_a', role: 'viewer' });
  await api.acceptProjectInvitation('grant A');
  await api.listSharedProjectMaterials('project A');
  assert.deepEqual(seen.map(({ pathname }) => pathname.slice('/api/assistant/v1'.length)), [
    '/projects/project%20A/collaboration/invitations',
    '/collaboration/invitations/grant%20A/accept',
    '/collaboration/projects/project%20A/materials',
  ]);
  assert.deepEqual(JSON.parse(seen[0].init.body), { recipientUsername: 'member_a', role: 'viewer' });
  assert.deepEqual(JSON.parse(seen[1].init.body), { confirm: true });
  assert.ok(seen.every(({ init }) => init.headers.get('x-workspace-id') === session.user.workspaceId));
});

test('clears the active account after confirmed erasure and keeps it after failed reauthentication', async () => {
  const seen = [];
  let cleanups = 0;
  const client = new AssistantClient({
    origin,
    clearAccountData: () => { cleanups += 1; },
    fetch: async (url, init) => {
      seen.push({ url, init });
      if (seen.length === 1) {
        return Response.json({ code: 'INVALID_CURRENT_PASSWORD', message: 'Invalid current password' }, { status: 401 });
      }
      return seen.length === 2 ? new Response(null, { status: 204 }) : Response.json({ capabilities: [] });
    },
  });
  await client.replaceSession(session);
  const request = { currentPassword: 'fixture-password-only', confirmation: 'DELETE' };
  await assert.rejects(() => client.eraseAccount(request), { code: 'INVALID_CURRENT_PASSWORD' });
  assert.equal(cleanups, 1);
  await client.eraseAccount(request);
  await client.getCapabilities();
  assert.equal(cleanups, 2);
  for (const call of seen.slice(0, 2)) {
    assert.equal(call.url, origin + '/api/assistant/v1/privacy/account-erasure');
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.get('authorization'), 'Bearer synthetic-test-token');
    assert.deepEqual(JSON.parse(call.init.body), request);
  }
  assert.equal(seen.at(-1).init.headers.get('authorization'), null);
});

test('reads account usage and requests exactly one authenticated export attachment per page', async () => {
  const timestamp = '2026-11-22T12:00:00Z';
  const { id, username, workspaceId, preferences } = session.user;
  const usage = { limit: 1_000_000, reserved: 8192, used: 8, available: 991800, unit: 'output_code_points' };
  const largeUsage = { ...usage, limit: '9007199254740991', available: 9007199254732791 };
  const firstPage = {
    schemaVersion: 1, exportedAt: timestamp, workspaceId,
    account: { id, username, preferences, createdAt: timestamp },
    conversations: [], messages: [], runs: [], nextCursor: 'export/cursor+point=',
  };
  const lastPage = { ...firstPage, nextCursor: null };
  const expected = [
    { path: '/usage', value: usage },
    { path: '/usage', value: largeUsage },
    { path: '/privacy/export', value: firstPage },
    { path: '/privacy/export?cursor=export%2Fcursor%2Bpoint%3D', value: lastPage },
  ];
  const client = new AssistantClient({
    origin,
    fetch: async (url, init) => {
      const { path, value } = expected.shift();
      assert.equal(url, origin + '/api/assistant/v1' + path);
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.get('accept'), 'application/json');
      assert.equal(init.headers.get('authorization'), 'Bearer synthetic-test-token');
      assert.equal(init.headers.get('x-workspace-id'), workspaceId);
      assert.equal(init.body, undefined);
      return Response.json(value, path.startsWith('/privacy/export') ? {
        headers: { 'Content-Disposition': 'attachment; filename="assistant-data.json"' },
      } : undefined);
    },
  });
  await client.replaceSession(session);
  assert.deepEqual(await client.getUsage(), usage);
  assert.deepEqual(await client.getUsage(), largeUsage);
  assert.equal(expected.length, 2);
  const page = await client.getExportPage();
  assert.deepEqual(page, firstPage);
  assert.equal(expected.length, 1);
  assert.deepEqual(await client.getExportPage(page.nextCursor), lastPage);
  assert.equal(expected.length, 0);
});

test('submits scoped reply reports as metadata and preserves repeated receipts and errors', async () => {
  const input = { targetType: 'assistant_reply', targetId: 'reply-one', reason: 'privacy' };
  const receipt = { ...input, id: 'report-one', status: 'open', createdAt: '2026-11-22T12:00:00Z' };
  const sharedInput = { targetType: 'shared_reply', shareToken: 'sh_' + 's'.repeat(43), replyIndex: 1, reason: 'safety' };
  const sharedReceipt = { id: 'report-shared', targetType: 'shared_reply', targetId: 'share-one',
    reason: sharedInput.reason, status: 'open', createdAt: receipt.createdAt };
  const requests = [
    { body: input, status: 201 },
    { body: input, status: 200 },
    { body: { ...input, reason: 'spam' }, status: 409 },
    { body: { ...input, targetId: 'unavailable' }, status: 404 },
    { body: sharedInput, status: 201, response: sharedReceipt },
  ];
  const client = new AssistantClient({
    origin,
    fetch: async (url, init) => {
      const { body, status, response = receipt } = requests.shift();
      assert.equal(url, origin + '/api/assistant/v1/reports');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.get('authorization'), 'Bearer synthetic-test-token');
      assert.equal(init.headers.get('x-workspace-id'), 'workspace_one');
      assert.deepEqual(JSON.parse(init.body), body);
      if (status === 409) return Response.json({ code: 'CONFLICT', message: 'Already reported' }, { status });
      if (status === 404) return Response.json({ code: 'NOT_FOUND', message: 'Unavailable' }, { status });
      return Response.json(response, { status });
    },
  });
  await client.replaceSession(session);
  assert.deepEqual(await client.submitReport({ ...input, content: 'Do not send reply text' }), receipt);
  assert.deepEqual(await client.submitReport(input), receipt);
  await assert.rejects(client.submitReport({ ...input, reason: 'spam' }), (error) =>
    error instanceof AssistantApiError && error.status === 409 && error.code === 'CONFLICT');
  await assert.rejects(client.submitReport({ ...input, targetId: 'unavailable' }), (error) =>
    error instanceof AssistantApiError && error.status === 404 && error.code === 'NOT_FOUND');
  assert.deepEqual(await client.submitReport({ ...sharedInput, targetId: 'private-reply', content: 'Omit reply text' }), sharedReceipt);
  assert.equal(requests.length, 0);
});

test('scopes private project metadata, conversation filters and move commands', async () => {
  const timestamp = '2026-11-22T12:00:00Z';
  const project = { id: 'project/a', name: '资料整理', description: '第一行\n🦀', createdAt: timestamp, updatedAt: timestamp };
  const conversation = { id: 'chat/a', title: '迁移测试', pinned: false, archived: false, updatedAt: timestamp };
  const filed = { ...conversation, projectId: project.id };
  const page = { items: [project], nextCursor: 'project/page+1=' };
  const updated = { ...project, description: '' };
  const expected = [
    { path: '/projects', method: 'POST', body: { name: project.name, description: project.description }, value: project },
    { path: '/projects?cursor=project%2Fpage%2B1%3D&limit=5', method: 'GET', value: page },
    { path: '/projects/project%2Fa', method: 'GET', value: project },
    { path: '/projects/project%2Fa', method: 'PATCH', body: { description: '' }, value: updated },
    { path: '/conversations', method: 'POST', body: { title: conversation.title, projectId: project.id }, value: filed },
    { path: '/conversations?projectId=project%2Fa&archived=false', method: 'GET', value: { items: [filed], nextCursor: null } },
    { path: '/conversations/chat%2Fa/project', method: 'PUT', body: { projectId: project.id }, value: filed },
    { path: '/conversations/chat%2Fa/project', method: 'PUT', body: { projectId: null }, value: conversation },
    { path: '/conversations?unfiled=true', method: 'GET', value: { items: [conversation], nextCursor: null } },
  ];
  const client = new AssistantClient({
    origin,
    fetch: async (url, init) => {
      const call = expected.shift();
      assert.equal(url, origin + '/api/assistant/v1' + call.path);
      assert.equal(init.method, call.method);
      assert.equal(init.headers.get('authorization'), 'Bearer synthetic-test-token');
      assert.equal(init.headers.get('x-workspace-id'), session.user.workspaceId);
      assert.deepEqual(init.body === undefined ? undefined : JSON.parse(init.body), call.body);
      return Response.json(call.value, { status: call.method === 'POST' ? 201 : 200 });
    },
  });
  await client.replaceSession(session);
  assert.deepEqual(await client.createProject({ name: project.name, description: project.description }), project);
  assert.deepEqual(await client.listProjects({ cursor: page.nextCursor, limit: 5 }), page);
  assert.deepEqual(await client.getProject(project.id), project);
  assert.deepEqual(await client.updateProject(project.id, { description: '' }), updated);
  assert.deepEqual(await client.createConversation({ title: conversation.title, projectId: project.id }), filed);
  assert.deepEqual((await client.listConversations({ projectId: project.id, archived: false })).items, [filed]);
  assert.deepEqual(await client.moveConversation(conversation.id, project.id), filed);
  assert.deepEqual(await client.moveConversation(conversation.id, null), conversation);
  assert.deepEqual((await client.listConversations({ unfiled: true })).items, [conversation]);
  assert.equal(expected.length, 0);
});

test('queues background exports with stable keys, reads job state and downloads UTF-8 Markdown', async () => {
  const timestamp = '2026-11-22T12:00:00Z';
  const job = {
    id: 'job/a', kind: 'conversation_export', conversationId: 'chat/a', sourceMessageId: 'message/a',
    status: 'queued', progress: 0, createdAt: timestamp, updatedAt: timestamp,
  };
  const done = { ...job, status: 'completed', progress: 100, artifactId: 'archive/a' };
  const markdown = '# 会话导出\n\n中文 🦀\n';
  const expected = [
    { method: 'POST', path: '/conversations/chat%2Fa/exports', value: job, status: 202 },
    { method: 'POST', path: '/conversations/chat%2Fa/exports', value: job, status: 202 },
    { method: 'GET', path: '/jobs?cursor=jobs%2Fpast%2B1%3D&limit=5', value: { items: [job], nextCursor: null } },
    { method: 'GET', path: '/jobs/job%2Fa', value: done },
    { method: 'POST', path: '/jobs/job%2Fa/cancel', value: done },
    { method: 'GET', path: '/jobs/job%2Fa/artifact', artifact: true },
    { method: 'GET', path: '/jobs/job%2Fa/artifact', status: 409, value: { code: 'CONFLICT', message: 'Not ready' } },
  ];
  const client = new AssistantClient({
    origin,
    fetch: async (url, init) => {
      const call = expected.shift();
      assert.equal(url, origin + '/api/assistant/v1' + call.path);
      assert.equal(init.method, call.method);
      assert.equal(init.headers.get('authorization'), 'Bearer synthetic-test-token');
      assert.equal(init.headers.get('x-workspace-id'), session.user.workspaceId);
      assert.equal(init.credentials, 'omit');
      if (call.status === 202) {
        assert.equal(init.headers.get('idempotency-key'), 'export-key~1');
        assert.deepEqual(JSON.parse(init.body), { sourceMessageId: job.sourceMessageId });
      } else {
        assert.equal(init.body, undefined);
      }
      if (call.path.endsWith('/artifact')) {
        assert.equal(init.headers.get('accept'), 'text/markdown, application/json');
      }
      if (call.artifact) {
        return new Response(markdown, {
          headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
        });
      }
      return Response.json(call.value, { status: call.status ?? 200 });
    },
  });
  await client.replaceSession(session);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await client.queueConversationExport(job.conversationId, job.sourceMessageId, 'export-key~1'), job);
  }
  assert.deepEqual(await client.listJobs({ cursor: 'jobs/past+1=', limit: 5 }), { items: [job], nextCursor: null });
  assert.deepEqual(await client.getJob(job.id), done);
  assert.deepEqual(await client.cancelJob(job.id), done);
  const file = await client.downloadJobArtifact(job.id);
  assert.ok(file instanceof Blob);
  assert.match(file.type, /^text\/markdown/);
  assert.equal(await file.text(), markdown);
  await assert.rejects(client.downloadJobArtifact(job.id), { status: 409, code: 'CONFLICT' });
  assert.equal(expected.length, 0);
});

test('rejects non-Markdown and prevents stale artifact downloads after switching accounts', async () => {
  let started;
  const bodyStarted = new Promise((resolve) => { started = resolve; });
  let finishBody;
  let callCount = 0;
  const client = new AssistantClient({
    origin,
    fetch: async () => {
      if (++callCount === 1) return Response.json({ message: 'Unexpected body' });
      const stream = new ReadableStream({
        pull(controller) {
          finishBody = () => {
            controller.enqueue(new TextEncoder().encode('# Old synthetic data'));
            controller.close();
          };
          started();
        },
      }, { highWaterMark: 0 });
      return new Response(stream, { headers: { 'Content-Type': 'text/markdown' } });
    },
  });
  await client.replaceSession(session);
  await assert.rejects(client.downloadJobArtifact('job/a'), { status: 200, code: 'HTTP_ERROR' });
  const pending = client.downloadJobArtifact('job/a');
  const aborted = assert.rejects(pending, { name: 'AbortError' });
  await bodyStarted;
  await client.replaceSession({ ...session, accessToken: 'another-synthetic-token' });
  finishBody();
  await aborted;
});

test('account replacement cancels in-flight work and clears consumer data before using new credentials', async () => {
  let deferred;
  let oldSignal;
  const clear = [];
  const client = new AssistantClient({
    origin,
    clearAccountData: () => clear.push('cleared'),
    fetch: async (_url, init) => {
      if (init.headers.get('authorization') === 'Bearer synthetic-test-token') {
        oldSignal = init.signal;
        return new Promise(resolve => { deferred = resolve; });
      }
      assert.equal(init.headers.get('authorization'), 'Bearer next-synthetic-token');
      assert.equal(clear.length, 2);
      return Response.json({ capabilities: [] });
    },
  });
  await client.replaceSession(session);
  const pending = client.getAccount();
  await client.replaceSession({ ...session, accessToken: 'next-synthetic-token' });
  assert.equal(oldSignal.aborted, true);
  deferred(Response.json(session.user));
  await assert.rejects(pending, { name: 'AbortError' });
  assert.deepEqual(await client.getCapabilities(), { capabilities: [] });
});

test('waits for overlapping asynchronous account cleanup before activating the latest session', async () => {
  let finishCleanup;
  let cleanupCount = 0;
  const cleared = new Promise(resolve => { finishCleanup = resolve; });
  const client = new AssistantClient({
    origin,
    clearAccountData: async () => {
      if (++cleanupCount === 1) await cleared;
    },
    fetch: async (_url, init) => Response.json({ authorization: init.headers.get('authorization') }),
  });

  const first = client.replaceSession(session);
  const stale = assert.rejects(first, { name: 'AbortError' });
  const latest = client.replaceSession({ ...session, accessToken: 'latest-synthetic-token' });
  assert.deepEqual(await client.getCapabilities(), { authorization: null });
  finishCleanup();
  await stale;
  await latest;
  assert.equal(cleanupCount, 2);
  assert.deepEqual(await client.getCapabilities(), { authorization: 'Bearer latest-synthetic-token' });
});

test('preserves Unicode queries, false filters, opaque cursors and idempotency keys', async () => {
  const client = new AssistantClient({
    origin,
    fetch: async (url, init) => {
      if (init.method === 'GET') {
        const query = new URL(url).searchParams;
        assert.equal(query.get('q'), '北京 & 深圳');
        assert.equal(query.get('archived'), 'false');
        assert.equal(query.get('cursor'), 'cursor/+=');
        return Response.json({ items: [], nextCursor: null });
      }
      assert.equal(url, origin + '/api/assistant/v1/conversations/conversation%2F1/runs');
      assert.equal(init.headers.get('Idempotency-Key'), 'retry-key-1');
      assert.deepEqual(JSON.parse(init.body), { action: 'send', content: '你好' });
      return Response.json({
        runId: 'run_1',
        conversationId: 'conversation/1',
        state: 'queued',
        lastSequence: 0,
        content: '',
      }, { status: 202 });
    },
  });
  await client.listConversations({ q: '北京 & 深圳', archived: false, cursor: 'cursor/+=' });
  assert.equal((await client.startRun('conversation/1', { action: 'send', content: '你好' }, 'retry-key-1')).runId, 'run_1');
  assert.throws(() => client.getConversation('..'), /Invalid resource ID/);
});

test('consumes CRLF streams split anywhere and deduplicates replay from the saved cursor', async () => {
  const chunks = oneCharacterAtATime(fixture.replaceAll('\n', '\r\n'));
  const events = await collect(decodeRunEvents(chunks, { runId: 'run_example', afterSequence: 1 }));
  assert.deepEqual(events.map(event => event.sequence), [2, 3]);
  assert.equal(events[0].delta, '你好！');
});

test('sends Last-Event-ID and decodes Unicode bytes split across network chunks', async () => {
  const client = new AssistantClient({
    origin,
    fetch: async (_url, init) => {
      assert.equal(init.headers.get('accept'), 'text/event-stream');
      assert.equal(init.headers.get('Last-Event-ID'), '1');
      return asStream(fixture);
    },
  });
  const events = await collect(client.openRunEvents('run_example', { afterSequence: 1 }));
  assert.deepEqual(events.map(event => event.type), ['message.delta', 'run.completed']);
  assert.equal(events[0].delta, '你好！');
});

test('leaves incomplete frames unapplied and detects gaps', async () => {
  const unfinished = fixture.slice(0, fixture.lastIndexOf('\n\n'));
  const events = await collect(decodeRunEvents(oneCharacterAtATime(unfinished), { runId: 'run_example' }));
  assert.deepEqual(events.map(event => event.sequence), [1, 2]);

  const firstFrameMissing = fixture.slice(fixture.indexOf('id: 2'));
  await assert.rejects(
    collect(decodeRunEvents(oneCharacterAtATime(firstFrameMissing), { runId: 'run_example' })),
    error => error instanceof StreamProtocolError && /Missing events/.test(error.message),
  );
});

test('exposes cursor expiry as a typed error so the caller can request the snapshot', async () => {
  const demo = { runId: 'run_example', conversationId: 'conversation_one', state: 'completed', lastSequence: 3, content: '你好！' };
  const client = new AssistantClient({
    origin,
    fetch: async (url) => url.endsWith('/events')
      ? Response.json({ code: 'CURSOR_EXPIRED', message: 'Replay no longer available' }, { status: 410 })
      : Response.json(demo),
  });
  await assert.rejects(collect(client.openRunEvents('run_example', { afterSequence: 1 })), error => (
    error instanceof AssistantApiError && error.status === 410 && error.code === 'CURSOR_EXPIRED'
  ));
  assert.deepEqual(await client.getRunSnapshot('run_example'), demo);
});

test('previews and publishes the same selection and keeps share access tokens in request bodies', async () => {
  const selection = { sourceMessageId: 'message-one', scope: 'reply', audience: 'link', includesAttachments: false };
  const revision = 'a'.repeat(64);
  const token = `sh_${'q'.repeat(43)}`;
  const when = '2026-11-22T07:00:00Z';
  const content = { title: '会话', scope: 'reply', audience: 'link', includesAttachments: false,
    messages: [{ role: 'assistant', content: '只显示答复' }] };
  const summary = { id: 'share-one', scope: 'reply', audience: 'link', createdAt: when, expiresAt: when };
  const seen = [];
  const client = new AssistantClient({ origin, fetch: async (url, init) => {
    assert.ok(!url.includes(token));
    assert.equal(init.credentials, 'omit');
    const { pathname, searchParams } = new URL(url);
    const route = pathname.replace('/api/assistant/v1', '');
    const payload = init.body === undefined ? undefined : JSON.parse(init.body);
    const authorization = init.headers.get('authorization');
    seen.push({ route, method: init.method, authorization, payload, cursor: searchParams.get('cursor') });
    if (route.endsWith('/share-previews')) return Response.json({ ...content, revision });
    if (route.endsWith('/shares') && init.method === 'POST') return Response.json({ ...summary, token }, { status: 201 });
    if (route.endsWith('/shares')) return Response.json({ items: [summary], nextCursor: null });
    if (route.endsWith('/read')) return Response.json({ ...content, expiresAt: when });
    if (route.endsWith('/copy')) return Response.json({ id: 'recipient-copy' }, { status: 201 });
    return new Response(null, { status: 204 });
  } });

  assert.deepEqual(await client.readShare(token), { ...content, expiresAt: when });
  await client.replaceSession(session);
  const preview = await client.previewShare('conversation/a', selection);
  assert.deepEqual(preview, { ...content, revision });
  const published = await client.createShare('conversation/a', { ...selection, revision: preview.revision });
  assert.deepEqual(published, { ...summary, token });
  assert.deepEqual(await client.listShares('conversation/a', { cursor: 'cursor/+=' }), { items: [summary], nextCursor: null });
  assert.deepEqual(await client.copyShare(token), { id: 'recipient-copy' });
  await client.revokeShare(published.id);

  assert.deepEqual(seen.map(call => [call.method, call.route]), [
    ['POST', '/shares/read'], ['POST', '/conversations/conversation%2Fa/share-previews'],
    ['POST', '/conversations/conversation%2Fa/shares'], ['GET', '/conversations/conversation%2Fa/shares'],
    ['POST', '/shares/copy'], ['DELETE', '/shares/share-one'],
  ]);
  assert.equal(seen[0].authorization, null);
  assert.ok(seen.slice(1).every(({ authorization }) => authorization === 'Bearer synthetic-test-token'));
  assert.deepEqual(seen.map(({ payload }) => payload), [
    { token }, selection, { ...selection, revision }, undefined, { token }, undefined,
  ]);
  assert.equal(seen[3].cursor, 'cursor/+=');
});

test('does not expose a share response from an expired account context', async () => {
  let resolveRequest;
  const client = new AssistantClient({ origin, fetch: async () => new Promise(resolve => { resolveRequest = resolve; }) });
  await client.replaceSession(session);
  const pending = client.readShare(`sh_${'r'.repeat(43)}`);
  const blocked = assert.rejects(pending, { name: 'AbortError' });
  await client.replaceSession(null);
  resolveRequest(Response.json({ title: '工作空间资料' }));
  await blocked;
});

test('confirms workspace membership before retiring the old request context', async () => {
  let resolvePrevious;
  let previousSignal;
  let cleanups = 0;
  let left = false;
  const target = 'workspace_two';
  const membershipRevision = 'fd823454-3dde-4953-a87e-53906b6b7619';
  const client = new AssistantClient({ origin, clearAccountData: () => { cleanups += 1; }, fetch: async (url, init) => {
    const workspace = init.headers.get('x-workspace-id');
    assert.equal(init.headers.get('authorization'), 'Bearer synthetic-test-token');
    if (url.endsWith('/auth/workspaces')) {
      assert.equal(workspace, null);
      return Response.json({ items: [{ id: target, kind: 'workspace' }], nextCursor: null });
    }
    if (url.endsWith(`/auth/workspaces/${target}/leave-preview`)) {
      assert.equal(workspace, null);
      assert.equal(init.method, 'GET');
      return Response.json({ workspaceId: target, membershipRevision });
    }
    if (url.endsWith(`/auth/workspaces/${target}/leave`)) {
      assert.equal(workspace, null);
      assert.equal(init.method, 'POST');
      assert.deepEqual(JSON.parse(init.body), { membershipRevision, confirm: true });
      left = true;
      return new Response(null, { status: 204 });
    }
    if (url.endsWith('/capabilities') && workspace === session.user.workspaceId) {
      previousSignal = init.signal;
      return new Promise(resolve => { resolvePrevious = resolve; });
    }
    if (url.endsWith('/auth/logout')) {
      assert.equal(workspace, null);
      return new Response(null, { status: 204 });
    }
    if (workspace === 'unrelated' || (workspace === target && left)) {
      return Response.json({ code: 'FORBIDDEN', message: 'Workspace unavailable' }, { status: 403 });
    }
    if (url.endsWith('/auth/me')) return Response.json({ ...session.user, workspaceId: workspace ?? session.user.workspaceId });
    return Response.json({ workspace });
  } });

  await client.replaceSession(session);
  assert.equal((await client.listWorkspaces()).items[0].id, target);
  const oldResponse = client.getCapabilities();
  const discarded = assert.rejects(oldResponse, { name: 'AbortError' });
  await assert.rejects(client.switchWorkspace('unrelated'), { code: 'FORBIDDEN' });
  assert.equal(previousSignal.aborted, false);
  assert.equal((await client.getAccount()).workspaceId, session.user.workspaceId);
  assert.equal((await client.switchWorkspace(target)).workspaceId, target);
  assert.equal(previousSignal.aborted, true);
  resolvePrevious(Response.json({ capabilities: [] }));
  await discarded;
  assert.equal((await client.listConversations()).workspace, target);
  const reviewed = await client.previewWorkspaceDeparture(target);
  assert.equal(reviewed.membershipRevision, membershipRevision);
  await client.leaveWorkspace(target, { membershipRevision: reviewed.membershipRevision, confirm: true });
  await assert.rejects(client.getAccount(), { code: 'FORBIDDEN' });
  assert.equal((await client.returnToPersonalWorkspace()).workspaceId, session.user.workspaceId);
  assert.equal((await client.listConversations()).workspace, session.user.workspaceId);
  await client.logout();
  assert.equal(cleanups, 4);
});

test('submits retrieval queries in a scoped JSON body and reads saved citation status', async () => {
  const client = new AssistantClient({ origin, fetch: async (url, init) => {
    assert.equal(init.headers.get('x-workspace-id'), session.user.workspaceId);
    assert.equal(init.headers.get('authorization'), 'Bearer synthetic-test-token');
    if (init.method === 'POST') {
      assert.equal(url, `${origin}/api/assistant/v1/retrieval/answers`);
      assert.deepEqual(JSON.parse(init.body), { query: '中文 & mercury' });
      return Response.json({ id: 'answer/example', state: 'supported' }, { status: 201 });
    }
    assert.equal(url, `${origin}/api/assistant/v1/retrieval/answers/answer%2Fexample`);
    return Response.json({ id: 'answer/example', state: 'no_sources', claims: [], citations: [{ status: 'stale' }] });
  } });
  await client.replaceSession(session);
  assert.equal((await client.retrieveAnswer('中文 & mercury')).state, 'supported');
  const refreshed = await client.getRetrievalAnswer('answer/example');
  assert.deepEqual(refreshed.claims, []);
  assert.equal(refreshed.citations[0].status, 'stale');
});

test('uses owner-scoped routes for private project material and keeps search input literal', async () => {
  const material = { id: 'resource/item', name: '中文资料', content: '文件正文\n🦀' };
  const seen = [];
  const client = new AssistantClient({ origin, fetch: async (url, init) => {
    assert.equal(init.headers.get('x-workspace-id'), session.user.workspaceId);
    const address = new URL(url);
    assert.ok(address.pathname.includes('/projects/project%2F1/resources'));
    seen.push([init.method, address.pathname]);
    if (init.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body), { name: material.name, content: material.content });
      return Response.json(material, { status: 201 });
    }
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (address.pathname.endsWith('resource%2Fitem')) return Response.json(material);
    assert.equal(address.searchParams.get('q'), '中文%_');
    assert.equal(address.searchParams.get('cursor'), '+/=');
    return Response.json({ items: [{ id: material.id, name: material.name }], nextCursor: null });
  } });
  await client.replaceSession(session);
  await client.createProjectResource('project/1', { name: material.name, content: material.content });
  assert.equal((await client.listProjectResources('project/1', { cursor: '+/=', q: '中文%_' })).items.length, 1);
  assert.equal((await client.getProjectResource('project/1', material.id)).content, material.content);
  await client.deleteProjectResource('project/1', material.id);
  assert.deepEqual(seen.map(([method]) => method), ['POST', 'GET', 'GET', 'DELETE']);
});

test('requests CSV analysis through scoped resource routes and rejects a different download format', async () => {
  let mediaType = 'text/csv; charset=UTF-8';
  const client = new AssistantClient({ origin, fetch: async (url, init) => {
    assert.equal(init.headers.get('x-workspace-id'), session.user.workspaceId);
    if (init.method === 'POST') {
      assert.equal(url, `${origin}/api/assistant/v1/projects/a/resources/b/analysis`);
      assert.deepEqual(JSON.parse(init.body), { valueColumn: '数量' });
      return Response.json({ id: 'run-analysis', valueCount: 3 }, { status: 201 });
    }
    assert.equal(url, `${origin}/api/assistant/v1/analysis/run-analysis/artifact`);
    assert.equal(init.headers.get('accept'), 'text/csv, application/json');
    return new Response('row,value\r\n1,2\r\n', { headers: { 'content-type': mediaType } });
  } });
  await client.replaceSession(session);
  const analysis = await client.analyzeProjectResource('a', 'b', { valueColumn: '数量' });
  assert.equal(await (await client.downloadAnalysis(analysis.id)).text(), 'row,value\r\n1,2\r\n');
  mediaType = 'text/markdown';
  await assert.rejects(client.downloadAnalysis(analysis.id), { code: 'HTTP_ERROR' });
});
