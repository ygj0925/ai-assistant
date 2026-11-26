import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const origin = new URL(process.argv[2]);
assert.ok(['http:', 'https:'].includes(origin.protocol) && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
  && origin.port && origin.pathname === '/' && !origin.username && !origin.password && !origin.search && !origin.hash,
  'Use a dedicated loopback API origin.');
const id = randomUUID();
const routes = [
  ['job', `/jobs/${id}/artifact`, 'text/markdown'],
  ['analysis', `/analysis/${id}/artifact`, 'text/csv'],
  ['research', `/research/${id}/report?revision=1`, 'text/plain'],
  ['artifact', `/artifacts/${id}/versions/${id}/download`, 'text/markdown'],
  ['publication', `/collaboration/projects/${id}/artifact-publications/${id}/download`, 'text/markdown'],
  ['attachment', `/projects/${id}/attachments/${id}/download`, 'image/png'],
  ['event-stream', `/runs/${id}/events`, 'text/event-stream'],
];

const checks = await Promise.all(routes.map(async ([name, path, accept]) => {
  const response = await fetch(new URL('/api/assistant/v1' + path, origin), {
    headers: { Accept: accept }, redirect: 'error', signal: AbortSignal.timeout(8_000),
  });
  assert.equal(response.status, 401, `${name} retains the correct unauthenticated status`);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json(?:;|$)/i, name);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i, name);
  assert.equal((await response.json()).code, 'UNAUTHENTICATED', name);
  return name;
}));
console.log(JSON.stringify({ checked: checks, status: 401, mediaType: 'application/json', cacheControl: 'no-store' }));
