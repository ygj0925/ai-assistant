import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const terminal = new Set(['completed', 'cancelled', 'failed']);
const terminalEvents = new Set(['run.completed', 'run.cancelled', 'run.failed']);
const round = (value) => Math.round(value * 10) / 10;
const codePoints = (value) => [...value].length;
const syntheticModel = 'local-echo';
const releaseWindowMs = 150_000;

function configuration() {
  const { values } = parseArgs({ options: {
    'api-url': { type: 'string' },
    scenario: { type: 'string', default: 'load' },
    concurrency: { type: 'string', default: '4' },
    waves: { type: 'string', default: '2' },
  } });
  const { scenario } = values;
  if (!['load', 'restart'].includes(scenario)) throw new TypeError('Use --scenario load or restart.');
  if (!values['api-url']) throw new TypeError('Provide --api-url for a dedicated loopback test API.');
  const url = new URL(values['api-url']);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port
    || url.port === '18080' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new TypeError('Use a bare loopback HTTP origin on a dedicated port other than 18080.');
  }
  const concurrency = Number(values.concurrency);
  const waves = Number(values.waves);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8
    || !Number.isInteger(waves) || waves < 1 || waves > 5) {
    throw new TypeError('Use 1–8 concurrent clients and 1–5 waves.');
  }
  return { origin: url.origin, scenario, ...(scenario === 'load' && { concurrency, waves }) };
}

function details(error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    ...(typeof error?.status === 'number' && { status: error.status }),
    ...(typeof error?.code === 'string' && { code: error.code }),
    ...(error instanceof assert.AssertionError && { check: error.message }),
  };
}

function summarise(samples) {
  const successes = samples.filter(({ ok }) => ok).map(({ millis }) => millis).sort((a, b) => a - b);
  const percentile = (proportion) => successes.length ? successes[Math.ceil(proportion * successes.length) - 1] : null;
  const failures = samples.length - successes.length;
  return { attempts: samples.length, failures, errorRate: samples.length ? round(1000 * failures / samples.length) / 1000 : 0,
    p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: successes.at(-1) ?? null };
}

function measurements(report) {
  return async (name, operation) => {
    const start = performance.now();
    try {
      const value = await operation();
      (report.samples[name] ??= []).push({ ok: true, millis: round(performance.now() - start) });
      return value;
    } catch (error) {
      (report.samples[name] ??= []).push({ ok: false, millis: round(performance.now() - start), error: details(error) });
      throw error;
    }
  };
}

async function inspectRun(client, job, { disconnect = false, stopAtFirst = false, previous } = {}) {
  const timeout = AbortSignal.timeout(28_000);
  let cursor = previous?.cursor ?? 0;
  let startedMs;
  let firstDeltaMs;
  let terminalMs;
  let resumedFrom;
  let final;
  let content = previous?.content ?? '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    for await (const event of client.openRunEvents(job.runId, { afterSequence: cursor, signal: timeout })) {
      assert.equal(event.sequence, cursor + 1, 'Event replay must remain contiguous');
      cursor = event.sequence;
      const elapsed = round(performance.now() - job.started);
      if (event.type === 'run.started') startedMs = elapsed;
      if (event.type === 'message.delta') {
        firstDeltaMs ??= elapsed;
        content += event.delta;
        if (stopAtFirst) return { cursor, content, startedMs, firstDeltaMs };
        if (disconnect && resumedFrom === undefined) {
          resumedFrom = cursor;
          break;
        }
      }
      if (terminalEvents.has(event.type)) {
        assert.ok(!final, 'A run must have only one terminal event');
        final = event;
        terminalMs = elapsed;
      }
    }
    if (final) break;
    await delay(120, undefined, { signal: timeout });
  }
  assert.ok(final, 'Expected a terminal SSE event');
  return { cursor, content, startedMs, firstDeltaMs, terminalMs, final, resumedFrom };
}

