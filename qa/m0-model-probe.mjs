import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const providers = {
  dashscope: {
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    keyVariable: 'DASHSCOPE_API_KEY',
  },
  ark: {
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    keyVariable: 'ARK_API_KEY',
  },
};

const textCases = [
  {
    id: 'zh-extract',
    messages: [
      { role: 'user', content: '合成材料：试验编号为青山-17，预约在周三。请只原样输出试验编号。' },
    ],
    fixture: '青山-17',
    check: (value) => value.trim() === '青山-17',
  },
  {
    id: 'conversation-context',
    messages: [
      { role: 'user', content: '这是虚构仓库。蓝箱有 8 个，红箱有 3 个。' },
      { role: 'assistant', content: '已记录蓝箱和红箱的数量。' },
      { role: 'user', content: '更新：红箱又到 2 个。现在两种箱子共有多少个？请只输出阿拉伯数字。' },
    ],
    fixture: '13',
    check: (value) => value.trim() === '13',
  },
  {
    id: 'structured-output',
    messages: [
      { role: 'user', content: '从合成通知“模拟活动已结束，人数为 4”提取 JSON，只返回 count（数值）和 finished（布尔值）。' },
    ],
    options: { response_format: { type: 'json_object' } },
    fixture: '{"count":4,"finished":true}',
    check: (value) => {
      const data = JSON.parse(value);
      return data?.count === 4 && data.finished === true && Object.keys(data).length === 2;
    },
  },
];

// The 64×64 fixture contains only the solid RGB colour #235DD9.
const bluePng = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAACLSURBVHhe7dAxAQAgEIDA72Iug38a3akAwy2MzLn7zIbBpgEMNg1gsGkAg00DGGwawGDTAAabBjDYNIDBpgEMNg1gsGkAg00DGGwawGDTAAabBjDYNIDBpgEMNg1gsGkAg00DGGwawGDTAAabBjDYNIDBpgEMNg1gsGkAg00DGGwawGDTAAabBjDYfFlCgiyrjp+CAAAAAElFTkSuQmCC';
const visionCases = [{
  id: 'vision-solid-colour',
  messages: [{
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${bluePng}` } },
      { type: 'text', text: '这张合成色块的颜色是什么？请只在红色、蓝色、绿色、白色中选一个原样输出。' },
    ],
  }],
  fixture: '蓝色',
  check: (value) => value.trim() === '蓝色',
}];

function usage(body) {
  const tokens = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  return { promptTokens: tokens(body?.prompt_tokens), completionTokens: tokens(body?.completion_tokens) };
}

async function readStream(response, started) {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (!response.body || mediaType !== 'text/event-stream') {
    await response.body?.cancel();
    throw new TypeError('Expected an SSE response.');
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let buffer = '';
  let text = '';
  let firstTextMs = null;
  let finishReason = null;
  let model = null;
  let responseId = null;
  let metered = usage();
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 256 * 1024) throw new RangeError('Probe response exceeded its byte budget.');
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const event = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      const payload = event.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
      if (!payload) continue;
      if (payload === '[DONE]') {
        return { text, firstTextMs, finishReason, actualModel: model, responseId, ...metered };
      }
      const frame = JSON.parse(payload);
      if (frame.error) throw new Error('Provider returned a stream error.');
      const choice = frame.choices?.[0];
      if (typeof choice?.delta?.content === 'string' && choice.delta.content) {
        firstTextMs ??= Math.round(performance.now() - started);
        text += choice.delta.content;
      }
      finishReason = choice?.finish_reason ?? finishReason;
      model = frame.model ?? model;
      responseId = frame.id ?? responseId;
      if (frame.usage) metered = usage(frame.usage);
    }
  }
  throw new TypeError('Provider stream ended without a terminal event.');
}

function fixtureResponse(testCase) {
  const frame = (body) => `data: ${JSON.stringify(body)}\r\n\r\n`;
  const first = Array.from(testCase.fixture).slice(0, 1).join('');
  const rest = testCase.fixture.slice(first.length);
  const bytes = new TextEncoder().encode(
    ': fixture\r\n\r\n' +
    frame({ id: `fixture-${testCase.id}`, model: 'synthetic-fixture', choices: [{ delta: { role: 'assistant' } }] }) +
    frame({ choices: [{ delta: { content: first } }] }) +
    frame({ choices: [{ delta: { content: rest }, finish_reason: 'stop' }] }) +
    frame({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }) +
    'data: [DONE]\r\n\r\n',
  );
  const stream = new ReadableStream({
    start(controller) {
      // Split multibyte text and SSE framing at byte boundaries.
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

async function callProvider(provider, model, key, testCase) {
  return fetch(provider.endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      model, messages: testCase.messages, max_tokens: 128, stream: true,
      stream_options: { include_usage: true }, ...testCase.options,
    }),
    signal: AbortSignal.timeout(30_000),
  });
}

async function runCase(testCase, provider, model, key) {
  const start = performance.now();
  const result = { caseId: testCase.id, passed: false };
  try {
    const response = provider
      ? await callProvider(provider, model, key, testCase)
      : fixtureResponse(testCase);
    result.status = response.status;
    result.requestId = response.headers.get('x-request-id');
    if (!response.ok) {
      result.retryAfter = response.headers.get('retry-after');
      await response.body?.cancel();
    } else {
      const { text, responseId, ...streamEvidence } = await readStream(response, start);
      Object.assign(result, streamEvidence);
      result.requestId ??= responseId;
      if (result.firstTextMs !== null && result.finishReason === 'stop') {
        result.passed = testCase.check(text);
      }
    }
  } catch (error) {
    result.error = error instanceof Error ? error.name : 'UnknownError';
  }
  return { ...result, elapsedMs: Math.round(performance.now() - start) };
}

const [providerName = 'mock', suite = 'text', extra] = process.argv.slice(2);
if (extra !== undefined || !['text', 'vision'].includes(suite) ||
  (providerName !== 'mock' && !Object.hasOwn(providers, providerName))) {
  throw new Error('Usage: node qa/m0-model-probe.mjs [mock|dashscope|ark] [text|vision]');
}
const provider = providers[providerName];
const model = provider ? process.env.M0_MODEL_ID : 'synthetic-fixture';
const key = provider ? process.env[provider.keyVariable] : null;
if (provider && (!model?.trim() || !key?.trim())) {
  throw new Error(`Set M0_MODEL_ID and ${provider.keyVariable} for live evaluation.`);
}

const results = [];
const startedAt = new Date().toISOString();
const cases = suite === 'text' ? textCases : visionCases;
for (const testCase of cases) {
  results.push(await runCase(testCase, provider, model, key));
}
console.log(JSON.stringify({
  schemaVersion: 2,
  runId: randomUUID(),
  startedAt,
  startedFor: providerName,
  resultType: provider ? `live-${suite}-probe` : 'synthetic-fixture',
  suite,
  fixtureSha256: createHash('sha256').update(JSON.stringify(cases.map(({ id, messages, options }) => ({ id, messages, options })))).digest('hex'),
  model,
  results,
}, null, 2));
process.exitCode = results.every((result) => result.passed) ? 0 : 1;
