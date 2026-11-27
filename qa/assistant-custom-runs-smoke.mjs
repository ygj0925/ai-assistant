import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AssistantClient } from '../packages/contracts/dist/index.js';

const origin = new URL(process.argv[2]);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && origin.port
  && !['18080', '18090'].includes(origin.port), 'Use a dedicated loopback API.');
const modelId = 'local-echo';

async function account() {
  const client = new AssistantClient({ origin: origin.origin });
  const session = await client.register({ username: `qa-custom-run-${randomUUID().slice(0, 12)}`,
    password: `Qa.CustomRun!${randomUUID()}` });
  await client.replaceSession(session);
  return client;
}

function checkStatus(status) {
  return (error) => error.status === status;
}

function command(assistant, content) {
  return { action: 'send', modelId, content,
    customAssistant: { id: assistant.id, versionId: assistant.head.id } };
}

async function state(client, runId, ...wanted) {
  const ends = Date.now() + 24_000;
  do {
    const run = await client.getRunSnapshot(runId);
    if (wanted.includes(run.state)) return run;
    assert.ok(['queued', 'running'].includes(run.state), JSON.stringify({ state: run.state, error: run.error }));
    await delay(150);
  } while (Date.now() < ends);
  assert.fail(`Run did not reach ${wanted.join(', ')}.`);
}

const owner = await account();
const outsider = await account();
const features = await owner.getCapabilities();
assert.ok(features.capabilities.some(({ id, available }) => id === 'local_custom_assistant_runs' && available));
const project = await owner.createProject({ name: '合成定制运行项目' });
const elsewhere = await owner.createProject({ name: '隔离样本项目' });
const linked = await owner.createProjectResource(project.id,
  { name: '可检索合成资料', content: '合成标记：允许给这一版本使用的样本文字' });
const hidden = await owner.createProjectResource(elsewhere.id,
  { name: '其他项目资料', content: '合成标记：CROSS_SCOPE_PRIVATE_FIXTURE' });
const conversation = await owner.createConversation({ title: '定制运行', projectId: project.id });
const otherConversation = await outsider.createConversation({ title: '另一账号的对话' });
const noProject = await owner.createConversation({ title: '未归类对话' });
const definition = { name: '私有样本助手', instructions: '格式：项目符号',
  resourceIds: [linked.id], tools: ['project_resource_lookup'] };
const v1 = await owner.createCustomAssistant({ ...definition, projectId: project.id }, randomUUID());
await assert.rejects(owner.createCustomAssistant({ ...definition, projectId: project.id,
  resourceIds: [hidden.id] }, randomUUID()), checkStatus(404));
const prompt = command(v1, '合成标记');
await assert.rejects(owner.startRun(noProject.id, prompt, randomUUID()), checkStatus(404));
await assert.rejects(outsider.startRun(otherConversation.id, prompt, randomUUID()), checkStatus(404));

const key = randomUUID();
const initial = await owner.startRun(conversation.id, prompt, key);
const finished = await state(owner, initial.runId, 'completed');
assert.deepEqual(finished.customAssistant, prompt.customAssistant);
assert.equal(finished.content, '本地定制助手（项目资料命中 1 项）：\n- 合成标记');
assert.ok(finished.context.used > [...prompt.content].length);
assert.equal((await owner.startRun(conversation.id, prompt, key)).runId, initial.runId);

const noTool = await owner.createCustomAssistantVersion(v1.id,
  { ...definition, baseVersionId: v1.head.id, tools: [] });
await assert.rejects(owner.startRun(conversation.id, prompt, randomUUID()), checkStatus(409));
await assert.rejects(owner.startRun(conversation.id, command(noTool, prompt.content), key), checkStatus(409));
const noLookup = await owner.startRun(conversation.id, command(noTool, prompt.content), randomUUID());
assert.equal((await state(owner, noLookup.runId, 'completed')).content,
  '本地定制助手（项目资料命中 0 项）：\n- 合成标记');
const current = await owner.rollbackCustomAssistant(v1.id,
  { baseVersionId: noTool.head.id, versionId: v1.head.id });
assert.notEqual(current.head.id, v1.head.id);
assert.equal(current.head.restoredFromVersionId, v1.head.id);

const before = await owner.getUsage();
const active = await owner.startRun(conversation.id, command(current, '合成撤权场景'.repeat(120)), randomUUID());
await state(owner, active.runId, 'running');
await delay(600);
await owner.deleteProjectResource(project.id, linked.id);
const cancelled = await state(owner, active.runId, 'cancelled');
assert.equal(cancelled.content, '');
assert.equal(cancelled.messageId, undefined);
const events = [];
for await (const event of owner.openRunEvents(active.runId, { signal: AbortSignal.timeout(8_000) })) {
  events.push(event.type);
}
assert.deepEqual(events, ['run.started', 'run.cancelled']);
const settled = await owner.getUsage();
assert.equal(settled.used, before.used);
assert.equal(settled.reserved, 0);
await assert.rejects(owner.startRun(conversation.id, command(current, '合成标记'), randomUUID()), checkStatus(404));

const standard = await owner.startRun(conversation.id, { action: 'send', modelId, content: '通用回复' }, randomUUID());
const standardResult = await state(owner, standard.runId, 'completed');
assert.equal(standardResult.content, '本地模拟回复：通用回复');
assert.equal(standardResult.customAssistant, undefined);
await owner.deleteCustomAssistant(current.id);
console.log(JSON.stringify({ exactProject: true, instructionsApplied: true, lookupDenyByDefault: true,
  idempotentBinding: true, rollbackNewVersion: true, inFlightRevocationNoDelta: true, reservationReleased: true,
  ordinaryRunUnaffected: true }));
