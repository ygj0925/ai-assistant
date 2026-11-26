import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [sourceInput, targetInput, directory] = process.argv.slice(2);
assert.ok(directory, 'Pass a new verification directory.');

function loopback(input) {
  const url = new URL(input);
  assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.port !== '18080'
    && url.href === url.origin + '/', 'Use isolated synthetic loopback fixtures.');
  return url.origin;
}

const source = loopback(sourceInput);
const target = loopback(targetInput);
assert.notEqual(source, target);
const evidence = resolve(directory);
await mkdir(evidence, { recursive: true });

async function mark(name, value = {}) {
  await writeFile(resolve(evidence, name + '.json'), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

async function waitFor(name) {
  const marker = resolve(evidence, name + '.json');
  const until = Date.now() + 360_000;
  while (Date.now() < until) {
    try {
      await access(marker);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await delay(250);
    }
  }
  assert.fail('Checkpoint timed out: ' + name);
}

async function request(base, path, expected, { method = 'GET', body, session } = {}) {
  const headers = new Headers({ Accept: 'application/json' });
  if (session) {
    headers.set('Authorization', 'Bearer ' + session.accessToken);
    headers.set('X-Workspace-Id', session.user.workspaceId);
  }
  if (body) headers.set('Content-Type', 'application/json');
  const response = await fetch(base + '/api/assistant/v1' + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, expected, method + ' ' + path);
  if (response.status === 204) return undefined;
  return response.json();
}

const credentials = { username: 'qa-session-' + randomUUID().slice(0, 12), password: 'Qa.Local-' + randomUUID() };
const owner = await request(source, '/auth/register', 201, { method: 'POST', body: credentials });
const oldDevice = await request(source, '/auth/login', 200, { method: 'POST', body: credentials });
const initial = await request(source, '/conversations', 201, {
  session: owner, method: 'POST', body: { title: '恢复后需要重新登录的合成记录' },
});
assert.equal((await request(source, '/auth/me', 200, { session: oldDevice })).id, owner.user.id);
await mark('backup-ready', { accountId: owner.user.id, conversationId: initial.id });
await waitFor('backup-done');

await request(source, '/auth/logout', 204, { session: oldDevice, method: 'POST' });
assert.equal((await request(source, '/auth/me', 401, { session: oldDevice })).code, 'UNAUTHENTICATED');
assert.deepEqual(await request(source, '/conversations/' + initial.id, 200, { session: owner }), initial);
await mark('restore-ready');
await waitFor('restore-done');

for (const session of [owner, oldDevice]) {
  assert.equal((await request(target, '/auth/me', 401, { session })).code, 'UNAUTHENTICATED');
  assert.equal((await request(target, '/conversations/' + initial.id, 401, { session })).code, 'UNAUTHENTICATED');
}
const fresh = await request(target, '/auth/login', 200, { method: 'POST', body: credentials });
assert.equal(fresh.user.id, owner.user.id);
assert.notEqual(fresh.accessToken, owner.accessToken);
assert.notEqual(fresh.accessToken, oldDevice.accessToken);
assert.deepEqual(await request(target, '/conversations/' + initial.id, 200, { session: fresh }), initial);
const devices = await request(target, '/auth/devices', 200, { session: fresh });
assert.equal(devices.length, 1);
assert.equal(devices[0].current, true);
await request(target, '/auth/logout', 204, { session: fresh, method: 'POST' });
await mark('summary', { passed: true, oldDevicesRejected: 2, freshLogin: true, exactConversationPreserved: true,
  activeDeviceCountAfterReauthentication: 1 });
