import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const base = '/custom-assistants';
const replayIndex = process.argv.indexOf('--replay');
const evidence = replayIndex < 0 ? undefined : process.argv[replayIndex + 1];
const restored = evidence ? isolated(process.argv[replayIndex + 2]) : undefined;
let api = isolated(process.argv[2]);
const sessions = [];

function isolated(address) {
  const parsed = new URL(address);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) && parsed.port,
    'Use an isolated loopback fixture.');
  assert.notEqual(parsed.port, '18080');
  return parsed;
}

async function request(route, expected, { actor, workspace, method = 'GET', body, key } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) headers.Authorization = `Bearer ${actor.token}`;
  if (workspace ?? actor?.workspace) headers['X-Workspace-Id'] = workspace ?? actor.workspace;
  if (key) headers['Idempotency-Key'] = key;
  if (body) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(`/api/assistant/v1${route}`, api), {
    method, headers, body: body ? JSON.stringify(body) : undefined,
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  const output = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  assert.equal(response.status, expected, `${method} ${route} ${output?.code ?? ''}`);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
  return output;
}

async function register() {
  const credentials = { username: `qa-custom-${randomUUID().slice(0, 12)}`, password: `Qa.Custom!${randomUUID()}` };
  const response = await request('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { token: response.accessToken, workspace: response.user.workspaceId,
    account: response.user.id, credentials };
  sessions.push(actor);
  return actor;
}

const create = (actor, body, key = randomUUID(), status = 201) =>
  request(base, status, { actor, body, key, method: 'POST' });
const revise = (actor, assistant, body, status = 201) =>
  request(`${base}/${assistant.id}/versions`, status, { actor, method: 'POST', body });
const rollback = (actor, assistant, versionId, status = 201) =>
  request(`${base}/${assistant.id}/rollback`, status, {
    actor, method: 'POST', body: { baseVersionId: assistant.head.id, versionId },
  });

async function waitForMarker(name) {
  const deadline = Date.now() + 270_000;
  do {
    try {
      await access(join(evidence, name));
      return;
    } catch (failure) {
      if (failure.code !== 'ENOENT') throw failure;
    }
    await delay(200);
  } while (Date.now() < deadline);
  assert.fail(`Restore fixture did not publish ${name}.`);
}

async function replay(owner) {
  assert.notEqual(restored.port, api.port);
  const oldDefinition = { name: 'Synthetic pre-snapshot assistant', instructions: 'Original version' };
  const retained = await create(owner, oldDefinition);
  await writeFile(join(evidence, 'backup-ready.json'),
    JSON.stringify({ assistantId: retained.id, workspaceId: owner.workspace, accountId: owner.account }), { flag: 'wx' });
  await waitForMarker('backup-done');
  const changed = await revise(owner, retained, { baseVersionId: retained.head.id, name: 'Edited after backup',
    instructions: 'Updated definition' });
  assert.equal(changed.head.number, 2);
  const key = randomUUID();
  const deletedDefinition = { name: 'Synthetic post-snapshot revoked', instructions: 'Delete this definition' };
  const removed = await create(owner, deletedDefinition, key);
  await request(`${base}/${removed.id}`, 204, { actor: owner, method: 'DELETE' });
  await writeFile(join(evidence, 'deletion-ready.json'), '{}', { flag: 'wx' });
  await waitForMarker('restore-done');
  api = restored;
  const outdated = await request(`${base}/${retained.id}`, 200, { actor: owner });
  assert.equal(outdated.status, 'requires_review');
  assert.equal(outdated.head.id, retained.head.id);
  await request(`${base}/${removed.id}`, 404, { actor: owner });
  await create(owner, deletedDefinition, key, 404);
  const approved = await revise(owner, outdated, {
    baseVersionId: outdated.head.id, name: 'Explicitly reviewed after restore', instructions: '',
  });
  assert.equal(approved.status, 'active');
  assert.notEqual(approved.head.id, changed.head.id);
  console.log(JSON.stringify({ staleHead: 'requires-review', permanentDeletion: 'retained',
    sameCreateKey: 'denied', explicitReactivation: 'passed' }));
}

