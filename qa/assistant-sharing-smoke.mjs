import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18093');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && origin.pathname === '/' &&
  !origin.username && !origin.password && !origin.search && !origin.hash, 'Use an isolated loopback API.');
const mode = process.argv[3] ?? 'normal';
assert.ok(['normal', 'workspace', 'restore', 'disabled'].includes(mode), 'Unknown share verification mode.');
const evidence = process.argv[4] && resolve(process.argv[4]);
assert.ok(!['workspace', 'restore'].includes(mode) || evidence, 'Provide an isolated evidence directory for the fixture driver.');
const accounts = [];
const prefix = '/api/assistant/v1';

async function request(path, status, { actor, method = 'GET', body, key } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor?.token) headers.Authorization = `Bearer ${actor.token}`;
  if (actor?.workspace) headers['X-Workspace-Id'] = actor.workspace;
  if (key) headers['Idempotency-Key'] = key;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(prefix + path, origin), { method, headers,
    body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(5000) });
  const result = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (response.status !== status) {
    assert.equal(response.status, status, `${method} ${path} ${response.status >= 400 ? result?.code ?? '' : ''}`);
  }
  if (path.includes('/shares') || path.includes('/share-previews') || path.endsWith('/sharing-restriction')) {
    assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  }
  return result;
}

