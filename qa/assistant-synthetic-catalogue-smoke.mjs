import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [source, mode, directory] = process.argv.slice(2);
assert.ok(['enabled', 'disabled'].includes(mode));
assert.equal(Boolean(directory), mode === 'enabled');
const origin = new URL(source);
assert.ok(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
  && origin.port && origin.port !== '18080' && origin.pathname === '/' && !origin.username
  && !origin.password && !origin.search && !origin.hash, 'Use a dedicated synthetic loopback API.');
const evidence = directory && resolve(directory);
if (evidence) await mkdir(evidence, { recursive: true });
const root = '/commerce/catalogue';
const products = root + '/products';
const expectedId = (suffix) => '61000000-0000-4000-8000-00000000000' + suffix;
const fixture = { keyboard: expectedId(1), stand: expectedId(2), expired: expectedId(3),
  invalidSource: expectedId(4), outOfStock: expectedId(5) };

async function request(path, expected, { actor, method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.token;
    headers['X-Workspace-Id'] = actor.workspace;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL('/api/assistant/v1' + path, origin), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
    signal: AbortSignal.timeout(8_000),
  });
  const data = await response.json().catch(() => null);
  assert.equal(response.status, expected, method + ' ' + path + ' → ' + (data?.code ?? ''));
  if (path.startsWith(root)) assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/);
  return data;
}

