import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [source, mode, directory, target] = process.argv.slice(2);
assert.ok(['restore'].includes(mode), 'Use the isolated conversation read-lock fixture.');
assert.ok(directory, 'Provide a fresh synthetic evidence directory.');

function loopback(address) {
  const url = new URL(address);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.port && url.port !== '18080' && url.pathname === '/'
    && !url.username && !url.password && !url.search && !url.hash);
  return url;
}

let origin = loopback(source);
const restored = target && loopback(target);
assert.equal(Boolean(restored), mode === 'restore');
const evidence = resolve(directory);
await mkdir(evidence, { recursive: true });
const actors = [];

async function request(path, expected, { actor, method = 'GET', body, key } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.token;
    headers['X-Workspace-Id'] = actor.workspace;
  }
  if (key) headers['Idempotency-Key'] = key;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL('/api/assistant/v1' + path, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(12_000),
  });
  const data = response.status === 204 ? undefined : await response.json().catch(() => null);
  assert.equal(response.status, expected, method + ' ' + path + ' → ' + (data?.code ?? ''));
  if (path.startsWith('/conversations') || path.startsWith('/runs/') || path.startsWith('/privacy/')) {
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
  }
  return data;
}

async function register() {
  const credentials = { username: 'qa-leave-' + randomUUID().slice(0, 10), password: 'Qa.WorkspaceLeave-' + randomUUID() };
  const { accessToken, user } = await request('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { token: accessToken, id: user.id, workspace: user.workspaceId, username: user.username };
  actors.push(actor);
  return { ...actor, credentials };
}

async function mark(name, data) {
  const path = join(evidence, name + '.json');
  await writeFile(path + '.tmp', JSON.stringify(data) + '\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

async function until(name) {
  const path = join(evidence, name + '.json');
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(125);
  }
  assert.fail('Fixture did not complete ' + name + '.json.');
}

async function waitFor(probe, check, label, milliseconds = 30_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const current = await probe();
    if (check(current)) return current;
    await delay(125);
  }
  assert.fail(label);
}


const conversations = '/conversations';
const lockPath = (id) => conversations + '/' + id + '/read-lock';
const unlockPath = (id) => conversations + '/' + id + '/read-unlock';
const transcript = (id) => conversations + '/' + id + '/messages';
const publications = (project) => '/collaboration/projects/' + project + '/artifact-publications';
const sentinel = '永远不能出现在加锁内容响应的合成标记42';
const title = '只锁定这一条合成会话-84';
const controlText = '正常对照对话可继续读取';
async function runRequest(actor, id, content) {
  return request(conversations + '/' + id + '/runs', 202, {
    actor, method: 'POST', key: randomUUID(), body: { action: 'send', modelId: 'local-echo', content },
  });
}

const run = (actor, id, expected = 200) => request('/runs/' + id, expected, { actor });
const newConversation = (actor, title, projectId) => request(conversations, 201, {
  actor, method: 'POST', body: { title, ...(projectId ? { projectId } : {}) },
});
const lock = (actor, id, confirm = true, expected = 204) =>
  request(lockPath(id), expected, { actor, method: 'POST', body: { confirm } });
const unlock = (actor, id, currentPassword, expected = 204) =>
  request(unlockPath(id), expected, { actor, method: 'POST', body: { currentPassword } });
const shareRead = (actor, token, expected = 200) => request('/shares/read', expected, {
  actor, method: 'POST', body: { token },
});

async function finish(actor, conversationId, content) {
  const queued = await runRequest(actor, conversationId, content);
  return waitFor(() => run(actor, queued.runId), ({ state }) => state === 'completed', 'Synthetic reply did not finish.');
}

async function share(owner, id, sourceMessageId, audience = 'workspace') {
  const operation = { sourceMessageId, scope: 'reply', audience };
  const route = conversations + '/' + id;
  const preview = await request(route + '/share-previews', 200, { actor: owner, method: 'POST', body: operation });
  return request(route + '/shares', 201, { actor: owner, method: 'POST',
    body: { ...operation, revision: preview.revision } });
}

async function liveStream(actor, runId) {
  const response = await fetch(new URL('/api/assistant/v1/runs/' + runId + '/events', origin), {
    headers: { Accept: 'text/event-stream', Authorization: 'Bearer ' + actor.token, 'X-Workspace-Id': actor.workspace },
    redirect: 'error', signal: AbortSignal.timeout(90_000),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const captured = [];
  let buffer = '';
  const done = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll('\r\n', '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const line = frame.split('\n').find(item => item.startsWith('data:'));
        if (line) captured.push(JSON.parse(line.slice(5)));
      }
    }
  })();
  return { captured, done };
}