function proveUsage(before, after, snapshots) {
  const used = snapshots.reduce((total, run) => total + codePoints(run.content), 0);
  assert.equal(after.unit, 'output_code_points', 'Expected output code point ledger');
  assert.equal(BigInt(after.reserved), 0n, 'Terminal runs must release all reservations');
  assert.equal(BigInt(after.used) - BigInt(before.used), BigInt(used), 'Ledger must settle exactly the persisted output');
  assert.equal(BigInt(after.limit) - BigInt(after.used), BigInt(after.available), 'Ledger balance must reconcile');
  return { before, after, expectedSettledCodePoints: used };
}

function checkTimeline(job, state, timeline, snapshot, timing = timeline) {
  assert.equal(snapshot.state, state, 'Unexpected stable run state');
  assert.equal(timeline.final.type, `run.${state}`, 'Terminal event must match the stored state');
  assert.equal(timeline.cursor, snapshot.lastSequence, 'Terminal sequence must match the stored cursor');
  assert.equal(timeline.content, snapshot.content, 'SSE replay and stored text must agree');
  assert.equal(timeline.final.messageId, snapshot.messageId, 'Terminal event and stored reply ID must agree');
  return { runId: job.runId, conversationId: job.conversationId, state, terminalSequence: timeline.cursor,
    codePoints: codePoints(snapshot.content), startedMs: timing.startedMs, firstDeltaMs: timing.firstDeltaMs,
    terminalMs: timing.terminalMs, resumedFrom: timing.resumedFrom };
}

async function availability(origin) {
  try {
    const response = await fetch(`${origin}/api/assistant/v1/capabilities`, {
      redirect: 'error', signal: AbortSignal.timeout(1000),
    });
    await response.body?.cancel();
    return { up: response.status === 200, status: response.status };
  } catch (error) {
    return { up: false, error: error?.cause?.code ?? error.name };
  }
}

async function waitForAvailability(origin, target, limit) {
  const deadline = performance.now() + limit;
  do {
    const result = await availability(origin);
    if (result.up === target) return result;
    await delay(250);
  } while (performance.now() < deadline);
  assert.fail(target ? 'The dedicated service did not return online' : 'No dedicated service interruption observed');
}

async function waitForTerminal(getSnapshot, job, limit) {
  const deadline = performance.now() + limit;
  do {
    const snapshot = await getSnapshot(job.runId);
    if (terminal.has(snapshot.state)) return snapshot;
    await delay(1000);
  } while (performance.now() < deadline);
  assert.fail('Run did not reach a terminal state within the observation window');
}

async function runLoad({ client, config, report, timed, makeConversation, submit }) {
  const before = await client.getUsage();
  const conversations = [];
  for (let index = 0; index < config.concurrency; index += 1) conversations.push(await makeConversation());
  const completed = [];
  for (let wave = 0; wave < config.waves; wave += 1) {
    const submissions = await Promise.allSettled(conversations.map((id) => submit(id, '本地负载样本🌱'.repeat(9))));
    const jobs = [];
    for (const result of submissions) {
      if (result.status === 'fulfilled') jobs.push(result.value);
      else report.errors.push({ phase: 'submit', ...details(result.reason) });
    }
    const early = await Promise.allSettled(jobs.map((job) => timed('snapshot', () => client.getRunSnapshot(job.runId))));
    const states = {};
    for (const result of early) {
      if (result.status === 'fulfilled') states[result.value.state] = (states[result.value.state] ?? 0) + 1;
      else report.errors.push({ phase: 'queue_sample', ...details(result.reason) });
    }
    report.queue.push({ wave: wave + 1, states, usage: await client.getUsage() });

    const checks = await Promise.allSettled(jobs.map(async (job, index) => {
      const results = await Promise.allSettled([
        timed('stream', () => inspectRun(client, job, { disconnect: wave === 0 && index === 0 })),
        timed('conversationSearch', () => client.listConversations({ q: report.fixture, limit: 25 })),
        timed('messageHistory', () => client.listMessages(job.conversationId, { limit: 25 })),
      ]);
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
      assert.ok(results[1].value.items.some(({ id }) => id === job.conversationId), 'History search lost an owned conversation');
      const snapshot = await timed('snapshot', () => client.getRunSnapshot(job.runId));
      report.runs.push(checkTimeline(job, 'completed', results[0].value, snapshot));
      completed.push(snapshot);
      const history = await timed('messageHistory', () => client.listMessages(job.conversationId, { limit: 25 }));
      assert.equal(history.items.filter(({ id, role }) => id === snapshot.messageId && role === 'assistant').length, 1,
        'Stored output must appear once in message history');
    }));
    for (const result of checks) {
      if (result.status === 'rejected') report.errors.push({ phase: 'load', ...details(result.reason) });
    }
  }
  report.ledger = proveUsage(before, await client.getUsage(), completed);
}