async function register() {
  const credentials = { username: `qa-share-${randomUUID().slice(0, 10)}`, password: `Qa.Share-${randomUUID()}` };
  const session = await request('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { id: session.user.id, workspace: session.user.workspaceId, token: session.accessToken, credentials };
  accounts.push(actor);
  return actor;
}

function createConversation(actor, title, projectId) {
  return request('/conversations', 201, { actor, method: 'POST', body: { title, projectId } });
}

function messages(actor, id) {
  return request(`/conversations/${id}/messages`, 200, { actor }).then(({ items }) => items);
}

async function complete(actor, id, content, editOf) {
  const { runId } = await request(`/conversations/${id}/runs`, 202, { actor, method: 'POST', key: randomUUID(),
    body: { action: editOf ? 'edit' : 'send', ...(editOf ? { messageId: editOf } : {}), content, modelId: 'local-echo' } });
  const until = Date.now() + 25_000;
  do {
    const current = await request(`/runs/${runId}`, 200, { actor });
    if (current.state === 'completed') {
      assert.equal(current.content, `本地模拟回复：${content}`);
      assert.ok(current.messageId);
      return current.messageId;
    }
    assert.ok(['queued', 'running'].includes(current.state), `Fixture run entered ${current.state}.`);
    await delay(125);
  } while (Date.now() < until);
  assert.fail('Mock generation exceeded the fixture timeout.');
}

const selection = (sourceMessageId, scope = 'branch', audience = 'link') => ({ sourceMessageId, scope, audience, includesAttachments: false });
const preview = (actor, id, input, status = 200) => request(`/conversations/${id}/share-previews`, status, { actor, method: 'POST', body: input });
const publish = (actor, id, input, revision, status = 201) => request(`/conversations/${id}/shares`, status, { actor, method: 'POST', body: { ...input, revision } });
const read = (token, actor, status = 200) => request('/shares/read', status, { actor, method: 'POST', body: { token } });
const copy = (token, actor, status = 201) => request('/shares/copy', status, { actor, method: 'POST', body: { token } });
const revoke = (actor, id, status = 204) => request(`/shares/${id}`, status, { actor, method: 'DELETE' });
const restrict = (actor, id, restricted, status = 200) => request(`/conversations/${id}/sharing-restriction`, status,
  { actor, method: 'PUT', body: { restricted } });

async function issue(actor, id, input) {
  const draft = await preview(actor, id, input);
  assert.match(draft.revision, /^[a-f0-9]{64}$/);
  const published = await publish(actor, id, input, draft.revision);
  assert.match(published.token, /^sh_[A-Za-z0-9_-]{43}$/);
  assert.equal(published.scope, draft.scope);
  assert.equal(published.audience, draft.audience);
  assert.ok(Date.parse(published.expiresAt) > Date.now());
  return published;
}

async function mark(name, value = {}) {
  await mkdir(evidence, { recursive: true });
  const path = join(evidence, `${name}.json`);
  await writeFile(path + '.tmp', JSON.stringify(value, null, 2));
  await rename(path + '.tmp', path);
}

async function waitForMarker(name, timeout = 60_000) {
  const path = join(evidence, `${name}.json`);
  const deadline = Date.now() + timeout;
  do {
    try {
      await access(path);
      return;
    } catch (failure) {
      if (failure.code !== 'ENOENT') throw failure;
    }
    await delay(150);
  } while (Date.now() < deadline);
  assert.fail(`Fixture driver did not write ${name}.`);
}

async function waitForRestoredApi(owner) {
  const deadline = Date.now() + 85_000;
  do {
    let capabilities;
    try {
      capabilities = await request('/capabilities', 200, { actor: owner });
    } catch (failure) {
      if (!(failure instanceof TypeError || failure.name === 'TimeoutError')) throw failure;
    }
    if (capabilities) {
      assert.equal(capabilities.capabilities.find(({ id }) => id === 'conversation_sharing')?.available, true);
      return;
    }
    await delay(400);
  } while (Date.now() < deadline);
  assert.fail('Restored API did not become available.');
}

async function sharingRestriction(owner, recipient) {
  const chat = await createConversation(owner, '有分享限制的合成会话');
  assert.equal(chat.sharingRestricted, false);
  const source = await complete(owner, chat.id, '限制后仍可读取本人的对话');
  const branch = selection(source);
  const before = await preview(owner, chat.id, branch);
  const published = await publish(owner, chat.id, branch, before.revision);
  const independent = await copy(published.token, recipient);
  await restrict(undefined, chat.id, true, 401);
  await restrict(recipient, chat.id, true, 404);
  await restrict(owner, chat.id, 'true', 400);
  assert.equal((await restrict(owner, chat.id, true)).sharingRestricted, true);
  assert.equal((await restrict(owner, chat.id, true)).sharingRestricted, true);
  assert.equal((await request(`/conversations/${chat.id}`, 200, { actor: owner })).sharingRestricted, true);
  const { items } = await request('/conversations?q=有分享限制的合成会话', 200, { actor: owner });
  assert.equal(items.find(({ id }) => id === chat.id)?.sharingRestricted, true);
  assert.equal((await preview(owner, chat.id, branch, 403)).code, 'SHARE_RESTRICTED');
  assert.equal((await preview(owner, chat.id, selection(source, 'reply', 'workspace'), 403)).code, 'SHARE_RESTRICTED');
  assert.equal((await publish(owner, chat.id, branch, before.revision, 403)).code, 'SHARE_RESTRICTED');
  await read(published.token, undefined, 404);
  await copy(published.token, recipient, 404);
  const listed = await request(`/conversations/${chat.id}/shares`, 200, { actor: owner });
  assert.ok(listed.items.find(({ id }) => id === published.id)?.revokedAt);
  await revoke(owner, published.id);
  await complete(owner, chat.id, '限制分享期间继续聊天');
  assert.equal((await messages(recipient, independent.id)).length, 2);
  assert.equal((await restrict(owner, chat.id, false)).sharingRestricted, false);
  await read(published.token, undefined, 404);
  assert.equal((await publish(owner, chat.id, branch, before.revision, 409)).code, 'SHARE_PREVIEW_STALE');
  const republished = await issue(owner, chat.id, branch);
  assert.notEqual(republished.id, published.id);
  assert.deepEqual((await read(republished.token)).messages, before.messages);
}

async function normal(owner) {
  const outsider = await register();
  const chat = await createConversation(owner, '原合成会话');
  const selected = await complete(owner, chat.id, '仅共享这一支🦀');
  const prompt = (await messages(owner, chat.id)).find(({ role }) => role === 'user');
  await complete(owner, chat.id, '另一个分支禁止泄露🌿', prompt.id);
  const otherChat = await createConversation(outsider, '接收方的原会话');
  const unrelated = await complete(outsider, otherChat.id, '跨账号不可分享');
  const branch = selection(selected);
  await preview(undefined, chat.id, branch, 401);
  await preview(outsider, chat.id, branch, 404);
  await preview(owner, chat.id, selection(unrelated), 404);
  await preview(owner, chat.id, selection(prompt.id, 'reply'), 400);
  await preview(owner, chat.id, { ...branch, includesAttachments: true }, 400);
  const first = await preview(owner, chat.id, branch);
  assert.deepEqual(first.messages, [{ role: 'user', content: '仅共享这一支🦀' },
    { role: 'assistant', content: '本地模拟回复：仅共享这一支🦀' }]);
  assert.equal(first.includesAttachments, false);
  await request(`/conversations/${chat.id}`, 200, { actor: owner, method: 'PATCH', body: { title: '已确认的合成标题' } });
  assert.equal((await publish(owner, chat.id, branch, first.revision, 409)).code, 'SHARE_PREVIEW_STALE');
  const branchLink = await issue(owner, chat.id, branch);
  const replyLink = await issue(owner, chat.id, selection(selected, 'reply'));
  const list = await request(`/conversations/${chat.id}/shares?limit=1`, 200, { actor: owner });
  assert.equal(list.items.length, 1);
  assert.ok(list.nextCursor);
  const second = await request(`/conversations/${chat.id}/shares?limit=1&cursor=${encodeURIComponent(list.nextCursor)}`, 200, { actor: owner });
  assert.equal(second.nextCursor, null);
  assert.deepEqual(new Set([...list.items, ...second.items].map(({ id }) => id)), new Set([branchLink.id, replyLink.id]));
  assert.ok([...list.items, ...second.items].every((item) => !('token' in item) && !('messages' in item)));
  await request(`/conversations/${chat.id}/shares`, 404, { actor: outsider });

  await request(`/conversations/${chat.id}`, 200, { actor: owner, method: 'PATCH', body: { title: '发布后的私有改名' } });
  const opened = await read(branchLink.token);
  assert.equal(opened.title, '已确认的合成标题');
  assert.equal(opened.audience, 'link');
  assert.deepEqual(opened.messages, first.messages);
  assert.deepEqual(Object.keys(opened).sort(), ['audience', 'expiresAt', 'includesAttachments', 'messages', 'scope', 'title']);
  assert.deepEqual((await read(replyLink.token)).messages, [first.messages[1]]);
  await read(`sh_${'0'.repeat(43)}`, undefined, 404);
  const expiredSession = { ...outsider, token: 'synthetic-expired-session' };
  await read(replyLink.token, expiredSession, 401);
  await read(`sh_${'0'.repeat(43)}`, expiredSession, 401);
  await copy(replyLink.token, undefined, 401);
  await revoke(outsider, replyLink.id, 404);
  const copies = await Promise.all([copy(replyLink.token, outsider), copy(replyLink.token, outsider)]);
  assert.equal(copies[0].id, copies[1].id);
  const copied = copies[0];
  assert.notEqual(copied.id, chat.id);
  assert.equal(copied.projectId, undefined);
  const copiedMessages = await messages(outsider, copied.id);
  assert.equal(copiedMessages.length, 1);
  assert.notEqual(copiedMessages[0].id, selected);
  assert.equal(copiedMessages[0].parentId, null);
  assert.equal(copiedMessages[0].content, first.messages[1].content);
  await request(`/conversations/${copied.id}`, 404, { actor: owner });
  await request(`/conversations/${chat.id}`, 404, { actor: outsider });
  await revoke(owner, replyLink.id);
  await revoke(owner, replyLink.id);
  await read(replyLink.token, outsider, 404);
  await copy(replyLink.token, outsider, 404);
  await complete(outsider, copied.id, '已授权副本继续聊天');
  assert.equal((await messages(owner, chat.id)).length, 4);

  const branchCopy = await copy(branchLink.token, outsider);
  const clonedBranch = await messages(outsider, branchCopy.id);
  assert.deepEqual(clonedBranch.map(({ role, content }) => ({ role, content })), first.messages);
  assert.equal(clonedBranch[1].parentId, clonedBranch[0].id);
  await complete(outsider, branchCopy.id, '从复制分支尾部接续');
  const continuedBranch = await messages(outsider, branchCopy.id);
  assert.equal(continuedBranch.find(({ content }) => content === '从复制分支尾部接续').parentId, clonedBranch[1].id);
  await request(`/conversations/${branchCopy.id}`, 204, { actor: outsider, method: 'DELETE' });
  await copy(branchLink.token, outsider, 404);
  const project = await request('/projects', 201, { actor: owner, method: 'POST', body: { name: '私有项目' } });
  await request(`/conversations/${chat.id}/project`, 200, { actor: owner, method: 'PUT', body: { projectId: project.id } });
  await read(branchLink.token, undefined, 404);
  assert.equal((await preview(owner, chat.id, branch, 403)).code, 'SHARE_AUDIENCE_UNAVAILABLE');
  await request(`/conversations/${chat.id}/project`, 200, { actor: owner, method: 'PUT', body: { projectId: null } });
  await read(branchLink.token, undefined, 404);
  const deletionLink = await issue(owner, chat.id, branch);
  await request(`/conversations/${chat.id}`, 204, { actor: owner, method: 'DELETE' });
  await read(deletionLink.token, undefined, 404);
  await sharingRestriction(owner, outsider);
  const accountChat = await createConversation(owner, '注销时仍有效的分享');
  const erasureSource = await complete(owner, accountChat.id, '注销撤回样例');
  const erasureLink = await issue(owner, accountChat.id, selection(erasureSource));
  await request('/privacy/account-erasure', 204, { actor: owner, method: 'POST',
    body: { currentPassword: owner.credentials.password, confirmation: 'DELETE' } });
  await read(erasureLink.token, undefined, 404);
  assert.equal((await messages(outsider, copied.id)).length, 3);
  console.log(JSON.stringify({ previewAndBranchIsolation: 'passed', guardedAudience: 'passed', copyRaceAndIndependence: 'passed',
    unfilingDoesNotReviveLink: 'passed', revocationAndSourceDeletion: 'passed', ownerErasure: 'passed', noStoreAndTokenScope: 'passed',
    sharingRestrictionAndFreshPreview: 'passed' }));
}

async function workspace(owner) {
  const outsider = await register();
  const chat = await createConversation(owner, '工作空间合成会话');
  const selected = await complete(owner, chat.id, '工作空间成员限定🔒');
  const link = await issue(owner, chat.id, selection(selected, 'branch', 'workspace'));
  await read(link.token, undefined, 404);
  await read(link.token, outsider, 404);
  await copy(link.token, outsider, 404);
  await request('/auth/workspaces', 401);
  assert.deepEqual(await request('/auth/workspaces', 200, { actor: outsider }), {
    items: [{ id: outsider.workspace, kind: 'personal' }], nextCursor: null,
  });
  await request('/auth/workspaces?limit=0', 400, { actor: outsider });
  await request('/auth/workspaces?cursor=unknown', 400, { actor: outsider });
  await mark('membership-ready', { shareId: link.id, ownerId: owner.id, readerId: outsider.id, workspaceId: owner.workspace });
  await waitForMarker('membership-added');
  const member = { ...outsider, workspace: owner.workspace };
  const first = await request('/auth/workspaces?limit=1', 200, { actor: outsider });
  const second = await request(`/auth/workspaces?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`, 200, { actor: outsider });
  assert.equal(second.nextCursor, null);
  const memberships = [...first.items, ...second.items];
  assert.deepEqual(new Set(memberships), new Set([{ id: outsider.workspace, kind: 'personal' }, { id: owner.workspace, kind: 'workspace' }]));
  assert.equal((await request('/auth/me', 200, { actor: member })).workspaceId, owner.workspace);
  assert.equal((await read(link.token, member)).messages[0].content, '工作空间成员限定🔒');
  const borrowed = await copy(link.token, member);
  assert.equal((await request(`/conversations/${borrowed.id}`, 200, { actor: member })).id, borrowed.id);
  await request(`/conversations/${borrowed.id}`, 404, { actor: outsider });
  await restrict(member, chat.id, true, 404);
  await restrict(owner, chat.id, true);
  await read(link.token, member, 404);
  await copy(link.token, member, 404);
  assert.equal((await messages(member, borrowed.id)).length, 2);
  await restrict(owner, chat.id, false);
  await read(link.token, member, 404);
  const newLink = await issue(owner, chat.id, selection(selected, 'branch', 'workspace'));
  await read(newLink.token, member);
  await mark('membership-read');
  await waitForMarker('membership-removed');
  await read(newLink.token, member, 404);
  await copy(newLink.token, member, 404);
  await request(`/conversations/${borrowed.id}`, 403, { actor: member });
  await request('/auth/me', 403, { actor: member });
  assert.deepEqual((await request('/auth/workspaces', 200, { actor: member })).items, [{ id: outsider.workspace, kind: 'personal' }]);
  await read(newLink.token, outsider, 404);
  await copy(newLink.token, outsider, 404);
  const publicShare = await issue(owner, chat.id, selection(selected, 'reply'));
  assert.equal((await read(publicShare.token)).scope, 'reply');
  await mark('expiry-ready', { shareId: publicShare.id, ownerId: owner.id });
  await waitForMarker('expiry-set');
  await read(publicShare.token, undefined, 404);
  await copy(publicShare.token, owner, 404);
  console.log(JSON.stringify({ outsideWorkspaceDenied: true, currentMemberAllowed: true, removedMemberDenied: true,
    expiredLinkDenied: true, memberShareHiddenByRestriction: true }));
}

async function restore(owner) {
  const explorer = await register();
  const durable = await createConversation(owner, '恢复后保留的合成会话');
  const source = await complete(owner, durable.id, '分享撤销恢复检查');
  const removed = await issue(owner, durable.id, selection(source, 'reply'));
  const retained = await issue(owner, durable.id, selection(source));
  const independent = await copy(removed.token, explorer);
  const doomed = await createConversation(owner, '恢复前删除的合成会话');
  const doomedSource = await complete(owner, doomed.id, '删除后不可恢复分享');
  const doomedLink = await issue(owner, doomed.id, selection(doomedSource));
  const filed = await createConversation(owner, '移入私有项目的合成会话');
  const filedSource = await complete(owner, filed.id, '移入项目后永久撤回旧链接');
  const filedLink = await issue(owner, filed.id, selection(filedSource));
  const project = await request('/projects', 201, { actor: owner, method: 'POST', body: { name: '恢复前移入的私有项目' } });
  const locked = await createConversation(owner, '恢复后仍应限制分享');
  const lockedSource = await complete(owner, locked.id, '恢复锁定状态与旧链接撤回');
  const lockedLink = await issue(owner, locked.id, selection(lockedSource));
  const unlocked = await createConversation(owner, '恢复后应保留取消限制状态');
  const unlockedSource = await complete(owner, unlocked.id, '恢复取消限制顺序');
  const unlockedLink = await issue(owner, unlocked.id, selection(unlockedSource));

  await mark('backup-ready');
  await waitForMarker('backup-done');
  await revoke(owner, removed.id);
  await request(`/conversations/${doomed.id}`, 204, { actor: owner, method: 'DELETE' });
  await request(`/conversations/${filed.id}/project`, 200, { actor: owner, method: 'PUT', body: { projectId: project.id } });
  await restrict(owner, locked.id, true);
  await restrict(owner, unlocked.id, true);
  await restrict(owner, unlocked.id, false);
  await read(removed.token, undefined, 404);
  await read(doomedLink.token, undefined, 404);
  await read(filedLink.token, undefined, 404);
  await read(lockedLink.token, undefined, 404);
  await read(unlockedLink.token, undefined, 404);
  await mark('restore-ready');
  await waitForMarker('database-switched', 120_000);
  await waitForRestoredApi(owner);
  await read(removed.token, undefined, 404);
  await copy(removed.token, explorer, 404);
  await read(doomedLink.token, undefined, 404);
  await read(filedLink.token, undefined, 404);
  await read(lockedLink.token, undefined, 404);
  await read(unlockedLink.token, undefined, 404);
  assert.equal((await request(`/conversations/${locked.id}`, 200, { actor: owner })).sharingRestricted, true);
  assert.equal((await request(`/conversations/${unlocked.id}`, 200, { actor: owner })).sharingRestricted, false);
  assert.equal((await preview(owner, locked.id, selection(lockedSource), 403)).code, 'SHARE_RESTRICTED');
  await restrict(owner, locked.id, false);
  await read(lockedLink.token, undefined, 404);
  const newShare = await issue(owner, unlocked.id, selection(unlockedSource));
  await read(newShare.token);
  assert.equal((await read(retained.token)).messages[0].content, '分享撤销恢复检查');
  assert.equal((await messages(explorer, independent.id))[0].content, '本地模拟回复：分享撤销恢复检查');
  const result = { explicitRevocationRestored: true, sourceDeletionRestored: true, projectFilingRevoked: true,
    controlShareAvailable: true, copyIndependent: true, activeRestrictionRestored: true,
    laterUnlockRestoredWithoutReopeningLink: true };
  await mark('summary', result);
  console.log(JSON.stringify(result));
}

try {
  const owner = await register();
  const capabilities = await request('/capabilities', 200, { actor: owner });
  assert.equal(capabilities.capabilities.find(({ id }) => id === 'conversation_sharing')?.available, mode !== 'disabled');
  if (mode === 'disabled') {
    const chat = await createConversation(owner, '分享关闭');
    await request(`/conversations/${chat.id}/shares`, 401);
    assert.equal((await request(`/conversations/${chat.id}/shares`, 403, { actor: owner })).code, 'CAPABILITY_UNAVAILABLE');
    console.log(JSON.stringify({ disabledCapability: 'passed' }));
  } else if (mode === 'restore') {
    await restore(owner);
  } else if (mode === 'workspace') {
    await workspace(owner);
  } else {
    await normal(owner);
  }
} finally {
  await Promise.all(accounts.map((actor) => request('/auth/logout', 204, { actor, method: 'POST' }).catch(() => {})));
}
