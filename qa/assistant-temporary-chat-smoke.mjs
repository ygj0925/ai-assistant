import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const [address, mode = 'enabled'] = process.argv.slice(2);
const origin = new URL(address);
assert.ok(['http:', 'https:'].includes(origin.protocol) &&
  ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) &&
  origin.port !== '' && !['18080', '18090'].includes(origin.port) && origin.pathname === '/' &&
  !origin.username && !origin.password && !origin.search && !origin.hash,
'Use a dedicated loopback fixture.');
assert.ok(['enabled', 'disabled'].includes(mode));

async function request(path, status, { actor, method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.accessToken;
    headers['X-Workspace-Id'] = actor.user.workspaceId;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL('/api/assistant/v1' + path, origin), {
    method, body, headers, redirect: 'error', signal: AbortSignal.timeout(9000),
  });
  assert.equal(response.status, status, method + ' ' + path);
  if (path === '/temporary-chat') assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  return status === 204 ? undefined : response.json();
}

const prompt = 'Qa.temporary.只在内存𠮷.' + randomUUID();
const send = (status, body, actor) => request('/temporary-chat', status, { actor, method: 'POST', body });
await send(401, JSON.stringify({ content: prompt }));
const actor = await request('/auth/register', 201, {
  method: 'POST',
  body: JSON.stringify({ username: 'qa-temp-' + randomUUID().slice(0, 12), password: 'Qa.temp-' + randomUUID() }),
});
try {
  const guest = await request('/capabilities', 200);
  assert.equal(guest.capabilities.find(({ id }) => id === 'temporary_chat')?.available, false);
  const signedIn = await request('/capabilities', 200, { actor });
  assert.equal(signedIn.capabilities.find(({ id }) => id === 'temporary_chat')?.available, mode === 'enabled');
  if (mode === 'disabled') {
    assert.equal((await send(403, JSON.stringify({ content: prompt }), actor)).code, 'CAPABILITY_UNAVAILABLE');
  } else {
    const useBefore = await request('/usage', 200, { actor });
    const historyBefore = await request('/conversations', 200, { actor });
    const otherWorkspace = { ...actor, user: { workspaceId: randomUUID() } };
    assert.equal((await send(403, JSON.stringify({ content: prompt }), otherWorkspace)).code, 'FORBIDDEN');
    for (const invalid of [
      '{}', '{"content":" "}', '{"content":"a","content":"b"}', '{"content":"a"} true',
      '{"content":"\\ud800"}', '{"content":"a","modelId":"remote"}',
      JSON.stringify({ content: '𠮷'.repeat(513) }), ' '.repeat(8192) + '{"content":"a"}',
    ]) {
      const failure = await send(400, invalid, actor);
      assert.equal(failure.code, 'VALIDATION_ERROR');
      assert.ok(!failure.message.includes(prompt));
    }
    assert.deepEqual(await send(200, JSON.stringify({ content: prompt }), actor), {
      content: '本地模拟回复：' + prompt, modelId: 'local-echo',
    });
    assert.deepEqual(await request('/usage', 200, { actor }), useBefore);
    assert.deepEqual(await request('/conversations', 200, { actor }), historyBefore);
    const searched = await request('/conversations?q=' + encodeURIComponent(prompt), 200, { actor });
    assert.deepEqual(searched.items, []);
    const exported = await request('/privacy/export', 200, { actor });
    assert.ok(!JSON.stringify(exported).includes(prompt));
  }
  console.log(JSON.stringify({ mode, temporaryChat: 'passed', persistence: mode === 'enabled' ? 'history,ledger,export unchanged' : 'disabled' }));
} finally {
  await request('/auth/logout', 204, { actor, method: 'POST' });
}
