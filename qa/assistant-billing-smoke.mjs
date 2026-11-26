import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:18081');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Use an isolated loopback app');
const signingKey = process.env.ASSISTANT_BILLING_SANDBOX_SECRET;
assert.ok(/^[0-9a-f]{64}$/i.test(signingKey ?? ''), 'Set the same disposable sandbox key as the process');
const prefix = '/billing/sandbox';
const sessions = [];

async function request(path, status, { method = 'GET', token, body, headers = {} } = {}) {
  const response = await fetch(new URL('/api/assistant/v1' + path, origin), {
    method,
    headers: {
      ...headers,
      ...(token && { Authorization: 'Bearer ' + token }),
      ...(body !== undefined && { 'Content-Type': 'application/json' }),
    },
    body: typeof body === 'string' ? body : body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
    redirect: 'error',
  });
  assert.equal(response.status, status, method + ' ' + path);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/);
  return status === 204 ? undefined : response.json();
}

async function register() {
  const input = { username: 'billing-' + randomUUID().slice(0, 12), password: 'Qa-' + randomUUID() };
  const session = await request('/auth/register', 201, { method: 'POST', body: input });
  sessions.push(session.accessToken);
  return { ...session, input };
}

function delivery(body, status = 200, { timestamp = Date.now(), corrupt = false } = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  const hmac = createHmac('sha256', Buffer.from(signingKey, 'hex')).update(timestamp + '.' + data).digest('hex');
  const signature = corrupt ? (hmac[0] === '0' ? '1' : '0') + hmac.slice(1) : hmac;
  return request(prefix + '/notifications', status, {
    method: 'POST',
    body: data,
    headers: {
      'X-Assistant-Sandbox-Signed-At': String(timestamp),
      'X-Assistant-Sandbox-Signature': signature,
    },
  });
}

try {
  const owner = await register();
  const stranger = await register();
  const second = await request('/auth/login', 200, { method: 'POST', body: owner.input });
  sessions.push(second.accessToken);
  const key = randomUUID();
  const checkout = (token) => request(prefix + '/checkout', 200, {
    method: 'POST', token, headers: { 'Idempotency-Key': key },
  });
  const entitlement = (token) => request(prefix + '/entitlement', 200, { token });
  await request(prefix + '/checkout', 401, { method: 'POST', headers: { 'Idempotency-Key': key } });
  assert.equal((await request(prefix + '/checkout', 400, { method: 'POST', token: owner.accessToken })).code,
    'VALIDATION_ERROR');
  assert.equal((await entitlement(owner.accessToken)).active, false);
  const [first, retry, other] = await Promise.all([
    checkout(owner.accessToken), checkout(second.accessToken), checkout(stranger.accessToken),
  ]);
  assert.deepEqual(first, retry);
  assert.notEqual(first.orderId, other.orderId);
  assert.equal(first.state, 'pending');
  assert.equal(first.revision, 0);

  const orderPath = prefix + '/orders/' + first.orderId;
  await request(orderPath, 404, { token: stranger.accessToken });
  await request(orderPath, 403, {
    token: owner.accessToken, headers: { 'X-Workspace-Id': stranger.user.workspaceId },
  });

  const now = Date.now();
  const active = {
    eventId: randomUUID(), orderId: first.orderId, revision: 2, state: 'active',
    occurredAt: now - 10000, entitledUntil: now + 86400000,
  };
  assert.equal((await delivery(active, 401, { corrupt: true })).code, 'UNAUTHENTICATED');
  assert.equal((await delivery(active, 401, { timestamp: now - 400000 })).code, 'UNAUTHENTICATED');
  assert.equal((await delivery('{"eventId":"a","eventId":"b"}', 400)).code, 'VALIDATION_ERROR');
  assert.equal((await delivery({ ...active, revision: 1.5 }, 400)).code, 'VALIDATION_ERROR');
  assert.equal((await delivery({ ...active, unexpected: true }, 400)).code, 'VALIDATION_ERROR');
  assert.equal((await delivery(' '.repeat(4097), 413)).code, 'PAYLOAD_TOO_LARGE');
  assert.equal((await delivery({ ...active, orderId: randomUUID() }, 404)).code, 'NOT_FOUND');
  assert.equal((await entitlement(owner.accessToken)).active, false);

  const receipts = await Promise.all([delivery(active), delivery(active)]);
  assert.deepEqual(receipts.map(({ duplicate }) => duplicate).sort(), [false, true]);
  assert.ok(receipts.every(({ processingState, order }) => processingState === 'applied' && order.state === 'active'));
  assert.equal((await entitlement(owner.accessToken)).entitledUntil, active.entitledUntil);
  assert.deepEqual(await entitlement(second.accessToken), await entitlement(owner.accessToken));
  assert.equal((await entitlement(stranger.accessToken)).active, false);
  assert.deepEqual(await request(orderPath, 200, { token: second.accessToken }), receipts[0].order);
  assert.equal((await delivery({ ...active, entitledUntil: active.entitledUntil + 1000 }, 409)).code, 'CONFLICT');
  assert.equal((await delivery({ ...active, orderId: other.orderId }, 409)).code, 'CONFLICT');
  assert.equal((await delivery({ ...active, eventId: randomUUID(), revision: 1 })).processingState, 'ignored');
  assert.equal((await delivery({ ...active, eventId: randomUUID(), state: 'expired', entitledUntil: null }, 409)).code,
    'CONFLICT');

  const renewal = { ...active, eventId: randomUUID(), revision: 3, entitledUntil: now + 172800000 };
  assert.equal((await delivery(renewal)).processingState, 'applied');
  const refund = {
    eventId: randomUUID(), orderId: first.orderId, revision: 4, state: 'refunded',
    occurredAt: now - 86400000,
  };
  assert.equal((await delivery(refund)).order.state, 'refunded');
  assert.equal((await delivery(refund)).duplicate, true);
  assert.equal((await delivery({ ...renewal, eventId: randomUUID(), revision: 5 })).processingState, 'ignored');
  assert.equal((await entitlement(owner.accessToken)).active, false);
  assert.equal((await request(orderPath, 200, { token: second.accessToken })).revision, 4);

  const elapsed = {
    ...active, eventId: randomUUID(), orderId: other.orderId, revision: 1,
    occurredAt: now - 10000, entitledUntil: now - 5000,
  };
  assert.equal((await delivery(elapsed)).order.state, 'expired');
  assert.equal((await entitlement(stranger.accessToken)).active, false);

  console.log(JSON.stringify({ suite: 'assistant-billing-sandbox', status: 'passed', channels: ['local-test'] }));
} finally {
  await Promise.allSettled(sessions.map((token) => request('/auth/logout', 204, { method: 'POST', token })));
}
