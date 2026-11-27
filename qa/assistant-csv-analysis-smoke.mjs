import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const [address, mode = 'normal', evidenceDirectory] = process.argv.slice(2);
assert.ok(address, 'Specify an isolated QA API origin.');
const origin = new URL(address);
assert.ok(['http:', 'https:'].includes(origin.protocol) &&
  ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) &&
  origin.port && !['18080', '18090'].includes(origin.port) && origin.pathname === '/' &&
  !origin.username && !origin.password && !origin.search && !origin.hash,
'Use a dedicated loopback API on an explicit QA port other than 18090.');
assert.ok(['normal', 'disabled', 'restore'].includes(mode), 'Unknown CSV analysis verification mode.');
assert.equal(Boolean(evidenceDirectory), mode === 'restore', 'Restore mode requires a fresh evidence directory.');

const evidence = evidenceDirectory && resolve(evidenceDirectory);
const prefix = '/api/assistant/v1';
const accounts = [];
const resources = [];
let restoreConfirmed = false;

async function send(path, expected, { actor, method = 'GET', body, artifact = false } = {}) {
  const headers = { Accept: artifact ? 'text/csv, application/json' : 'application/json' };
  if (actor) {
    headers.Authorization = 'Bearer ' + actor.token;
    headers['X-Workspace-Id'] = actor.workspace;
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(new URL(prefix + path, origin), {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(8_000),
  });
  if (path.includes('/analysis')) assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
  if (artifact && response.status === 200) {
    assert.equal(response.status, expected, method + ' ' + path);
    assert.match(response.headers.get('content-type') ?? '', /^text\/csv;\s*charset=utf-8$/i);
    const disposition = response.headers.get('content-disposition') ?? '';
    assert.match(disposition, /^attachment\b/i);
    assert.match(disposition, /\banalysis\.csv\b/i);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    return Buffer.from(await response.arrayBuffer());
  }
  const result = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  const diagnostic = method + ' ' + path + ' received ' + response.status + ' ' + (result?.code ?? '');
  assert.equal(response.status, expected, diagnostic);
  if (response.status !== 204) assert.ok(result, diagnostic + ' without an API response body');
  return result;
}

async function register() {
  const credentials = { username: 'qa-csv-' + randomUUID().slice(0, 12), password: 'Qa.Csv-' + randomUUID() };
  const session = await send('/auth/register', 201, { method: 'POST', body: credentials });
  const actor = { id: session.user.id, token: session.accessToken, workspace: session.user.workspaceId };
  accounts.push(actor);
  return actor;
}

async function createProject(actor, name) {
  return (await send('/projects', 201, { actor, method: 'POST', body: { name } })).id;
}

function resourcePath(project, resourceId) {
  return '/projects/' + encodeURIComponent(project) + '/resources' +
    (resourceId === undefined ? '' : '/' + encodeURIComponent(resourceId));
}

async function addCsv(actor, project, name, content) {
  const resource = await send(resourcePath(project), 201, { actor, method: 'POST', body: { name, content } });
  resources.push({ actor, project, id: resource.id });
  return resource.id;
}

function start(actor, project, resource, valueColumn, status = 201) {
  return send(resourcePath(project, resource) + '/analysis', status,
    { actor, method: 'POST', body: { valueColumn } });
}

function analysis(actor, id, status = 200) {
  return send('/analysis/' + encodeURIComponent(id), status, { actor });
}

function artifact(actor, id, status = 200) {
  return send('/analysis/' + encodeURIComponent(id) + '/artifact', status, { actor, artifact: true });
}

async function capability(actor, expected) {
  const { capabilities } = await send('/capabilities', 200, { actor });
  assert.equal(capabilities.find(({ id }) => id === 'data_analysis')?.available, expected);
}

async function validation(owner, project) {
  const invalid = [
    ['missing column', 'unused,value\r\n1,2', 'different'],
    ['duplicate header', 'value,value\r\n1,2', 'value'],
    ['all blanks', 'meaning,value\r\nfirst,\r\nsecond,""', 'value'],
    ['extra column', 'meaning,value\r\nfirst,1,unexpected', 'value'],
    ['unclosed quote', 'meaning,value\r\n"unfinished,1', 'value'],
    ['unquoted quote', 'meaning,value\r\nbad"field,1', 'value'],
    ['exponent', 'value\r\n1e3', 'value'],
    ['formula', 'value\r\n=1+1', 'value'],
    ['too many integral digits', 'value\r\n1234567890123456789', 'value'],
    ['too many fractional digits', 'value\r\n0.1234567890123', 'value'],
    ['excess rows', 'value\r\n' + '1\r\n'.repeat(257), 'value'],
    ['excess columns', Array.from({ length: 33 }, (_, index) => 'c' + index).join(',') +
      '\r\n' + Array(33).fill('1').join(','), 'c0'],
  ];
  for (const [label, content, valueColumn] of invalid) {
    const resource = await addCsv(owner, project, label, content);
    assert.equal((await start(owner, project, resource, valueColumn, 400)).code, 'VALIDATION_ERROR', label);
  }

  const maximum = await addCsv(owner, project, 'maximum rows', 'value\r\n' + '+01.500\r\n'.repeat(256));
  const bound = await start(owner, project, maximum, 'value');
  assert.equal(bound.rowCount, 256);
  assert.equal(bound.valueCount, 256);
  assert.equal(bound.sum, '384');
  assert.equal(bound.mean, '1.5');
  assert.deepEqual(bound.logSummary, { blankValuesSkipped: 0, chartTruncated: true });
  assert.deepEqual(bound.series, Array.from({ length: 32 }, (_, index) => ({ row: index + 1, value: '1.5' })));
  const full = 'row,value\r\n' + Array.from({ length: 256 }, (_, index) => (index + 1) + ',1.5\r\n').join('');
  assert.deepEqual(await artifact(owner, bound.id), Buffer.from(full, 'utf8'));

  const columns = await addCsv(owner, project, 'distinct header case',
    '\ufeffTotal,total\r\n0.000000000001,4\r\n0,5\r\n');
  const upper = await start(owner, project, columns, 'Total');
  const lower = await start(owner, project, columns, 'total');
  assert.notEqual(upper.id, lower.id);
  assert.equal(upper.mean, '0.000000000001');
  assert.equal(lower.mean, '4.5');
}

async function normal(owner) {
  const outsider = await register();
  const sourceProject = await createProject(owner, '合成 CSV 项目');
  const siblingProject = await createProject(owner, '同账号的第二项目');
  const otherProject = await createProject(outsider, '异账号的项目');
  const before = await send('/usage', 200, { actor: owner });

  let visits = 0;
  const canary = createServer((request, response) => {
    visits++;
    response.writeHead(418).end();
  });
  canary.listen(0, '127.0.0.1');
  await once(canary, 'listening');
  try {
    const inertLink = 'http://127.0.0.1:' + canary.address().port + '/unrequested';
    const sample = '说明,值,序号\r\n"第一行,\r\n仍属同一单元",1.2500,1\r\n' + inertLink +
      ',,2\r\n"含有""引号""",-2.5,3\r\n参考🦀,3.255,4\r\n';
    const source = await addCsv(owner, sourceProject, '引用合成 CSV', sample);
    await start(undefined, sourceProject, source, '值', 401);
    await start(outsider, sourceProject, source, '值', 404);
    await start(outsider, otherProject, source, '值', 404);
    await start(owner, siblingProject, source, '值', 404);
    await start({ ...owner, workspace: outsider.workspace }, sourceProject, source, '值', 403);

    const [result, duplicate] = await Promise.all([
      start(owner, sourceProject, source, '值'), start(owner, sourceProject, source, '值'),
    ]);
    assert.deepEqual(result, duplicate);
    const { id, createdAt, durationMillis } = result;
    assert.match(id, /^[a-f0-9-]{36}$/i);
    assert.ok(Number.isFinite(Date.parse(createdAt)));
    assert.ok(Number.isInteger(durationMillis) && durationMillis >= 0 && durationMillis < 250);
    assert.deepEqual(result, {
      id, projectId: sourceProject, resourceId: source, column: '值', rowCount: 4, valueCount: 3,
      min: '-2.5', max: '3.255', sum: '2.005', mean: '0.668333333333',
      series: [{ row: 1, value: '1.25' }, { row: 3, value: '-2.5' }, { row: 4, value: '3.255' }],
      logSummary: { blankValuesSkipped: 1, chartTruncated: false },
      createdAt, durationMillis, algorithmVersion: 'csv_numeric_v1',
    });
    assert.deepEqual(await analysis(owner, id), result);
    assert.deepEqual(await artifact(owner, id), Buffer.from('row,value\r\n1,1.25\r\n3,-2.5\r\n4,3.255\r\n', 'utf8'));
    await analysis(undefined, id, 401);
    await artifact(undefined, id, 401);
    await analysis(outsider, id, 404);
    await artifact(outsider, id, 404);
    await artifact({ ...owner, workspace: outsider.workspace }, id, 403);
    await artifact(owner, randomUUID(), 404);

    await validation(owner, sourceProject);
    await send(resourcePath(sourceProject, source), 204, { actor: owner, method: 'DELETE' });
    await start(owner, sourceProject, source, '值', 404);
    await analysis(owner, id, 404);
    await artifact(owner, id, 404);
    assert.equal(visits, 0, 'CSV data should not trigger requests to the loopback canary.');
    assert.deepEqual(await send('/usage', 200, { actor: owner }), before);
  } finally {
    await new Promise((resolve, reject) => canary.close(error => error ? reject(error) : resolve()));
  }
  console.log(JSON.stringify({
    exactAggregatesAndCsv: 'passed', validatedBoundsAndUntrustedCells: 'passed', idempotency: 'passed',
    ownerAndWorkspaceScope: 'passed', deleteSourceRevokesResult: 'passed',
    modelUsageUnchanged: true, loopbackCanaryRequests: 0,
  }));
}

async function mark(name, value = {}) {
  const filename = join(evidence, name + '.json');
  await writeFile(filename + '.tmp', JSON.stringify(value) + '\n', { encoding: 'utf8', flag: 'wx' });
  await rename(filename + '.tmp', filename);
}

async function waitForMarker(name, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  do {
    try {
      await access(join(evidence, name + '.json'));
      return;
    } catch (failure) {
      if (failure.code !== 'ENOENT') throw failure;
    }
    await delay(250);
  } while (Date.now() < deadline);
  assert.fail('The backup fixture did not create ' + name + '.json.');
}

async function restoredCapability(owner) {
  const deadline = Date.now() + 85_000;
  do {
    try {
      await capability(owner, true);
      return;
    } catch (failure) {
      if (!(failure instanceof TypeError || failure.name === 'TimeoutError')) throw failure;
    }
    await delay(400);
  } while (Date.now() < deadline);
  assert.fail('The restored analysis fixture did not become available.');
}

async function restore(owner) {
  const project = await createProject(owner, '合成分析恢复验证');
  const removedResource = await addCsv(owner, project, '备份后删除的资料', 'value\r\n15.5\r\n6.25\r\n');
  const retainedResource = await addCsv(owner, project, '保留的对照资料', 'value\r\n3.5\r\n2.5\r\n');
  const removed = await start(owner, project, removedResource, 'value');
  const retained = await start(owner, project, retainedResource, 'value');
  assert.deepEqual(await artifact(owner, removed.id), Buffer.from('row,value\r\n1,15.5\r\n2,6.25\r\n', 'utf8'));
  const retainedBytes = Buffer.from('row,value\r\n1,3.5\r\n2,2.5\r\n', 'utf8');
  assert.deepEqual(await artifact(owner, retained.id), retainedBytes);

  await mark('backup-ready', { accountId: owner.id, projectId: project,
    removedResourceId: removedResource, retainedResourceId: retainedResource,
    removedAnalysisId: removed.id, retainedAnalysisId: retained.id });
  await waitForMarker('backup-done');
  await send(resourcePath(project, removedResource), 204, { actor: owner, method: 'DELETE' });
  await analysis(owner, removed.id, 404);
  await artifact(owner, removed.id, 404);
  await mark('restore-ready');
  await waitForMarker('database-switched', 120_000);
  await restoredCapability(owner);
  await analysis(owner, removed.id, 404);
  await artifact(owner, removed.id, 404);
  await start(owner, project, removedResource, 'value', 404);
  assert.deepEqual(await analysis(owner, retained.id), retained);
  assert.deepEqual(await artifact(owner, retained.id), retainedBytes);
  assert.deepEqual(await start(owner, project, retainedResource, 'value'), retained);
  const summary = { erasedAnalysisStillUnavailable: true, erasedArtifactStillUnavailable: true,
    controlAnalysisAndArtifactUnchanged: true };
  await mark('summary', summary);
  restoreConfirmed = true;
  console.log(JSON.stringify(summary));
}

try {
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    assert.deepEqual(await readdir(evidence), [], 'Use an empty restore evidence directory.');
  }
  await capability(undefined, false);
  const owner = await register();
  await capability(owner, mode !== 'disabled');
  if (mode === 'restore') {
    await restore(owner);
  } else if (mode === 'normal') {
    await normal(owner);
  } else {
    const project = await createProject(owner, '关闭分析能力的项目');
    const resource = randomUUID();
    await start(undefined, project, resource, 'value', 401);
    assert.equal((await start(owner, project, resource, 'value', 403)).code, 'CAPABILITY_UNAVAILABLE');
    assert.equal((await analysis(owner, randomUUID(), 403)).code, 'CAPABILITY_UNAVAILABLE');
    console.log(JSON.stringify({ disabledCapability: 'passed' }));
  }
} finally {
  if (mode !== 'restore') {
    for (const { actor, project, id } of resources) {
      await send(resourcePath(project, id), 204, { actor, method: 'DELETE' }).catch(() => {});
    }
  }
  if (mode !== 'restore' || restoreConfirmed) {
    await Promise.all(accounts.map(actor => send('/auth/logout', 204, { actor, method: 'POST' }).catch(() => {})));
  }
}
