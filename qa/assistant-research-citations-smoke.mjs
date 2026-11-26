import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AssistantClient } from '../packages/contracts/dist/index.js';

const origin = new URL(process.argv[2]);
assert.ok(origin.protocol === 'http:' && origin.href === origin.origin + '/'
  && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Isolated loopback API required');
const authority = {
  alpha: { id: 'ba8f4c14-4979-487a-b6af-eefd5aed2001', claim: '合成陈述甲',
    url: 'https://evidence.example/alpha', evidence: '预先核查的甲组证据' },
  beta: { id: 'ba8f4c14-4979-487a-b6af-eefd5aed2002', claim: '合成陈述乙',
    url: 'https://evidence.example/beta', evidence: '预先核查的乙组证据' },
};
const stale = 'ba8f4c14-4979-487a-b6af-eefd5aed2003';
const cases = [
  { question: '核对仅获准的甲组陈述', scopes: ['alpha'] },
  { question: '用乙组证据进行独立复核', scopes: ['beta'] },
  { question: '按已批准范围对照两组证据', scopes: ['alpha', 'beta'] },
];
const client = new AssistantClient({ origin: origin.origin });
const username = 'qa-cite-' + randomUUID().slice(0, 10);
const password = 'Qa.Citations-' + randomUUID();
await client.replaceSession(await client.register({ username, password }));

try {
  const catalogue = await client.listResearchSources({ limit: 50 });
  for (const item of Object.values(authority)) assert.ok(catalogue.items.some(({ id }) => id === item.id));
  assert.ok(!catalogue.items.some(({ id }) => id === stale));
  await assert.rejects(client.createResearchTask({ question: '过期来源禁止核查', sourceIds: [stale] }, randomUUID()),
    { status: 409 });
  await assert.rejects(client.createResearchTask({ question: '省略来源禁止核查', sourceIds: [] }, randomUUID()),
    { status: 400 });
  const metrics = await Promise.all(cases.map(async ({ question, scopes }) => {
    const expected = scopes.map((key) => authority[key]);
    const plan = await client.createResearchTask({ question, sourceIds: expected.map(({ id }) => id) }, randomUUID());
    await client.approveResearchTask(plan.id, plan.revision);
    const deadline = Date.now() + 30_000;
    for (;;) {
      const state = await client.getResearchTask(plan.id);
      if (state.reportAvailable) break;
      assert.ok(['queued', 'running'].includes(state.state), 'Unexpected terminal state: ' + state.state);
      assert.ok(Date.now() < deadline, 'Timed out awaiting approved research');
      await delay(250);
    }
    const text = await (await client.downloadResearchReport(plan.id, plan.revision)).text();
    const urls = text.match(/https:\/\/evidence\.example\/[a-z]+/g) ?? [];
    assert.deepEqual([...urls].sort(), expected.map(({ url }) => url).sort());
    assert.ok(text.includes(question));
    for (const { claim, evidence, url } of expected) {
      const claimPosition = text.indexOf(claim);
      const urlPosition = text.indexOf(url);
      const evidencePosition = text.indexOf(evidence);
      assert.ok(claimPosition >= 0 && urlPosition >= 0 && evidencePosition >= 0);
      const start = Math.min(claimPosition, urlPosition, evidencePosition);
      const end = Math.max(claimPosition, urlPosition, evidencePosition);
      const sourceBlock = text.slice(start, end);
      const unrelated = Object.values(authority).find((entry) => entry.url !== url);
      assert.ok(!sourceBlock.includes(unrelated.url) && !sourceBlock.includes(unrelated.claim));
    }
    for (const key of Object.keys(authority).filter((item) => !scopes.includes(item))) {
      assert.ok(!text.includes(authority[key].claim) && !text.includes(authority[key].evidence));
    }
    return expected.length;
  }));
  const exactPairs = metrics.reduce((sum, count) => sum + count, 0);
  console.log(JSON.stringify({ cases: metrics.length, exactCitationPairs: exactPairs, expectedCitationPairs: 4,
    unintendedSources: 0, emptySelectionDenied: true, expiredSelectionDenied: true }));
} finally {
  await client.eraseAccount({ currentPassword: password, confirmation: 'DELETE' });
}
