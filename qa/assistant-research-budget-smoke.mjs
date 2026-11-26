import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AssistantClient } from '../packages/contracts/dist/index.js';

const origin = new URL(process.argv[2]);
assert.ok(origin.protocol === 'http:' && origin.href === origin.origin + '/'
  && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Isolated loopback API required');
const client = new AssistantClient({ origin: origin.origin });
const password = 'Qa.Research-budget-' + randomUUID();
await client.replaceSession(await client.register({ username: 'qa-budget-' + randomUUID().slice(0, 10), password }));
const sourceIds = ['ba8f4c14-4979-487a-b6af-eefd5aed2001'];

try {
  const before = await client.getUsage();
  const attempted = await Promise.allSettled(Array.from({ length: 9 }, (_, index) => client.createResearchTask({
    question: '合成并发配额检查 ' + index, sourceIds,
  }, randomUUID())));
  const created = attempted.filter(({ status }) => status === 'fulfilled').map(({ value }) => value);
  const blocked = attempted.filter(({ status }) => status === 'rejected').map(({ reason }) => reason);
  assert.equal(created.length, 8);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].status, 429);
  assert.equal(blocked[0].code, 'RATE_LIMITED');
  assert.equal((await client.listResearchTasks()).items.length, 8);
  assert.ok(created.every(({ state }) => state === 'awaiting_approval'));
  const cancelled = await client.cancelResearchTask(created[0].id, created[0].revision);
  assert.equal(cancelled.state, 'cancelled');
  const replacement = await client.createResearchTask({ question: '已释放的配额', sourceIds }, randomUUID());
  assert.equal(replacement.state, 'awaiting_approval');
  let plan = created[1];
  for (let revision = 1; revision < 16; revision++) {
    plan = await client.reviseResearchTask(plan.id, { expectedRevision: revision,
      question: '有边界的合成修订 ' + (revision + 1), sourceIds });
    assert.equal(plan.revision, revision + 1);
  }
  await assert.rejects(client.reviseResearchTask(plan.id, { expectedRevision: 16,
    question: '不允许的第 17 版', sourceIds }), { status: 409 });
  assert.equal((await client.getResearchTask(plan.id)).revision, 16);
  assert.deepEqual(await client.getUsage(), before);
  console.log(JSON.stringify({ concurrentCreates: 9, admitted: 8, excessDenied: 1,
    cancellationReleasedCapacity: true, maximumRevisions: 16, additionalRevisionDenied: true,
    modelUsageUnchanged: true }));
} finally {
  await client.eraseAccount({ currentPassword: password, confirmation: 'DELETE' });
}