async function runRestart({ client, config, report, directory, timed, makeConversation, submit }) {
  const before = await client.getUsage();
  const baseline = await submit(await makeConversation(), '重启前已完成🌱');
  const baselineTimeline = await inspectRun(client, baseline);
  const stable = await client.getRunSnapshot(baseline.runId);
  report.runs.push(checkTimeline(baseline, 'completed', baselineTimeline, stable));

  const active = await submit(await makeConversation(), '重启中运行合成样本🌱'.repeat(225));
  const first = await inspectRun(client, active, { stopAtFirst: true });
  const queued = await submit(await makeConversation(), '重启后继续排队🌱');
  const getSnapshot = (id) => timed('snapshot', () => client.getRunSnapshot(id));
  const activeBefore = await getSnapshot(active.runId);
  const queuedBefore = await getSnapshot(queued.runId);
  assert.equal(activeBefore.state, 'running', 'Restart drill needs a run with committed partial output');
  assert.equal(queuedBefore.state, 'queued', 'Restart drill needs a second run waiting for the same worker slot');
  const held = await client.getUsage();
  assert.ok(BigInt(held.reserved) > 0n, 'Both pending runs must hold allowance at restart');
  report.queue.push({ stage: 'before_restart', states: { running: 1, queued: 1 }, usage: held });
  const signal = { signal: 'restart-ready', origin: config.origin, activeRunId: active.runId,
    queuedRunId: queued.runId, at: new Date().toISOString() };
  await writeFile(join(directory, 'restart-ready.json'), JSON.stringify(signal, null, 2) + '\n');
  console.log(JSON.stringify(signal));
  const indicatedAt = performance.now();
  const unavailable = await waitForAvailability(config.origin, false, 30_000);
  const downAt = performance.now();
  report.recovery = { unavailable };
  console.log(JSON.stringify({ signal: 'service-offline', unavailable }));
  const available = await waitForAvailability(config.origin, true, 90_000);
  const onlineAt = performance.now();
  report.recovery = { outageMs: round(onlineAt - downAt), unavailable, available };
  console.log(JSON.stringify({ signal: 'service-online', outageMs: report.recovery.outageMs }));

  const queueFinal = await waitForTerminal(getSnapshot, queued, 25_000);
  const queuedTiming = { terminalMs: round(performance.now() - queued.started) };
  report.recovery.queuedTerminalAfterOnlineMs = round(performance.now() - onlineAt);
  const queueTimeline = await inspectRun(client, queued);
  report.runs.push(checkTimeline(queued, 'completed', queueTimeline, queueFinal, queuedTiming));
  const activeFinal = await waitForTerminal(getSnapshot, active, releaseWindowMs);
  const activeTiming = { startedMs: first.startedMs, firstDeltaMs: first.firstDeltaMs,
    terminalMs: round(performance.now() - active.started), resumedFrom: first.cursor };
  report.recovery.interruptedTerminalAfterSignalMs = round(performance.now() - indicatedAt);
  assert.equal(activeFinal.error?.code, 'PROVIDER_UNAVAILABLE', 'Abandoned provider work must fail without a new attempt');
  assert.ok(activeFinal.content.startsWith(first.content), 'Restart lost the committed partial output');
  const activeTimeline = await inspectRun(client, active, { previous: first });
  report.runs.push(checkTimeline(active, 'failed', activeTimeline, activeFinal, activeTiming));
  assert.deepEqual(await getSnapshot(baseline.runId), stable, 'Restart changed a previously committed run');

  for (const job of [baseline, active, queued]) {
    const duplicate = await client.startRun(job.conversationId, job.request, job.key);
    assert.equal(duplicate.runId, job.runId, 'Restart lost an idempotency reservation');
    const history = await client.listMessages(job.conversationId, { limit: 25 });
    assert.equal(history.items.filter(({ role }) => role === 'user').length, 1, 'Restart duplicated or lost the prompt');
    assert.equal(history.items.filter(({ role }) => role === 'assistant').length, job === active ? 0 : 1,
      'Restart published duplicate replies or a reply for the interrupted run');
  }
  report.ledger = proveUsage(before, await client.getUsage(), [stable, activeFinal, queueFinal]);
}