async function mark(name, value) {
  const path = join(evidence, name + '.json');
  await writeFile(path + '.tmp', JSON.stringify(value) + '\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

async function waitForMark(name) {
  const deadline = Date.now() + 480_000;
  while (Date.now() < deadline) {
    try {
      await access(join(evidence, name + '.json'));
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(125);
  }
  assert.fail('Missing synthetic marker ' + name);
}

function query(actor, text, expected = 200) {
  return request(products + '?q=' + encodeURIComponent(text), expected, { actor });
}

function get(actor, id, expected = 200) {
  return request(products + '/' + id, expected, { actor });
}

function provenance(actor, id, snapshot, expected = 200) {
  return request(products + '/' + id + '/source?snapshotId=' + encodeURIComponent(snapshot), expected, { actor });
}

function compare(actor, productIds, expected = 200) {
  return request(root + '/compare', expected, { actor, method: 'POST', body: { productIds } });
}

const { accessToken, user } = await request('/auth/register', 201, { method: 'POST', body: {
  username: 'qa-catalogue-' + randomUUID().slice(0, 10), password: 'Qa.Catalogue-' + randomUUID(),
} });
const actor = { token: accessToken, workspace: user.workspaceId };

await request(products, 401);
const { capabilities } = await request('/capabilities', 200, { actor });
assert.equal(capabilities.find(({ id }) => id === 'synthetic_product_catalogue')?.available, mode === 'enabled');
if (mode === 'disabled') {
  assert.equal((await query(actor, '键盘', 403)).code, 'CAPABILITY_UNAVAILABLE');
  assert.equal((await compare(actor, [fixture.keyboard, fixture.stand], 403)).code, 'CAPABILITY_UNAVAILABLE');
  assert.equal((await provenance(actor, fixture.keyboard, randomUUID(), 403)).code, 'CAPABILITY_UNAVAILABLE');
  console.log(JSON.stringify({ flagOffClosesSearchCompareAndSources: true }));
} else {
  await request(products, 403, { actor: { ...actor, workspace: randomUUID() } });
  const found = await query(actor, 'ＡＩ 键盘');
  assert.equal(found.mode, 'synthetic');
  assert.deepEqual(found.items.map(({ id }) => id), [fixture.keyboard]);
  assert.deepEqual((await query(actor, '%')).items.map(({ id }) => id), [fixture.keyboard]);
  assert.deepEqual((await query(actor, '_')).items.map(({ id }) => id), [fixture.keyboard]);
  assert.deepEqual((await query(actor, '无匹配的合成名称')).items, []);
  assert.equal((await query(actor, ' '.repeat(121), 400)).code, 'VALIDATION_ERROR');
  const page1 = await request(products + '?limit=2', 200, { actor });
  const page2 = await request(products + '?limit=2&cursor=' + page1.nextCursor, 200, { actor });
  assert.deepEqual([...page1.items, ...page2.items].map(({ id }) => id),
    [fixture.keyboard, fixture.stand, fixture.outOfStock]);
  assert.equal(page2.nextCursor, null);
  const keyboard = await get(actor, fixture.keyboard);
  const stand = await get(actor, fixture.stand);
  assert.deepEqual(keyboard.price, { amount: '129.90', currency: 'CNY' });
  assert.deepEqual(stand.price, { amount: '3900', currency: 'JPY' });
  assert.equal(keyboard.source.merchantUrl, 'https://fixture-shop.example/products/river-keyboard');
  assert.ok(Date.parse(keyboard.source.expiresAt) > Date.parse(keyboard.observedAt));
  assert.equal(keyboard.source.observedAt, keyboard.observedAt);
  assert.deepEqual(await provenance(actor, keyboard.id, keyboard.source.snapshotId), keyboard.source);
  assert.equal((await request(products + '/' + keyboard.id + '/source', 400, { actor })).code,
    'VALIDATION_ERROR');
  assert.equal((await provenance(actor, keyboard.id, stand.source.snapshotId, 409)).code,
    'CATALOGUE_CHANGED');
  assert.equal((await get(actor, fixture.outOfStock)).status, 'out_of_stock');
  for (const [productId, expected] of [[fixture.expired, 'expired'], [fixture.invalidSource, 'unavailable']]) {
    const product = await get(actor, productId);
    assert.equal(product.status, expected);
    assert.ok(product.observedAt);
    assert.equal(product.price, undefined);
    assert.equal(product.source, undefined);
  }
  await get(actor, randomUUID(), 404);
  assert.equal((await compare(actor, [keyboard.id, keyboard.id], 400)).code, 'VALIDATION_ERROR');
  assert.equal((await compare(actor, [keyboard.id, randomUUID()], 404)).code, 'NOT_FOUND');
  const initial = await compare(actor, [stand.id, keyboard.id]);
  assert.deepEqual(initial, { mode: 'synthetic', items: [stand, keyboard] });
  await mark('catalogue-ready', { firstReadVerified: true });
  await waitForMark('catalogue-updated');
  const updated = await get(actor, keyboard.id);
  const withdrawn = await get(actor, stand.id);
  assert.deepEqual(updated.price, { amount: '109.50', currency: 'CNY' });
  assert.ok(Date.parse(updated.observedAt) > Date.parse(keyboard.observedAt));
  assert.notEqual(updated.source.snapshotId, keyboard.source.snapshotId);
  assert.deepEqual(await provenance(actor, updated.id, updated.source.snapshotId), updated.source);
  assert.equal((await provenance(actor, keyboard.id, keyboard.source.snapshotId, 409)).code,
    'CATALOGUE_CHANGED');
  assert.equal((await provenance(actor, stand.id, stand.source.snapshotId, 409)).code,
    'CATALOGUE_CHANGED');
  assert.equal(withdrawn.status, 'delisted');
  assert.ok(Date.parse(withdrawn.observedAt) > Date.parse(stand.observedAt));
  assert.equal(withdrawn.price, undefined);
  assert.equal(withdrawn.source, undefined);
  assert.deepEqual((await query(actor, '桌面支架')).items.map(({ id }) => id), [fixture.outOfStock]);
  assert.deepEqual((await compare(actor, [updated.id, withdrawn.id])).items, [updated, withdrawn]);
  await mark('summary', { authenticatedReadOnly: true, normalizedLiteralSearchAndPages: true,
    exactCnyAndJpyPrices: true, verifiedReservedMerchantProvenance: true,
    staleSnapshotAndInvalidSourceCannotReturnPrice: true, priceUpdateAndDelistUseLatestObservation: true,
    comparableKnownAvailability: true });
}
