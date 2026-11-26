import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AssistantApiError, AssistantClient } from '../packages/contracts/dist/index.js';

const [sourceInput, mode = 'normal', directory, restoreInput] = process.argv.slice(2);
assert.ok(['normal', 'disabled', 'restore'].includes(mode), 'Unsupported test mode');

function loopback(value) {
  const origin = new URL(value);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && origin.protocol === 'http:'
    && origin.href === origin.origin + '/', 'Use an isolated HTTP loopback API');
  return origin.origin;
}

const source = loopback(sourceInput);
const restore = mode === 'restore' ? loopback(restoreInput) : undefined;
const evidence = directory ? resolve(directory) : undefined;
if (restore) {
  assert.notEqual(source, restore);
  await access(evidence);
}

async function writeEvidence(name, data) {
  const path = join(evidence, name + '.json');
  await writeFile(path + '.tmp', JSON.stringify(data) + '\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

async function waitForFile(name) {
  const deadline = Date.now() + 240_000;
  for (;;) {
    try { await access(join(evidence, name + '.json')); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(Date.now() < deadline, 'Timed out awaiting ' + name);
    await delay(150);
  }
}

async function waitForRun(client, runId, state) {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const run = await client.getRunSnapshot(runId);
    if (run.state === state) return run;
    assert.ok(['queued', 'running'].includes(run.state), 'Unexpected terminal state: ' + run.state);
    assert.ok(Date.now() < deadline, 'Timed out awaiting ' + state);
    await delay(50);
  }
}

const credentials = { username: 'qa-pmem-' + randomUUID().slice(0, 10), password: 'Qa.Provenance-' + randomUUID() };
const client = new AssistantClient({ origin: source });
const session = await client.register(credentials);
await client.replaceSession(session);
const project = await client.createProject({ name: '合成项目记忆' });
const secondary = await client.createProject({ name: '隔离的合成项目记忆' });
await client.updateMemorySettings({ enabled: true }, project.id);
await client.updateMemorySettings({ enabled: true }, secondary.id);
const longText = '🦀'.repeat(120) + '超出显示范围';
const deletion = await client.createMemory(longText, project.id);
const retention = await client.createMemory('未撤回的合成项目记忆', project.id);
const secondaryEntry = await client.createMemory('独立项目条目', secondary.id);

async function completedIn(projectId, title) {
  const { id } = await client.createConversation({ title, projectId });
  const { runId } = await client.startRun(id, { action: 'send', modelId: 'local-echo',
    content: '核对来源与撤回。' }, randomUUID());
  await waitForRun(client, runId, 'completed');
  const reply = (await client.listMessages(id)).items.find(({ role }) => role === 'assistant');
  assert.ok(reply);
  assert.equal(reply.generation.projectMemorySourcesUsed, mode === 'disabled' ? undefined : true);
  assert.doesNotMatch(reply.content, /未撤回的合成项目记忆|独立项目条目|超出显示范围/);
  return { id, reply: reply.id, runId };
}

const record = await completedIn(project.id, '记忆撤回合成样例');
const review = (item, api = client) => api.getMessageProjectMemorySources(item.id, item.reply);
const status = (code) => (failure) => failure instanceof AssistantApiError && failure.status === code;
if (mode === 'disabled') {
  await assert.rejects(review(record), status(404));
  console.log(JSON.stringify({ mode, ordinaryGeneration: true, noReceipt: true }));
} else {
  const moved = await completedIn(project.id, '对话归属迁移合成样例');
  const locked = await completedIn(project.id, '阅读锁合成样例');
  const opted = await completedIn(secondary.id, '记忆退出与同意合成样例');
  const { items } = await review(record);
  assert.equal(items.length, 2);
  assert.deepEqual(items.find(({ entryId }) => entryId === deletion.id),
    { status: 'available', entryId: deletion.id, excerpt: '🦀'.repeat(120) });
  assert.ok(items.some(({ entryId }) => entryId === retention.id));
  assert.deepEqual((await review(opted)).items, [
    { status: 'available', entryId: secondaryEntry.id, excerpt: '独立项目条目' },
  ]);

  if (restore) {
    await writeEvidence('backup-ready', { record, moved, locked, opted, removalId: deletion.id });
    await waitForFile('backup-done');
  }

  await client.deleteMemory(deletion.id, project.id);
  await client.moveConversation(moved.id, secondary.id);
  assert.ok((await review(moved)).items.every(({ status }) => status === 'unavailable'));
  await client.moveConversation(moved.id, project.id);
  await client.lockConversationReading(locked.id);
  await assert.rejects(review(locked), status(423));
  await client.unlockConversationReading(locked.id, credentials.password);
  await client.updateMemorySettings({ enabled: false }, secondary.id);
  await client.updateMemorySettings({ enabled: true }, secondary.id);

  async function checkWithdrawal(api) {
    const remaining = await review(record, api);
    assert.deepEqual(remaining.items.find(({ status }) => status === 'unavailable'), { status: 'unavailable' });
    assert.ok(remaining.items.some(({ entryId }) => entryId === retention.id));
    assert.ok(!JSON.stringify(remaining).includes(deletion.id));
    for (const old of [moved, locked, opted]) {
      const oldSources = await review(old, api);
      assert.ok(oldSources.items.length > 0);
      assert.ok(oldSources.items.every((item) => Object.keys(item).length === 1 && item.status === 'unavailable'));
    }
  }
  await checkWithdrawal(client);
  const { id: inFlight } = await client.createConversation({ title: '运行中迁移合成样例', projectId: project.id });
  const { runId } = await client.startRun(inFlight, {
    action: 'send', modelId: 'local-echo', content: '合成分段。'.repeat(600),
  }, randomUUID());
  await waitForRun(client, runId, 'running');
  await delay(250);
  await client.moveConversation(inFlight, secondary.id);
  await client.moveConversation(inFlight, project.id);
  assert.equal((await waitForRun(client, runId, 'cancelled')).content, '');
  assert.ok((await client.listMessages(inFlight)).items.every(({ role }) => role !== 'assistant'));
  if (restore) {
    await writeEvidence('restore-ready', { cancelledRun: runId });
    await waitForFile('restore-done');
    const copy = new AssistantClient({ origin: restore });
    await copy.replaceSession(session);
    await checkWithdrawal(copy);
  }

  const result = { mode, exactUsedSources: true, unicodeExcerptLimit: 120, oldIdentifierScrubbed: true,
    unaffectedSourceRetained: true, scopeAndConsentFences: true, inFlightMoveRoundTripCancelled: true,
    restoredWithdrawal: !!restore };
  if (evidence) await writeEvidence('summary', result);
  console.log(JSON.stringify(result));
}