async function main() {
  const config = configuration();
  const { AssistantClient } = await import('../packages/contracts/dist/index.js');
  const startedAt = new Date().toISOString();
  const path = new URL(`./verify-results/resilience-${config.scenario}-${startedAt.replace(/[:.]/g, '-')}--${process.pid}/`, import.meta.url);
  const directory = fileURLToPath(path);
  await mkdir(directory, { recursive: true });
  const report = { schemaVersion: 1, startedAt, ...config, fixture: `QA-resilience-${randomUUID().slice(0, 12)}`,
    thresholdStatus: 'pending_m0', samples: {}, runs: [], queue: [], errors: [] };
  const client = new AssistantClient({
    origin: config.origin,
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.any([
      init.signal, AbortSignal.timeout(url.endsWith('/events') || url.includes('/events?') ? 19_000 : 5000),
    ]) }),
  });
  const timed = measurements(report);
  let authenticated = false;
  let status = 'passed';
  async function makeConversation() {
    return (await client.createConversation({ title: report.fixture })).id;
  }
  async function submit(conversationId, content) {
    const request = { action: 'send', content, modelId: syntheticModel };
    const key = randomUUID();
    const started = performance.now();
    const run = await timed('submit', () => client.startRun(conversationId, request, key));
    return { ...run, started, key, request };
  }

  console.log(JSON.stringify({ signal: 'evidence-directory', directory }));
  try {
    await client.replaceSession(await client.register({ username: `qa-load-${randomUUID().slice(0, 12)}`,
      password: `Qa-Resilience!${randomUUID()}` }));
    authenticated = true;
    const { models } = await client.listModels();
    assert.ok(models.some(({ id, version }) => id === syntheticModel && version === 'synthetic-v1'),
      'Dedicated API needs the deterministic local-echo model');
    const context = { client, config, directory, report, timed, makeConversation, submit };
    if (config.scenario === 'load') await runLoad(context);
    else await runRestart(context);
  } catch (error) {
    report.errors.push({ phase: config.scenario, ...details(error) });
  } finally {
    if (authenticated) await client.logout().catch((error) => report.errors.push({ phase: 'logout', ...details(error) }));
    if (report.errors.length) status = 'failed';
    const metrics = Object.fromEntries(Object.entries(report.samples).map(([name, samples]) => [name, summarise(samples)]));
    for (const name of ['startedMs', 'firstDeltaMs', 'terminalMs']) {
      metrics[name] = summarise(report.runs.filter((run) => run[name] !== undefined)
        .map((run) => ({ ok: true, millis: run[name] })));
    }
    const result = { ...report, finishedAt: new Date().toISOString(), status, metrics };
    const file = join(directory, 'summary.json');
    await writeFile(file, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ status, evidence: file, runs: report.runs.length, errors: report.errors.length }));
    if (status === 'failed') process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
