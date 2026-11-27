import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AssistantClient } from '../packages/contracts/dist/index.js';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18090');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) {
  throw new Error('Use a loopback test server.');
}

const client = new AssistantClient({ origin: origin.origin });
const session = await client.register({
  username: `qa-model-${randomUUID().slice(0, 12)}`,
  password: `Qa-${randomUUID()}`,
});
await client.replaceSession(session);

async function completed(runId) {
  const expiresAt = Date.now() + 25_000;
  while (Date.now() < expiresAt) {
    const current = await client.getRunSnapshot(runId);
    if (['completed', 'failed', 'cancelled'].includes(current.state)) {
      assert.equal(current.state, 'completed');
      return current;
    }
    await delay(120);
  }
  assert.fail('The context probe did not complete generation.');
}

try {
  const { models } = await client.listModels();
  const local = models.find(({ id }) => id === 'local-echo');
  assert.equal(local.contextBudget, 32_768);
  assert.equal(local.tier, 'standard');
  assert.ok(!models.some(({ id }) => id === 'retired-echo'));
  const { id } = await client.createConversation({ title: 'QA model retirement' });

  const previous = await client.startRun(id, { action: 'send', content: '旧分支', modelId: local.id }, randomUUID());
  const original = await completed(previous.runId);
  assert.equal(original.context.trimmed, false);
  assert.equal(original.modelVersion, local.version);
  const unknown = { action: 'send', content: '无法使用的模型', modelId: 'unknown-echo' };
  await assert.rejects(() => client.startRun(id, unknown, randomUUID()), { status: 503, code: 'PROVIDER_UNAVAILABLE' });
  assert.equal((await client.listMessages(id)).items.length, 2, 'Unavailable models must not write prompts.');

  let parentId = original.messageId;
  for (const symbol of ['🧪', '🙂', '長', '甲']) {
    const content = symbol.repeat(8_000);
    const queued = await client.startRun(id, { action: 'send', content, parentId, modelId: local.id }, randomUUID());
    const stopped = await client.cancelRun(queued.runId);
    assert.equal(stopped.state, 'cancelled');
    const { items } = await client.listMessages(id);
    const prompt = items.find((item) => item.role === 'user' && item.content === content);
    assert.equal(prompt.parentId, parentId);
    parentId = prompt.id;
  }

  const content = '接續'.repeat(500);
  const request = { action: 'send', parentId, content, modelId: 'retired-echo' };
  const key = randomUUID();
  const next = await client.startRun(id, request, key);
  assert.equal(next.modelId, local.id);
  assert.equal(next.fallbackFromModelId, 'retired-echo');
  assert.deepEqual(next.context, { budget: 32_768, used: 25_000, turns: 4, trimmed: true });
  const finished = await completed(next.runId);
  assert.ok(finished.content.endsWith(content));
  assert.deepEqual(await client.startRun(id, request, key), finished);
  const { items } = await client.listMessages(id);
  const finalMessage = items.find(({ id: messageId }) => finished.messageId === messageId);
  assert.deepEqual(finalMessage.generation, {
    modelId: local.id, modelVersion: local.version, context: next.context, fallbackFromModelId: 'retired-echo',
  });
  assert.equal(items.find(({ id: messageId }) => original.messageId === messageId).generation.modelVersion, original.modelVersion);
  console.log(JSON.stringify({ suite: 'assistant-model-context', status: 'passed' }));
} finally {
  await client.logout();
}
