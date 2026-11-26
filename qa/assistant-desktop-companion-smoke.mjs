import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18136');
assert.equal(origin.hostname, '127.0.0.1');
assert.equal(origin.protocol, 'http:');
assert.equal(origin.href, origin.origin + '/');
const api = origin.origin + '/api/assistant/v1';
const relay = '/desktop-companion';

async function call(method, path, status, session, body, additionalHeaders = {}) {
  const headers = { ...additionalHeaders };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session) {
    headers.Authorization = `Bearer ${session.accessToken}`;
    headers['X-Workspace-Id'] = session.user.workspaceId;
  }
  const response = await fetch(api + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error', signal: AbortSignal.timeout(8000) });
  assert.equal(response.status, status, `${method} ${path}`);
  if (path.startsWith(relay)) assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  return response.status === 204 ? undefined : response.json();
}

function credentials() {
  return { username: `qa-companion-${randomBytes(6).toString('hex')}`, password: randomBytes(20).toString('hex') };
}

const owned = credentials();
const desktop = await call('POST', '/auth/register', 201, undefined, owned);
const mobile = await call('POST', '/auth/login', 200, undefined, owned);
const unused = await call('POST', '/auth/login', 200, undefined, owned);
const other = await call('POST', '/auth/register', 201, undefined, credentials());
for (const session of [desktop, mobile, unused, other]) {
  const catalogue = await call('GET', '/capabilities', 200, session);
  assert.equal(catalogue.capabilities.find(({ id }) => id === 'local_desktop_companion')?.available, true);
}
assert.deepEqual(await call('GET', relay, 200, desktop), { audit: [] });
await call('GET', relay, 404, desktop, undefined, { Forwarded: 'for=192.0.2.1' });

async function pairDevices() {
  const offer = await call('POST', relay + '/offers', 201, desktop);
  assert.deepEqual(Object.keys(offer).sort(), ['code', 'expiresAt']);
  assert.match(offer.code, /^[0-9A-HJKMNP-TV-Z]{12}$/);
  await call('POST', relay + '/offers/claim', 404, other, { code: offer.code });
  await call('POST', relay + '/offers/claim', 404, desktop, { code: offer.code });
  const awaiting = await call('POST', relay + '/offers/claim', 200, mobile, { code: offer.code });
  assert.equal(awaiting.pair.state, 'awaiting_desktop_confirmation');
  assert.equal(awaiting.pair.role, 'mobile');
  assert.deepEqual(awaiting.audit, []);
  await call('POST', relay + '/offers/claim', 404, unused, { code: offer.code });
  const base = `${relay}/pairs/${awaiting.pair.id}`;
  await call('POST', base + '/confirm', 409, mobile, { confirm: true });
  const confirmed = await call('POST', base + '/confirm', 200, desktop, { confirm: true });
  assert.equal(confirmed.pair.state, 'active');
  return base;
}

const base = await pairDevices();
const binding = { scopeId: randomUUID(), revision: 1, sourceSha256: 'a'.repeat(64) };
const altered = { scopeId: randomUUID(), revision: 2, sourceSha256: 'b'.repeat(64) };
await call('PUT', base + '/task', 400, desktop, { ...binding, path: 'C:/synthetic/unselected' });
let { task } = await call('PUT', base + '/task', 200, desktop, binding);
assert.deepEqual(Object.keys(task).sort(), ['expiresAt', 'id', 'revision', 'scopeId', 'sourceSha256', 'status']);
const old = `${base}/task/${task.id}`;
await call('POST', old + '/decision', 404, unused, { ...binding, decision: 'approve' });
await call('POST', old + '/decision', 409, mobile, { ...altered, decision: 'approve' });
await call('POST', old + '/consume', 409, desktop, binding);
await call('POST', old + '/decision', 200, mobile, { ...binding, decision: 'approve' });
await call('DELETE', old, 204, desktop);
assert.equal((await call('GET', relay, 200, mobile)).task, undefined);
await call('POST', old + '/consume', 404, desktop, binding);

({ task } = await call('PUT', base + '/task', 200, desktop, altered));
const current = `${base}/task/${task.id}`;
const accepted = await call('POST', current + '/decision', 200, mobile, { ...altered, decision: 'approve' });
assert.equal(accepted.task.status, 'approved');
assert.deepEqual(accepted.audit, []);
await call('POST', current + '/consume', 404, mobile, altered);
await call('POST', current + '/consume', 204, desktop, altered);
await call('POST', current + '/consume', 409, desktop, altered);
({ task } = await call('PUT', base + '/task', 200, desktop, altered));
// The browser window is intentionally absent for this distinct integration check.
await delay(19000);
const offlineHost = await call('GET', relay, 200, mobile);
assert.equal(offlineHost.pair.state, 'active');
assert.equal(offlineHost.task, undefined);
await call('POST', `${base}/task/${task.id}/decision`, 404, mobile, { ...altered, decision: 'approve' });
assert.equal((await call('GET', relay, 200, desktop)).audit.at(-1).event, 'expired');
await call('DELETE', base, 204, mobile);
await call('POST', current + '/decision', 404, mobile, { ...altered, decision: 'approve' });
assert.equal((await call('GET', relay, 200, desktop)).audit.at(-1).event, 'pair_revoked');

const second = await pairDevices();
const throttled = await call('POST', relay + '/offers/claim', 429, unused, { code: 'A'.repeat(12) });
assert.equal(throttled.code, 'RATE_LIMITED');
const devices = await call('GET', '/auth/devices', 200, mobile);
const mobileDevice = devices.find(({ current: selected }) => selected);
assert.ok(mobileDevice);
({ task } = await call('PUT', second + '/task', 200, desktop, binding));
await call('DELETE', `/auth/devices/${mobileDevice.id}`, 204, desktop);
await call('POST', `${second}/task/${task.id}/decision`, 401, mobile, { ...binding, decision: 'approve' });
const scrubbed = await call('GET', relay, 200, desktop);
assert.equal(scrubbed.pair, undefined);
assert.equal(scrubbed.task, undefined);
assert.equal(scrubbed.audit.at(-1).event, 'device_unavailable');

for (const active of [desktop, unused, other]) await call('POST', '/auth/logout', 204, active);
console.log(JSON.stringify({ loopbackAdmission: true, challengeOneUse: true, desktopConfirmation: true,
  sameOwnerDistinctSession: true, exactTaskProjection: true, changedDirectoryRejected: true, currentRevisionConsumedOnce: true,
  expiredTaskOnOfflineHost: true, unpairRecorded: true, attemptRateCapped: true, sameBearerRejectedAfterDeviceRevoke: true,
  survivingDesktopRecordedRevocation: true }));