async function denyResume(actor, runId) {
  const response = await fetch(new URL('/api/assistant/v1/runs/' + runId + '/events', origin), {
    headers: { Accept: 'text/event-stream', Authorization: 'Bearer ' + actor.token,
      'X-Workspace-Id': actor.workspace, 'Last-Event-ID': '0' },
    redirect: 'error', signal: AbortSignal.timeout(8000),
  });
  assert.equal(response.status, 423);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i);
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
  assert.equal((await response.json()).code, 'CONVERSATION_LOCKED');
}

async function exercise(owner) {
  const recipient = { ...await register(), workspace: owner.workspace };
  const { accessToken } = await request('/auth/login', 200, { method: 'POST', body: owner.credentials });
  const secondOwnerSession = { ...owner, token: accessToken };
  actors.push(secondOwnerSession);
  const project = await request('/projects', 201, { actor: owner, method: 'POST', body: { name: 'Synthetic locked lineage' } });
  await mark('membership-ready', { workspace: owner.workspace, ownerAccount: owner.id, member: recipient.id });
  await until('membership-added');
  const invitation = await request('/projects/' + project.id + '/collaboration/invitations', 201, {
    actor: owner, method: 'POST', body: { recipientUsername: recipient.username, role: 'viewer' },
  });
  await request('/collaboration/invitations/' + invitation.id + '/accept', 200, {
    actor: recipient, method: 'POST', body: { confirm: true },
  });
  const control = await newConversation(owner, 'Unaffected title control');
  await finish(owner, control.id, controlText);
  const item = await newConversation(owner, title, project.id);
  const sourceRun = await finish(owner, item.id, sentinel);
  const artifact = await request('/artifacts', 201, { actor: owner, method: 'POST', key: randomUUID(),
    body: { title: 'Source artifact ' + sentinel, format: 'markdown', sourceMessageId: sourceRun.messageId } });
  const pub = await request(publications(project.id), 201, {
    actor: owner, method: 'POST', body: { artifactId: artifact.id, versionId: artifact.head.id, confirm: true },
  });
  const pubPath = publications(project.id) + '/' + pub.id;
  assert.match((await request(pubPath, 200, { actor: recipient })).content, new RegExp(sentinel));
  const linked = await share(owner, item.id, sourceRun.messageId);
  assert.match((await shareRead(recipient, linked.token)).messages[0].content, new RegExp(sentinel));
  const priorCopy = await request('/shares/copy', 201, { actor: recipient, method: 'POST', body: { token: linked.token } });
  const publicSource = await newConversation(owner, 'Independent anyone-with-link fixture');
  const publicRun = await finish(owner, publicSource.id, 'Old public synthetic link must retire');
  const publicLink = await share(owner, publicSource.id, publicRun.messageId, 'link');
  await shareRead(undefined, publicLink.token);
  const job = await request(conversations + '/' + item.id + '/exports', 202, {
    actor: owner, method: 'POST', key: randomUUID(), body: { sourceMessageId: sourceRun.messageId },
  });
  await waitFor(() => request('/jobs/' + job.id, 200, { actor: owner }), ({ status }) => status === 'completed',
    'Synthetic prior local report did not finish.');
  assert.match(JSON.stringify(await request('/privacy/export', 200, { actor: owner })), new RegExp(sentinel));
  const active = await runRequest(owner, item.id, sentinel.repeat(100));
  const stream = await liveStream(owner, active.runId);
  await waitFor(() => Promise.resolve(stream.captured), (events) => events.some((event) => event.type === 'message.delta'),
    'The existing SSE did not send an authorized first fragment.');
  await mark('snapshot-ready', { conversation: item.id, owner: owner.id, workspace: owner.workspace,
    artifact: artifact.id, publication: pub.id, share: linked.id, job: job.id, activeRun: active.runId,
    publicConversation: publicSource.id, publicShare: publicLink.id, control: control.id });
  await until('snapshot-done');

  await lock(recipient, item.id, true, 404);
  await lock(secondOwnerSession, item.id, false, 400);
  await lock(secondOwnerSession, item.id);
  await lock(secondOwnerSession, publicSource.id);
  await Promise.race([stream.done, delay(5000).then(() => assert.fail('Existing SSE did not close.'))]);
  assert.ok(!stream.captured.some((event) => event.type === 'run.completed'));
  const blocked = async () => {
    const locked = await request(conversations + '/read-locked', 200, { actor: owner });
    assert.deepEqual(locked.items, [item.id, publicSource.id].sort().map(id => ({ id })));
    assert.ok(!(await request(conversations, 200, { actor: owner })).items.some(({ id }) => id === item.id));
    assert.deepEqual((await request(conversations + '?q=' + encodeURIComponent(sentinel), 200, { actor: owner })).items, []);
    assert.deepEqual((await request(conversations + '?q=' + encodeURIComponent(title), 200, { actor: owner })).items, []);
    assert.equal((await request(conversations + '/' + item.id, 423, { actor: owner })).code, 'CONVERSATION_LOCKED');
    await request(transcript(item.id), 423, { actor: owner });
    await request(conversations + '/' + item.id, 404, { actor: recipient });
    await run(owner, sourceRun.runId, 423);
    await denyResume(owner, active.runId);
    await request('/jobs/' + job.id + '/artifact', 423, { actor: owner });
    await request('/artifacts/' + artifact.id, 404, { actor: owner });
    await request('/artifacts/' + artifact.id + '/versions/' + artifact.head.id + '/download', 404, { actor: owner });
    await request(pubPath, 404, { actor: recipient });
    await shareRead(recipient, linked.token, 404);
    await shareRead(undefined, publicLink.token, 404);
    const dump = JSON.stringify(await request('/privacy/export', 200, { actor: owner }));
    assert.ok(!dump.includes(sentinel) && !dump.includes(title) && !dump.includes(artifact.id));
    assert.match(JSON.stringify(await request(transcript(control.id), 200, { actor: owner })), new RegExp(controlText));
    assert.match(JSON.stringify(await request(transcript(priorCopy.id), 200, { actor: recipient })), new RegExp(sentinel));
  };
  await blocked();
  const wrong = await unlock(secondOwnerSession, item.id, 'wrong synthetic password', 401);
  assert.equal(wrong.code, 'INVALID_CURRENT_PASSWORD');
  await mark('revoke-ready', { closedOldSurfaces: true });
  await until('database-switched');
  origin = restored;
  await blocked();
  await unlock(secondOwnerSession, item.id, owner.credentials.password);
  await unlock(secondOwnerSession, publicSource.id, owner.credentials.password);
  assert.deepEqual((await request(conversations + '/read-locked', 200, { actor: owner })).items, []);
  assert.match(JSON.stringify(await request(transcript(item.id), 200, { actor: owner })), new RegExp(sentinel));
  assert.match((await request('/artifacts/' + artifact.id, 200, { actor: owner })).head.content, new RegExp(sentinel));
  await shareRead(recipient, linked.token, 404);
  await shareRead(undefined, publicLink.token, 404);
  await request(pubPath, 404, { actor: recipient });
  const fresh = await share(owner, item.id, sourceRun.messageId);
  assert.notEqual(fresh.id, linked.id);
  await shareRead(recipient, fresh.token);
  const newPublic = await share(owner, publicSource.id, publicRun.messageId, 'link');
  assert.notEqual(newPublic.id, publicLink.id);
  await shareRead(undefined, newPublic.token);
  await lock(owner, item.id);
  await mark('flag-off-ready', { conversation: item.id });
  await until('flag-off-started');
  await request(transcript(item.id), 423, { actor: owner });
  const { capabilities } = await request('/capabilities', 200, { actor: owner });
  assert.equal(capabilities.find(({ id }) => id === 'conversation_read_lock')?.available, false);
  assert.equal(capabilities.find(({ id }) => id === 'locked_conversations')?.available, true);
  assert.deepEqual((await request(conversations + '/read-locked', 200, { actor: owner })).items,
    [{ id: item.id }]);
  await lock(owner, control.id, true, 403);
  await unlock(secondOwnerSession, item.id, owner.credentials.password);
  await request(transcript(item.id), 200, { actor: owner });
  return { explicitOwnerLock: true, titlesSearchAndHistoryHidden: true, exactSseStreamClosed: true,
    recordExportAndArtifactSourceHidden: true, derivedPublicationsAndOldShareDeniedAfterUnlock: true,
    independentAuthorizedCopyRetained: true, privateReadsRecoverAfterPassword: true,
    olderBackupCannotBypassLock: true, flagOffDoesNotBypassPriorLock: true };
}

try {
  const owner = await register();
  const { capabilities } = await request('/capabilities', 200, { actor: owner });
  assert.equal(capabilities.find(({ id }) => id === 'conversation_read_lock')?.available, true);
  const checks = await exercise(owner);
  await mark('summary', checks);
  console.log(JSON.stringify(checks));
} finally {
  for (const actor of actors) await request('/auth/logout', 204, { actor, method: 'POST' }).catch(() => undefined);
}
