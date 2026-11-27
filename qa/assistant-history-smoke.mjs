import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssistantClient } from '../packages/contracts/dist/index.js';
import { resolveBackend } from './backend-checkout.mjs';

const origin = 'http://127.0.0.1:18090';
const backend = resolveBackend(fileURLToPath(new URL('..', import.meta.url)));
const owner = new AssistantClient({ origin });
const stranger = new AssistantClient({ origin });
const password = `qa-${randomUUID()}`;
const title = `qa-history-${randomUUID()}`;

async function createSession(client) {
  const session = await client.register({ username: `history-${randomUUID().slice(0, 12)}`, password });
  await client.replaceSession(session);
}

await createSession(owner);
await createSession(stranger);
const conversation = await owner.createConversation({ title });
try {
  execFileSync('java', [
    '--class-path', 'config;lib/*',
    fileURLToPath(new URL('./AssistantMessageFixture.java', import.meta.url)),
    conversation.id, title,
  ], { cwd: join(backend, 'continew-server', 'target', 'app') });

  for (const q of ['简体检索', '繁體檢索', 'mercury', '100%']) {
    const ownerResults = await owner.listConversations({ q });
    const strangerResults = await stranger.listConversations({ q });
    assert.ok(ownerResults.items.some((item) => item.id === conversation.id));
    assert.ok(!strangerResults.items.some((item) => item.id === conversation.id));
  }
  const first = await owner.listMessages(conversation.id, { limit: 1 });
  assert.ok(first.nextCursor);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].parentId, null);
  const next = await owner.listMessages(conversation.id, { limit: 1, cursor: first.nextCursor });
  assert.equal(next.nextCursor, null);
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0].parentId, first.items[0].id);
  await assert.rejects(() => stranger.listMessages(conversation.id), { status: 404, code: 'NOT_FOUND' });

  await owner.deleteConversation(conversation.id);
  const afterDelete = await owner.listConversations({ q: '简体检索' });
  assert.ok(!afterDelete.items.some((item) => item.id === conversation.id));
  await assert.rejects(() => owner.listMessages(conversation.id), { status: 404, code: 'NOT_FOUND' });
} finally {
  await Promise.allSettled([owner.logout(), stranger.logout()]);
}
console.log(JSON.stringify({ suite: 'assistant-history', status: 'passed' }));
