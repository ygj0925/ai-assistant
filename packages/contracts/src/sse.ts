import type { components } from './openapi.generated.js';

type RunEvent = components['schemas']['RunEvent'];

export interface RunEventOptions {
  runId: string;
  afterSequence?: number;
}

export class StreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamProtocolError';
  }
}

export function validCursor(sequence: number): boolean {
  return Number.isSafeInteger(sequence) && sequence >= 0;
}

async function* readLines(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let fragment = '';
  let skipFirstLf = false;
  let atStart = true;

  for await (const chunk of chunks) {
    if (!chunk.length) continue;
    const stripBom = atStart && chunk.charCodeAt(0) === 0xfeff;
    const text: string = stripBom || (skipFirstLf && chunk[0] === '\n') ? chunk.slice(1) : chunk;
    atStart = false;
    skipFirstLf = false;

    let start = 0;
    for (const match of text.matchAll(/\r\n|\r|\n/g)) {
      const index = match.index;
      yield fragment + text.slice(start, index);
      fragment = '';
      start = index + match[0].length;
      skipFirstLf = match[0] === '\r' && start === text.length;
    }
    fragment += text.slice(start);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEvent(data: string, runId: string, id?: string, eventName?: string): RunEvent {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    throw new StreamProtocolError('Invalid JSON in run event');
  }

  if (
    !isRecord(value) ||
    value.runId !== runId ||
    typeof value.sequence !== 'number' ||
    !validCursor(value.sequence) ||
    value.sequence === 0 ||
    id !== String(value.sequence) ||
    eventName !== value.type
  ) {
    throw new StreamProtocolError('Run event metadata does not match its SSE frame');
  }

  switch (value.type) {
    case 'run.started':
    case 'run.cancelled':
      return value as RunEvent;
    case 'message.delta':
      if (typeof value.delta === 'string') return value as RunEvent;
      break;
    case 'run.completed':
      if (typeof value.messageId === 'string' && value.messageId) return value as RunEvent;
      break;
    case 'run.failed':
      if (isRecord(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string') {
        return value as RunEvent;
      }
      break;
  }
  throw new StreamProtocolError('Invalid run event payload');
}

export async function* decodeRunEvents(
  chunks: AsyncIterable<string>,
  { runId, afterSequence = 0 }: RunEventOptions,
): AsyncGenerator<RunEvent> {
  if (!validCursor(afterSequence)) throw new RangeError('Invalid run event sequence');

  let lastSequence = afterSequence;
  let id: string | undefined;
  let eventName: string | undefined;
  let data: string[] = [];
  for await (const line of readLines(chunks)) {
    if (!line) {
      const event = data.length ? parseEvent(data.join('\n'), runId, id, eventName) : undefined;
      id = undefined;
      eventName = undefined;
      data = [];
      if (!event || event.sequence <= lastSequence) continue;
      if (event.sequence !== lastSequence + 1) {
        throw new StreamProtocolError('Missing events before the next run sequence');
      }
      lastSequence = event.sequence;
      yield event;
      if (event.type === 'run.completed' || event.type === 'run.cancelled' || event.type === 'run.failed') return;
      continue;
    }

    const delimiter = line.indexOf(':');
    const field = delimiter < 0 ? line : line.slice(0, delimiter);
    let value = delimiter < 0 ? '' : line.slice(delimiter + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') id = value;
    if (field === 'event') eventName = value;
    if (field === 'data') data.push(value);
  }
}

export async function* readUtf8Stream(response: Response): AsyncGenerator<string> {
  const reader = response.body?.getReader?.();
  if (!reader || typeof TextDecoder === 'undefined') {
    reader?.releaseLock();
    throw new StreamProtocolError('This runtime requires a readStream adapter');
  }

  const decoder = new TextDecoder('utf-8');
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      yield decoder.decode(result.value, { stream: true });
    }
    yield decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
