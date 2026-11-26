import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18094');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && origin.pathname === '/' &&
  !origin.username && !origin.password && !origin.search && !origin.hash, 'Use an isolated loopback origin.');
const disabled = process.argv[3] === '--disabled';
const directory = !disabled && process.argv[3] ? resolve(process.argv[3]) : undefined;
const accounts = [];

async function request(route, expected, { method = 'GET', actor, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) {
    headers.Authorization = `Bearer ${actor.token}`;
    headers['X-Workspace-Id'] = actor.workspace;
  }
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL('/api/assistant/v1' + route, origin), {
    method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  const value = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  assert.equal(response.status, expected, `${method} ${route} ${value?.code ?? ''}`);
  if (route.startsWith('/retrieval')) assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  return value;
}

async function register() {
  const credentials = { username: `qa-cites-${randomUUID().slice(0, 12)}`, password: `Qa.Cites-${randomUUID()}` };
  const session = await request('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { token: session.accessToken, workspace: session.user.workspaceId, id: session.user.id, credentials };
  accounts.push(actor);
  return actor;
}

const retrieve = (actor, query, status = 201) => request('/retrieval/answers', status, { method: 'POST', actor, body: { query } });
const get = (actor, id, status = 200) => request(`/retrieval/answers/${id}`, status, { actor });

async function marker(name, body) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${name}.json`);
  await writeFile(`${path}.tmp`, JSON.stringify(body));
  await rename(`${path}.tmp`, path);
}

async function waitFor(name) {
  const deadline = Date.now() + 65_000;
  while (Date.now() < deadline) {
    try {
      await access(join(directory, `${name}.json`));
      return;
    } catch (failure) {
      if (failure.code !== 'ENOENT') throw failure;
    }
    await delay(200);
  }
  assert.fail(`Database fixture did not signal ${name}.`);
}

try {
  const owner = await register();
  const { capabilities } = await request('/capabilities', 200, { actor: owner });
  assert.equal(capabilities.find(({ id }) => id === 'source_retrieval')?.available, !disabled);
  await retrieve(undefined, 'thyme720', 401);
  if (disabled) {
    assert.equal((await retrieve(owner, 'thyme720', 403)).code, 'CAPABILITY_UNAVAILABLE');
    console.log(JSON.stringify({ disabled: true, anonymousDenied: true }));
  } else {
    const other = await register();
    await retrieve(owner, '🦀'.repeat(257), 400);
    const saved = await retrieve(owner, '  ＴＨＹＭＥ７２０  ');
    assert.equal(saved.state, 'supported');
    assert.equal(saved.citations.length, 2);
    assert.equal(saved.claims.length, 2);
    for (const claim of saved.claims) {
      assert.equal(claim.citationIds.length, 1);
      const citation = saved.citations.find(({ id }) => id === claim.citationIds[0]);
      const sample = claim.text.includes('720') ? { marker: '720', url: 'https://example.com/qa/retrieval/a' } :
        { marker: '721', url: 'https://example.com/qa/retrieval/b' };
      assert.equal(citation.url, sample.url);
      assert.match(citation.excerpt, new RegExp(sample.marker));
      assert.equal(citation.status, 'available');
      assert.equal(Date.parse(citation.accessedAt), 1704067200000);
    }
    await get(other, saved.id, 404);
    await get({ ...owner, workspace: other.workspace }, saved.id, 403);
    const noMatch = await retrieve(owner, '未收录的合成来源-7baf0');
    assert.equal(noMatch.state, 'no_sources');
    assert.deepEqual(noMatch.claims, []);
    assert.deepEqual(noMatch.citations, []);
    assert.deepEqual(await get(owner, saved.id), saved);
    if (directory) {
      await marker('expire-ready', { answerId: saved.id, accountId: owner.id });
      await waitFor('one-expired');
      const partial = await get(owner, saved.id);
      assert.equal(partial.state, 'partial');
      assert.equal(partial.claims.length, 1);
      assert.match(partial.claims[0].text, /721/);
      assert.equal(partial.citations.find(({ title }) => title === '合成手册甲').status, 'stale');
      assert.ok(partial.citations.find(({ title }) => title === '合成手册甲').excerpt == null);
      await marker('partial-checked', {});
      await waitFor('all-unavailable');
      const unavailable = await get(owner, saved.id);
      assert.equal(unavailable.state, 'no_sources');
      assert.deepEqual(unavailable.claims, []);
      assert.equal(unavailable.citations.find(({ title }) => title === '合成手册乙').status, 'unavailable');
      await request('/privacy/account-erasure', 204, { method: 'POST', actor: owner,
        body: { currentPassword: owner.credentials.password, confirmation: 'DELETE' } });
      await get(owner, saved.id, 401);
      await marker('check-erasure', { answerId: saved.id, accountId: owner.id });
    }
    console.log(JSON.stringify({ supportedEvidence: true, missingEvidence: true, accountIsolation: true,
      ...(directory ? { staleSource: true, partialAnswer: true, removedSource: true, erasedAccount: true } : {}) }));
  }
} finally {
  await Promise.all(accounts.map((actor) => request('/auth/logout', 204, { actor, method: 'POST' }).catch(() => {})));
}