async function normal(owner) {
  const outsider = await register();
  const { capabilities } = await request('/capabilities', 200, { actor: owner });
  assert.equal(capabilities.find(({ id }) => id === 'custom_assistants')?.available, true);
  await request(base, 401);
  const project = await request('/projects', 201, { actor: owner, method: 'POST', body: { name: 'Owned reference scope' } });
  const separate = await request('/projects', 201, { actor: owner, method: 'POST', body: { name: 'Separate project' } });
  const root = `/projects/${project.id}/resources`;
  const data = 'Synthetic private knowledge bytes should stay out of registry export';
  const primary = await request(root, 201, { actor: owner, method: 'POST', body: { name: 'Owner source', content: data } });
  const next = await request(root, 201, { actor: owner, method: 'POST', body: { name: 'Replacement source', content: 'Replacement private bytes' } });
  const draft = { name: '自定义助理 🦀', instructions: '第一行指令\n第二行指令',
    resourceIds: [primary.id], tools: ['project_resource_lookup'] };
  const input = { ...draft, projectId: project.id };
  const key = randomUUID();
  await create(owner, { ...input, tools: ['arbitrary_network'] }, randomUUID(), 400);
  await create(owner, { ...draft }, randomUUID(), 400);
  await create(owner, { ...input, projectId: separate.id }, randomUUID(), 404);
  await create(outsider, input, randomUUID(), 404);
  const first = await create(owner, input, key);
  assert.equal(first.head.number, 1);
  assert.equal(first.status, 'active');
  assert.equal(first.projectId, project.id);
  assert.deepEqual(first.head.resourceIds, [primary.id]);
  assert.deepEqual(first.head.tools, draft.tools);
  assert.equal((await create(owner, input, key)).id, first.id);
  await create(owner, { ...input, instructions: 'Changed request' }, key, 409);
  await request(`${base}/${first.id}`, 404, { actor: outsider });
  await request(`${base}/${first.id}/versions`, 403, { actor: owner, workspace: outsider.workspace });

  const second = await revise(owner, first, {
    baseVersionId: first.head.id, name: draft.name, instructions: '第二版',
    resourceIds: [next.id], tools: [],
  });
  assert.equal(second.head.number, 2);
  await revise(owner, first, { baseVersionId: first.head.id, name: draft.name, instructions: '' }, 409);
  const third = await rollback(owner, second, first.head.id);
  assert.equal(third.head.number, 3);
  assert.equal(third.head.restoredFromVersionId, first.head.id);
  assert.equal(third.head.instructions, draft.instructions);
  assert.deepEqual(third.head.resourceIds, [primary.id]);
  const history = await request(`${base}/${first.id}/versions`, 200, { actor: owner });
  assert.deepEqual(history.items.map(({ number }) => number), [3, 2, 1]);
  assert.equal(history.nextCursor, null);
  assert.ok(!JSON.stringify(history).includes(data));
  assert.equal((await request(`${base}/${first.id}/versions/${first.head.id}`, 200, { actor: owner })).instructions,
    draft.instructions);
  await request(`${root}/${primary.id}`, 204, { actor: owner, method: 'DELETE' });
  await rollback(owner, third, first.head.id, 404);
  assert.equal((await request(`${base}/${first.id}`, 200, { actor: owner })).head.id, third.head.id);
  await request(`${base}/${first.id}`, 204, { actor: owner, method: 'DELETE' });
  await request(`${base}/${first.id}/versions`, 404, { actor: owner });
  await create(owner, input, key, 404);

  const accountEraseFixture = await create(owner, { ...input, resourceIds: [next.id] });
  assert.deepEqual((await request(base, 200, { actor: owner })).items.map(({ id }) => id), [accountEraseFixture.id]);
  assert.deepEqual((await request(base, 200, { actor: outsider })).items, []);
  await request('/privacy/account-erasure', 204, {
    actor: owner, method: 'POST', body: { currentPassword: owner.credentials.password, confirmation: 'DELETE' },
  });
  await request(`${base}/${accountEraseFixture.id}`, 401, { actor: owner });
  console.log(JSON.stringify({ immutableVersions: 3, rollback: 'verified', staleCas: 'denied',
    scopes: 'isolated', revokedKnowledgeRollback: 'denied', retiredCreateKey: 'denied',
    accountAndReferenceErasure: 'passed' }));
}

try {
  const owner = await register();
  if (evidence) await replay(owner);
  else await normal(owner);
} finally {
  for (const actor of sessions) {
    await request('/privacy/account-erasure', 204, { actor, method: 'POST',
      body: { currentPassword: actor.credentials.password, confirmation: 'DELETE' } }).catch(() => {});
    await request('/auth/logout', 204, { actor, method: 'POST' }).catch(() => {});
  }
}
