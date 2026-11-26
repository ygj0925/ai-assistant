import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [address, directory] = process.argv.slice(2);
const origin = new URL(address);
assert.ok(['http:', 'https:'].includes(origin.protocol) &&
  ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) &&
  origin.port && origin.port !== '18080' && origin.pathname === '/' &&
  !origin.username && !origin.password && !origin.search && !origin.hash,
'Use a dedicated loopback fixture.');
assert.ok(directory, 'Supply a fresh evidence directory for the membership fixture driver.');
const evidence = resolve(directory);
await mkdir(evidence);

async function request(path, status, { actor, method = 'GET', input, key } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.token;
    headers['X-Workspace-Id'] = actor.workspace;
  }
  if (key) headers['Idempotency-Key'] = key;
  if (input !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL('/api/assistant/v1' + path, origin), {
    method, headers, body: input === undefined ? undefined : JSON.stringify(input),
    redirect: 'error', signal: AbortSignal.timeout(5_000),
  });
  assert.equal(response.status, status, method + ' ' + path);
  return status === 204 ? undefined : response.json();
}

async function register() {
  const session = await request('/auth/register', 201, {
    method: 'POST', input: { username: 'qa-run-member-' + randomUUID().slice(0, 10), password: 'Qa.Member-' + randomUUID() },
  });
  return { token: session.accessToken, workspace: session.user.workspaceId, id: session.user.id };
}

async function waitFor(probe, predicate, message, milliseconds = 15_000) {
  const deadline = Date.now() + milliseconds;
  do {
    const value = await probe();
    if (predicate(value)) return value;
    await delay(120);
  } while (Date.now() < deadline);
  throw new Error(message);
}

async function mark(name, data) {
  const path = join(evidence, name + '.json');
  await writeFile(path + '.tmp', JSON.stringify(data), { flag: 'wx' });
  await rename(path + '.tmp', path);
}

async function membership(action, completed, members) {
  await mark(action, members);
  await waitFor(() => readFile(join(evidence, completed + '.json')).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  }), Boolean, 'Membership fixture did not complete ' + action, 25_000);
}

const owner = await register();
const member = await register();
const selected = { ...member, workspace: owner.workspace };
const members = { workspaceId: owner.workspace, readerId: member.id, ownerId: owner.id };
try {
  await membership('add', 'added', members);
  await request('/auth/me', 200, { actor: selected });
  const before = await request('/usage', 200, { actor: member });
  const first = await request('/conversations', 201, { actor: selected, method: 'POST', input: { title: 'Active synthetic workspace run' } });
  const second = await request('/conversations', 201, { actor: selected, method: 'POST', input: { title: 'Waiting synthetic workspace run' } });
  const content = '运行撤权样本'.repeat(180);
  const active = await request('/conversations/' + first.id + '/runs', 202, {
    actor: selected, method: 'POST', key: randomUUID(), input: { action: 'send', modelId: 'local-echo', content },
  });
  const activePath = '/runs/' + active.runId;
  await waitFor(() => request(activePath, 200, { actor: selected }), ({ state, content: delta }) =>
    state === 'running' && delta.length > 0, 'The synthetic generation did not start.');
  const waiting = await request('/conversations/' + second.id + '/runs', 202, {
    actor: selected, method: 'POST', key: randomUUID(), input: { action: 'send', modelId: 'local-echo', content: 'This cannot start after workspace removal.' },
  });
  assert.equal(waiting.state, 'queued');

  await membership('remove', 'removed', members);
  assert.equal((await request(activePath, 403, { actor: selected })).code, 'FORBIDDEN');
  const settled = await waitFor(() => request('/usage', 200, { actor: member }), ({ reserved }) =>
    reserved === before.reserved, 'Revoked workspace jobs failed to release their reservations.');
  await membership('rejoin', 'rejoined', members);
  const stopped = await request(activePath, 200, { actor: selected });
  const neverStarted = await request('/runs/' + waiting.runId, 200, { actor: selected });
  assert.equal(stopped.state, 'cancelled');
  assert.equal(neverStarted.state, 'cancelled');
  assert.equal(neverStarted.content, '');
  assert.ok(stopped.content.length > 0 && stopped.content.length < content.length);
  assert.equal(BigInt(settled.used) - BigInt(before.used), BigInt([...stopped.content].length));
  await mark('summary', { revokedAccess: 'blocked', active: stopped.state, queued: neverStarted.state, reservations: 'released', use: 'delivered-output-only' });
  console.log('Workspace departure stopped both active and queued generation.');
} finally {
  for (const actor of [member, owner]) await request('/auth/logout', 204, { actor, method: 'POST' });
}
