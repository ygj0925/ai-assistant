const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Script } = require('node:vm');
const { test } = require('node:test');
const { WorkbenchStore, maxSourceBytes, sampleSchema } = require('../src/workbench-store.cjs');

async function scratch(t) {
  const temp = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temp, 'qingyu-workbench-test-'));
  t.after(async () => {
    const current = await fs.realpath(root);
    assert.equal(current, root);
    assert.equal(path.dirname(current), temp);
    assert.match(path.basename(current), /^qingyu-workbench-test-/);
    await fs.rm(current, { recursive: true });
  });
  return root;
}

async function sample(root, name, source) {
  const folder = path.join(root, name);
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'qingyu-workbench.json'), JSON.stringify({ schema: sampleSchema, entry: 'main.cjs' }));
  if (source !== undefined) await fs.writeFile(path.join(folder, 'main.cjs'), source);
  return folder;
}

test('rejects linked roots, hard-linked source, missing marker and bounded UTF-8 violations', async (t) => {
  const root = await scratch(t);
  const valid = await sample(root, 'valid', 'let count = 1;\n');
  const alias = path.join(root, 'alias');
  await fs.symlink(valid, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await sample(root, 'linked');
  const secret = path.join(root, 'private-literal.cjs');
  await fs.writeFile(secret, 'const fixture = "not in root";');
  await fs.link(secret, path.join(linked, 'main.cjs'));
  const large = await sample(root, 'large', 'x'.repeat(maxSourceBytes + 1));
  const invalid = await sample(root, 'invalid', Buffer.from([0xc3, 0x28]));
  const noMarker = path.join(root, 'no-marker');
  await fs.mkdir(noMarker);
  const store = new WorkbenchStore();
  await assert.rejects(store.select(alias), /目录链接/);
  await assert.rejects(store.select(linked), /普通文件/);
  await assert.rejects(store.select(large), /超过允许大小/);
  await assert.rejects(store.select(invalid), /UTF-8/);
  await assert.rejects(store.select(noMarker), /样例标记/);
  assert.equal(store.snapshot(), null);
});

test('requires latest explicit review, verifies syntax, exports exact cache and revokes state', async (t) => {
  const root = await scratch(t);
  const before = 'const count = 1;\nmodule.exports = count;\n';
  const folder = await sample(root, 'owned', before);
  const output = path.join(root, 'reports');
  await fs.mkdir(output);
  const manifest = path.join(folder, 'qingyu-workbench.json');
  await fs.writeFile(manifest, '\uFEFF' + await fs.readFile(manifest, 'utf8'));
  const store = new WorkbenchStore();
  const initial = await store.select(folder);
  assert.equal(initial.revision, 1);
  assert.equal(initial.name, 'owned');
  assert.equal(initial.source, before);
  assert.throws(() => store.save(initial.id, undefined, 'let x = 1;'), /修订已变化/);
  assert.throws(() => store.save(initial.id, 1, '汉'.repeat(12000)), /32 KiB/);
  assert.throws(() => store.save(initial.id, 1, '\n'.repeat(400)), /400 行/);
  assert.throws(() => store.build(initial.id, 1), /请先审阅/);
  const next = store.save(initial.id, 1, 'const count = 2;\r\nmodule.exports = count;\r\n');
  assert.equal(next.revision, 2);
  assert.equal(next.source, 'const count = 2;\nmodule.exports = count;\n');
  assert.equal(store.inspect(initial.id, 1).source, before);
  const revision = store.inspect(initial.id, 2);
  assert.deepEqual(revision.rows.slice(0, 2), [
    { kind: 'remove', before: 1, text: 'const count = 1;' },
    { kind: 'add', after: 1, text: 'const count = 2;' },
  ]);
  assert.throws(() => store.review(initial.id, 1), /修订已变化/);
  store.review(initial.id, 2);
  const verified = store.build(initial.id, 2);
  assert.equal(verified.report.outcome, 'passed');
  assert.equal(verified.report.cacheBase64, undefined);
  await store.export(initial.id, 2, output);
  const exportFile = path.join(output, 'qingyu-build-r2.json');
  const bytes = await fs.readFile(exportFile);
  const report = JSON.parse(bytes);
  assert.equal(report.sourceSha256, createHash('sha256').update(next.source).digest('hex'));
  const cache = Buffer.from(report.cacheBase64, 'base64');
  assert.equal(cache.length, report.cacheBytes);
  assert.equal(new Script(next.source, { filename: 'main.cjs', cachedData: cache }).cachedDataRejected, false);
  await assert.rejects(store.export(initial.id, 2, output), /已有同名产物/);
  assert.deepEqual(await fs.readFile(exportFile), bytes);
  const broken = store.save(initial.id, 2, 'const invalid = ;\n');
  assert.equal(broken.report, null);
  await assert.rejects(store.export(initial.id, 2, output), /修订已变化/);
  store.review(initial.id, 3);
  const failed = store.build(initial.id, 3);
  assert.equal(failed.report.outcome, 'failed');
  assert.equal(failed.report.cacheBytes, 0);
  assert.equal(failed.report.diagnostics.length, 1);
  assert.equal(await fs.readFile(path.join(folder, 'main.cjs'), 'utf-8'), before);
  store.clear();
  assert.equal(store.snapshot(), null);
  assert.throws(() => store.inspect(initial.id, 1), /授权已失效/);
});
