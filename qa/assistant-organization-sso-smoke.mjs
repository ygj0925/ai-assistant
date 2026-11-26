import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [source, restored, directory] = process.argv.slice(2);
let origin = loopback(source);
const stable = loopback(restored);
assert.notEqual(origin.port, stable.port);
const checkpoints = resolve(directory);
await mkdir(checkpoints, { recursive: true });
const fixture = globalThis.assistantOidcFixture;
const { workspaceId, outsideOrg, primary, owner, primaryRoom, personalRoom, outsideRoom, outsiderRoom } = fixture.seed;
const prefix = '/api/assistant/v1';
const sso = prefix + '/organization-sso';
const control = '/scim/v2/' + fixture.directoryId + '/Users/' + fixture.primaryBinding;
const tokens = [];
const correlation = () => randomBytes(32).toString('base64url');

function loopback(value) {
  const url = new URL(value);
  assert.ok(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    && url.port && url.port !== '18080' && url.pathname === '/' && !url.username && !url.password
    && !url.search && !url.hash, 'Use a dedicated synthetic loopback assertion fixture.');
  return url;
}

async function http(path, expected, { method = 'GET', body, token, workspace, contentType } = {}) {
  const headers = { Accept: contentType ?? 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (workspace) headers['X-Workspace-Id'] = workspace;
  if (body !== undefined) headers['Content-Type'] = contentType ?? 'application/json';
  const res = await fetch(new URL(path, origin), { headers, method,
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error',
    signal: AbortSignal.timeout(10_000) });
  const data = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  assert.ok((Array.isArray(expected) ? expected : [expected]).includes(res.status),
    method + ' ' + path + ' status ' + res.status + ' ' + (data?.code ?? ''));
  if (path.startsWith(sso)) assert.match(res.headers.get('cache-control') ?? '', /\bno-store\b/);
  return data;
}

async function login(actor) {
  const session = await http(prefix + '/auth/login', 200,
    { method: 'POST', body: { username: actor.username, password: actor.password } });
  tokens.push(session.accessToken);
  return session.accessToken;
}

async function marker(name) {
  const path = join(checkpoints, name);
  await writeFile(path + '.tmp', '{}\n', { flag: 'wx' });
  await rename(path + '.tmp', path);
}

async function wait(name) {
  const budget = Date.now() + 300_000;
  do {
    try { await access(join(checkpoints, name)); return; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    await delay(100);
  } while (Date.now() < budget);
  assert.fail('Missing controlled recovery checkpoint ' + name);
}

function body(browserBinding, password = primary.password) {
  return { browserBinding, currentPassword: password, confirm: true };
}

async function beginFlow(token) {
  const browserBinding = correlation();
  const value = await http(sso + (token ? '/link/start' : '/start'), 200, { token, workspace: token ? workspaceId : undefined,
    method: 'POST', body: token ? body(browserBinding) : { browserBinding } });
  assert.deepEqual(Object.keys(value), ['authorizationUrl']);
  return { authorizationUrl: value.authorizationUrl, browserBinding, started: Date.now() };
}

async function codeFrom(flow, idpUser = 'primary') {
  return { ...await fixture.browserCode(flow.authorizationUrl, idpUser), browserBinding: flow.browserBinding };
}

async function start(token, idpUser = 'primary') {
  return codeFrom(await beginFlow(token), idpUser);
}

function finish(attempt, expected = 200) {
  return http(sso + '/complete', expected, { method: 'POST', body: attempt });
}

async function signIn() {
  const attempt = await start();
  const session = await finish(attempt);
  assert.equal(session.mode, 'login');
  assert.equal(session.workspaceId, workspaceId);
  assert.ok(/^osso_[A-Za-z0-9_-]{43}$/.test(session.sessionToken));
  assert.ok(Date.parse(session.expiresAt) > Date.now());
  assert.equal(Object.keys(session).length, 4);
  await finish(attempt, 401);
  return session.sessionToken;
}

try {
  assert.deepEqual(await http(sso + '/status', 200), { available: true });
  const ownerToken = await login(owner);
  let localToken = await login(primary);
  const localScope = { token: localToken, workspace: workspaceId };
  assert.deepEqual(await http(sso + '/link', 200, localScope), { eligible: true, linked: false });
  await http(sso + '/link/start', 403, {
    token: ownerToken, workspace: workspaceId, method: 'POST', body: body(correlation(), owner.password),
  });
  await http(sso + '/link/start', 401, {
    ...localScope, method: 'POST', body: body(correlation(), 'wrong-fixture-current-password'),
  });
  await http(sso + '/link/start', 403, {
    token: localToken, workspace: outsideOrg, method: 'POST', body: body(correlation()),
  });
  await finish(await start(), 401);
  await finish(await start(undefined, 'unbound'), 401);
  await finish(await start(localToken, 'unbound'), 401);

  const revokedLink = await start(localToken);
  await http(prefix + '/auth/logout', 204, { token: localToken, method: 'POST' });
  await finish(revokedLink, 401);
  localToken = await login(primary);
  const currentScope = { token: localToken, workspace: workspaceId };
  const unlink = () => http(sso + '/link/revoke', 204, { ...currentScope, method: 'POST',
    body: { currentPassword: primary.password, confirm: true } });

  const pendingWithoutConsent = await start(localToken);
  await unlink();
  await finish(pendingWithoutConsent, 401);

  const valid = await start(localToken);
  await finish({ ...valid, browserBinding: correlation() }, 401);
  await finish({ ...valid, issuer: valid.issuer + '/different' }, 401);
  assert.deepEqual(await finish(valid), { mode: 'link', linked: true });
  await finish(valid, 401);
  assert.deepEqual(await http(sso + '/link', 200, currentScope), { eligible: true, linked: true });

  const one = await start();
  const two = await start();
  await finish({ ...one, code: two.code }, 401);
  await finish(one, 401);
  const first = await signIn();
  const second = await signIn();
  const organization = await http(sso + '/workspace', 200, { token: first });
  assert.equal(organization.workspaceId, workspaceId);
  assert.equal(organization.name, fixture.seed.organizationName);
  assert.equal(organization.role, 'member');
  assert.equal(organization.seatsUsed, 4);
  const page = await http(sso + '/conversations?limit=2', 200, { token: first });
  assert.deepEqual(page.items.map(({ id }) => id), [primaryRoom.id]);
  assert.equal((await http(sso + '/conversations/' + primaryRoom.id, 200, { token: first })).title, primaryRoom.title);
  for (const denied of [personalRoom, outsideRoom, outsiderRoom]) {
    await http(sso + '/conversations/' + denied.id, 404, { token: first });
  }
  await http(sso + '/workspace', 403, { token: first, workspace: outsideOrg });
  await http(prefix + '/auth/me', 401, { token: first });
  await http(prefix + '/auth/devices', 401, { token: first });
  await http(sso + '/workspace', 401, { token: localToken });
  await http(sso + '/workspace', 401, { token: await fixture.machineToken() });
  await http('/system/assistant/moderation/workspaces/' + workspaceId + '/reports', [401, 403], { token: first });
  assert.equal((await http(prefix + '/auth/me', 200, { token: localToken })).workspaceId, primary.workspace);
  await http(prefix + '/conversations/' + outsideRoom.id, 200, { token: localToken, workspace: outsideOrg });

  const pendingLink = await start(localToken);
  const pendingLogin = await start();
  const delayedAcrossRestore = await beginFlow(localToken);
  await marker('backup-ready');
  await wait('backup-done');
  await http(sso + '/logout', 204, { token: first, method: 'POST' });
  await http(sso + '/workspace', 401, { token: first });
  await http(sso + '/workspace', 200, { token: second });
  await unlink();
  await http(sso + '/workspace', 401, { token: second });
  assert.deepEqual(await http(sso + '/link', 200, currentScope), { eligible: true, linked: false });
  await finish(pendingLink, 401);
  await finish(await start(), 401);

  assert.deepEqual(await finish(await start(localToken)), { mode: 'link', linked: true });
  await finish(pendingLogin, 401);
  const reconsented = await signIn();
  await http(sso + '/workspace', 200, { token: reconsented });

  await marker('cutover-ready');
  await wait('restore-ready');
  origin = stable;
  for (const token of [first, second, reconsented]) await http(sso + '/workspace', 401, { token });
  await http(prefix + '/conversations/' + primaryRoom.id, 200, currentScope);
  assert.ok(Date.now() - delayedAcrossRestore.started < 295_000, 'The restored callback must still have live correlation.');
  await finish(await codeFrom(delayedAcrossRestore), 401);
  assert.deepEqual(await http(sso + '/link', 200, currentScope), { eligible: true, linked: false });
  await http(prefix + '/conversations/' + personalRoom.id, 200, { token: localToken });
  await http(prefix + '/conversations/' + outsideRoom.id, 200, { token: localToken, workspace: outsideOrg });
  assert.deepEqual(await finish(await start(localToken)), { mode: 'link', linked: true });
  const logoutWhileOff = await signIn();
  const unlinkWhileOff = await signIn();
  await marker('restore-verified');
  await wait('disabled-ready');
  assert.deepEqual(await http(sso + '/status', 200), { available: false });
  await http(sso + '/start', 403, { method: 'POST', body: { browserBinding: correlation() } });
  await http(sso + '/workspace', 403, { token: logoutWhileOff });
  assert.deepEqual(await http(sso + '/link', 200, currentScope), { eligible: false, linked: true });
  await http(sso + '/logout', 204, { token: logoutWhileOff, method: 'POST' });
  await unlink();
  assert.deepEqual(await http(sso + '/link', 200, currentScope), { eligible: false, linked: false });
  await http(prefix + '/conversations/' + personalRoom.id, 200, { token: localToken });
  await http(prefix + '/conversations/' + primaryRoom.id, 200, currentScope);
  await marker('off-verified');
  await wait('enabled-again');
  for (const token of [logoutWhileOff, unlinkWhileOff]) await http(sso + '/workspace', 401, { token });
  assert.deepEqual(await finish(await start(localToken)), { mode: 'link', linked: true });
  const afterCleanup = await signIn();
  await http(sso + '/workspace', 200, { token: afterCleanup });
  const revoked = await http(control, 200, { token: await fixture.machineToken(), method: 'PATCH',
    contentType: 'application/scim+json', body: {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    } });
  assert.equal(revoked.active, false);
  await http(sso + '/workspace', 401, { token: afterCleanup });
  await http(prefix + '/conversations/' + primaryRoom.id, 403, currentScope);
  await http(prefix + '/conversations/' + outsideRoom.id, 200, { token: localToken, workspace: outsideOrg });
  console.log(JSON.stringify({ realKeycloakAuthorizationCode: true, exactStateIssuerNonceAndPkce: true,
    currentLocalPasswordAndDevice: true, noAutoEnrollmentByEmailOrSubject: true, twoLoginPurposesIsolated: true,
    readOnlyCurrentWorkspaceAndOwner: true, durableExactLogoutUnlinkAndScim: true,
    preUnlinkLinkAndLoginRejected: true, oldCallbackFencedOnRestore: true,
    revocationsWhileOffSurviveReenable: true, passwordAccessUnaffected: true }));
} finally {
  await Promise.allSettled(tokens.map((token) => http(prefix + '/auth/logout', 204, { token, method: 'POST' })));
}
