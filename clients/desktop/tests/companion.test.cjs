const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { createServer } = require('node:http');
const { DesktopCompanionClient } = require('../src/companion-client.cjs');
const { CompanionWorkbench } = require('../src/companion-workbench.cjs');

function fixture() {
  const pair = { id: randomUUID(), state: 'active' };
  const project = { id: randomUUID(), revision: 1, reviewed: 1, revisions: [{ sha256: 'a'.repeat(64) }] };
  let task;
  let builds = 0;
  const withdrawals = [];
  const defaultView = () => ({ configured: true, signedIn: client.authenticated, audit: [],
    pair: client.authenticated ? pair : undefined, task });
  const client = {
    authenticated: true,
    state: async () => defaultView(),
    publish: async (id, scope) => {
      assert.equal(id, pair.id);
      task = { id: randomUUID(), status: 'pending', ...scope };
      return defaultView();
    },
    withdraw: async (id, taskId) => { assert.equal(id, pair.id); withdrawals.push(taskId); task = undefined; },
    consume: async (id, taskId, scope) => {
      assert.equal(id, pair.id);
      assert.equal(taskId, task.id);
      assert.deepEqual(scope, { scopeId: project.id, revision: project.revision, sourceSha256: project.revisions.at(-1).sha256 });
      task.status = 'consumed';
    },
    signOut: async () => { client.authenticated = false; task = undefined; },
  };
  const host = new CompanionWorkbench({ snapshot: () => project, build: () => ++builds }, client);
  return { host, client, project, nextRevision: () => { project.revision++; project.reviewed = null; host.sourceChanged(); },
    approve: () => { task.status = 'approved'; }, builds: () => builds, withdrawals };
}

test('companion admits only an explicitly configured loopback HTTP origin', () => {
  const legitimate = ['http://127.0.0.1:18136', 'http://127.0.0.1:18136/'];
  const rejected = [undefined, 'https://public.example:8443', 'http://127.0.0.1:18136/path',
    'http://test@127.0.0.1:18136', 'http://127.0.0.1:18136/?q=1', 'http://localhost:18136',
    'http://0177.0.0.1:18136', 'http://127.0.0.1:18136/./'];
  for (const origin of legitimate) assert.equal(new DesktopCompanionClient(origin).configured, true);
  for (const origin of rejected) assert.equal(new DesktopCompanionClient(origin).configured, false);
});

test('native companion transport never follows an HTTP redirect or accepts oversized responses', async (context) => {
  let redirectsFollowed = 0;
  let attempt = 0;
  const server = createServer((request, response) => {
    request.resume();
    if (request.url === '/unexpected') redirectsFollowed++;
    if (attempt++ === 0) {
      response.writeHead(307, { Location: '/unexpected' });
      response.end();
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify('x'.repeat(20000)));
    }
  }).listen(0, '127.0.0.1');
  context.after(() => { server.close(); });
  await once(server, 'listening');
  const client = new DesktopCompanionClient(`http://127.0.0.1:${server.address().port}`);
  await assert.rejects(client.signIn('qa-owner', 'Synthetic-local-password'), /暂不可用/);
  await assert.rejects(client.signIn('qa-owner', 'Synthetic-local-password'), /暂不可用/);
  assert.equal(redirectsFollowed, 0);
  assert.equal(client.authenticated, false);
});

test('an explicit desktop action consumes the exact current approval once', async () => {
  const { host, approve, builds } = fixture();
  await assert.rejects(host.perform('companionBuild'), /没有有效的手机批准/);
  await host.perform('companionPublish');
  approve();
  assert.equal(builds(), 0);
  await host.perform('companionBuild');
  assert.equal(builds(), 1);
  await assert.rejects(host.perform('companionBuild'), /没有有效的手机批准/);
});

test('a source change while consumption is in flight withdraws the exact old task and skips local validation', async () => {
  const { host, client, nextRevision, approve, builds, withdrawals } = fixture();
  const { task } = await host.perform('companionPublish');
  approve();
  let signalEntered;
  let release;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  const inFlight = new Promise((resolve) => { release = resolve; });
  client.consume = async () => { signalEntered(); await inFlight; };
  const validation = host.perform('companionBuild');
  await entered;
  nextRevision();
  release();
  await assert.rejects(validation, /授权或当前本地修订已变化/);
  assert.equal(builds(), 0);
  assert.deepEqual(withdrawals, [task.id]);
});

test('failure to withdraw stale authority ends the local session before any later heartbeat', async () => {
  const { host, client, nextRevision, builds } = fixture();
  await host.perform('companionPublish');
  client.withdraw = async () => { throw new Error('offline'); };
  nextRevision();
  assert.equal((await host.perform('companionState')).signedIn, false);
  assert.equal(builds(), 0);
});
