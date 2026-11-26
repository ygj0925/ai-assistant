const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { Script } = require('node:vm');
const { app, BrowserWindow, nativeTheme } = require('electron');
const { createAssistantWindow, isolateSession } = require('../src/host.cjs');
const { createWorkbenchWindow, registerWorkbenchScheme, workbenchUrl } = require('../src/workbench-window.cjs');
const { sampleSchema, maxSourceBytes } = require('../src/workbench-store.cjs');

app.enableSandbox();
registerWorkbenchScheme();
app.on('window-all-closed', () => { /* This harness closes after removing its fixtures. */ });

async function until(test, message) {
  const end = Date.now() + 7000;
  while (Date.now() < end) {
    const value = await test();
    if (value) return value;
    await delay(30);
  }
  throw new Error(message);
}

async function prepareSample(scratch, name, content) {
  const folder = path.join(scratch, name);
  await fs.mkdir(folder);
  await fs.writeFile(path.join(folder, 'qingyu-workbench.json'), JSON.stringify({ schema: sampleSchema, entry: 'main.cjs' }));
  if (content !== undefined) await fs.writeFile(path.join(folder, 'main.cjs'), content);
  return folder;
}

function hash(content) { return createHash('sha256').update(content).digest('hex'); }

async function reviewNative(workbench, profile, scratch, choices) {
  const contents = workbench.webContents;
  contents.setBackgroundThrottling(false);
  const execute = (expression) => contents.executeJavaScript(expression);
  const bridge = (method, ...args) => execute(`localWorkbench[${JSON.stringify(method)}](...${JSON.stringify(args)})`);
  const click = (id) => execute(`document.getElementById(${JSON.stringify(id)}).click()`);
  const status = (literal) => until(() => execute(`document.getElementById('status').textContent === ${JSON.stringify(literal)}`), literal);
  const failure = (literal) => until(() => execute(`document.getElementById('error').textContent.includes(${JSON.stringify(literal)})`), literal);
  const editor = (value) => execute(`(() => {
    const source = document.querySelector('#source'); source.value = ${JSON.stringify(value)};
    source.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  async function capture(name) {
    await execute('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const image = await contents.capturePage();
    assert.equal(image.isEmpty(), false);
    await fs.writeFile(path.join(profile, name), image.toPNG());
  }

  await workbench.loadURL(workbenchUrl);
  await until(() => execute('!document.querySelector("#choose").disabled'), 'workbench ready');
  assert.equal(await execute('document.querySelector("h1").textContent'), '本地代码工作台');
  assert.deepEqual(await execute('[typeof require, typeof process, typeof ipcRenderer]'), ['undefined', 'undefined', 'undefined']);
  assert.equal(await execute('document.querySelector("#workspace").hidden'), true);
  assert.equal(await execute('window.open("https://example.invalid") === null'), true);

  const original = 'const label = "first";\nmodule.exports = label;\n';
  const sourceRoot = await prepareSample(scratch, 'owned-sample', original);
  const symlink = path.join(scratch, 'linked-directory');
  await fs.symlink(sourceRoot, symlink, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await prepareSample(scratch, 'hardlinked-source');
  await fs.link(path.join(sourceRoot, 'main.cjs'), path.join(linked, 'main.cjs'));
  const oversized = await prepareSample(scratch, 'oversized-source', 'x'.repeat(maxSourceBytes + 1));
  const reportDir = path.join(scratch, 'approved-exports');
  const cancelledDir = path.join(scratch, 'revoked-exports');
  await fs.mkdir(reportDir);
  await fs.mkdir(cancelledDir);
  choices.push(undefined, symlink, linked, oversized, sourceRoot);
  await click('choose');
  await status('已取消选择目录。');
  for (const message of ['目录链接', '普通文件', '超过允许大小']) {
    await click('choose');
    await failure(message);
    assert.equal((await bridge('snapshot')).value, null);
  }

  // Use an independent copy once the hard-link fixture demonstrated the block.
  await fs.unlink(path.join(linked, 'main.cjs'));
  await click('choose');
  await status('已载入所选样例。');
  const first = (await bridge('snapshot')).value;
  assert.equal(first.source, original);
  assert.equal(first.revision, 1);
  assert.equal(await execute('document.querySelector("#verify").disabled'), true);
  assert.equal((await bridge('build', first.id, 1)).ok, false);
  assert.equal((await bridge('save', first.id, 1, '汉'.repeat(12000))).ok, false);
  assert.equal((await bridge('save', first.id, undefined, 'let x = 1;')).ok, false);

  const sideEffect = path.join(scratch, 'unexpected-runtime-marker');
  const modified = `const label = "<em>Literal QA markup</em>";\n` +
    `require('node:fs').writeFileSync(${JSON.stringify(sideEffect)}, label);\nmodule.exports = label;\n`;
  await editor(modified);
  await click('save');
  await status('已保存第 2 版。');
  assert.equal(await execute('document.querySelector("#diff em") === null'), true);
  assert.equal(await execute('document.querySelector("#diff").textContent.includes("<em>Literal QA markup</em>")'), true);
  assert.equal((await bridge('review', first.id, 1)).ok, false);
  await execute(`(() => { const selector = document.querySelector('#revision'); selector.value = '1';
    selector.dispatchEvent(new Event('change')); })()`);
  await until(() => execute(`document.querySelector('#literal-source').textContent === ${JSON.stringify(original)}`), 'show baseline revision');
  assert.equal(await execute('document.querySelector("#approve").disabled'), true);
  await execute(`(() => { const selector = document.querySelector('#revision'); selector.value = '2';
    selector.dispatchEvent(new Event('change')); })()`);
  await until(() => execute('!document.querySelector("#approve").disabled'), 'current revision reviewed view');
  await click('approve');
  await status('已确认审阅第 2 版。');
  await click('verify');
  await status('语法编译通过。');
  const built = (await bridge('snapshot')).value;
  assert.equal(built.report.sourceSha256, hash(modified));
  assert.equal(built.report.cacheBase64, undefined);
  await assert.rejects(fs.stat(sideEffect), { code: 'ENOENT' });

  choices.push(undefined, reportDir, reportDir);
  await click('export');
  await status('已取消导出。');
  assert.deepEqual(await fs.readdir(reportDir), []);
  await click('export');
  await status('已导出 qingyu-build-r2.json。');
  const output = path.join(reportDir, 'qingyu-build-r2.json');
  const bytes = await fs.readFile(output);
  const report = JSON.parse(bytes);
  const { cacheBase64, ...display } = report;
  assert.deepEqual(display, built.report);
  const cache = Buffer.from(cacheBase64, 'base64');
  assert.equal(cache.length, report.cacheBytes);
  assert.equal(hash(cache), report.cacheSha256);
  assert.equal(new Script(modified, { filename: 'main.cjs', cachedData: cache }).cachedDataRejected, false);
  await assert.rejects(fs.stat(sideEffect), { code: 'ENOENT' });
  await capture('workbench-reviewed.png');
  await execute('document.getElementById("build-details").scrollIntoView({ block: "center" }); void 0');
  await capture('workbench-verification.png');
  await execute('window.scrollTo(0, 0); void 0');
  await click('export');
  await failure('已有同名产物');
  assert.deepEqual(await fs.readFile(output), bytes);
  await fs.writeFile(path.join(profile, 'workbench-exact-build.json'), bytes);

  await editor('const incomplete = ;\n');
  await click('save');
  await status('已保存第 3 版。');
  assert.equal(await execute('document.querySelector("#verify").disabled'), true);
  assert.equal((await bridge('build', first.id, 2)).ok, false);
  assert.equal((await bridge('save', first.id, 1, 'const stale = 1;')).ok, false);
  await click('approve');
  await status('已确认审阅第 3 版。');
  await click('verify');
  await status('语法编译失败。可查看诊断。');
  assert.equal((await bridge('snapshot')).value.report.cacheBytes, 0);

  let openChooser;
  let finishChooser;
  const chooserOpened = new Promise((resolve) => { openChooser = resolve; });
  choices.push(() => new Promise((resolve) => { finishChooser = resolve; openChooser(); }));
  const late = bridge('export', first.id, 3);
  await chooserOpened;
  await click('clear');
  await status('已撤销目录授权。');
  finishChooser(cancelledDir);
  assert.equal((await late).ok, false);
  assert.deepEqual(await fs.readdir(cancelledDir), []);
  assert.equal(await execute('document.querySelector("#source").value'), '');
  assert.equal(await execute('document.querySelector("#literal-source").textContent'), '');
  assert.equal((await bridge('inspect', first.id, 2)).ok, false);

  choices.push(sourceRoot);
  await click('choose');
  await status('已载入所选样例。');
  const chosen = (await bridge('snapshot')).value;
  assert.equal(chosen.revision, 1);
  assert.notEqual(chosen.id, first.id);
  assert.equal((await bridge('save', first.id, 1, 'const staleRoot = true;')).ok, false);

  nativeTheme.themeSource = 'dark';
  workbench.setSize(390, 630);
  await until(() => execute('matchMedia("(prefers-color-scheme: dark)").matches && window.innerWidth < 400'), 'dark narrow desktop layout');
  assert.equal(await execute('document.documentElement.scrollWidth <= window.innerWidth'), true);
  assert.equal(await execute('document.querySelector("#choose").getBoundingClientRect().height >= 44'), true);
  await capture('workbench-narrow-dark.png');

  const reloaded = once(contents, 'did-finish-load');
  contents.reload();
  await reloaded;
  assert.equal((await bridge('snapshot')).value, null);
  assert.deepEqual(await fs.readFile(path.join(sourceRoot, 'main.cjs'), 'utf8'), original);
  return { passedRevision: report.revision, sourceSha256: report.sourceSha256, cacheBytes: cache.length,
    exportedBytes: bytes.length, exportedSha256: hash(bytes) };
}

async function main() {
  await app.whenReady();
  const profile = await fs.realpath(app.getPath('userData'));
  const scratch = await fs.mkdtemp(path.join(profile, 'isolated-sample-'));
  let requested = 0;
  const server = http.createServer((_request, response) => {
    requested++;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<h1>isolated assistant web fixture</h1>');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const web = `http://127.0.0.1:${server.address().port}`;
  const choices = [];
  const window = createWorkbenchWindow({ showWhenReady: false, chooseDirectory: async () => {
    assert.ok(choices.length, 'Only explicit, synthetic native selections are permitted in the harness.');
    const step = choices.shift();
    return typeof step === 'function' ? step() : step;
  } });
  let summary;
  try {
    const results = await reviewNative(window, profile, scratch, choices);
    const ordinary = createAssistantWindow(web, isolateSession(web), { showWhenReady: false });
    await ordinary.loadURL(web);
    assert.equal(await ordinary.webContents.executeJavaScript('typeof localWorkbench'), 'undefined');
    const foreign = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false,
      preload: path.join(__dirname, '../src/workbench-preload.cjs') } });
    await foreign.loadURL(web);
    const denial = await foreign.webContents.executeJavaScript('localWorkbench.choose()');
    assert.equal(denial.ok, false);
    assert.match(denial.message, /仅在授权窗口/);
    const companionDenial = await foreign.webContents.executeJavaScript('localWorkbench.companionState()');
    assert.equal(companionDenial.ok, false);
    assert.match(companionDenial.message, /仅在授权窗口/);
    const before = requested;
    const blocked = await window.webContents.executeJavaScript(`fetch(${JSON.stringify(web + '/blocked')}).then(() => false, () => true)`);
    assert.equal(blocked, true);
    assert.equal(requested, before);
    assert.deepEqual(choices, []);
    foreign.destroy();
    ordinary.destroy();
    summary = { runtime: process.versions.electron, platform: process.platform, ...results, linkedAndOversizedSelectionDenied: true,
      readOnlySourceAndLiteralRendering: true, staleAuthorityAndRevokedExportDenied: true, noRuntimeSideEffect: true,
      foreignBridgeRejected: true, foreignCompanionBridgeRejected: true, outboundRequestBlocked: true,
      cancelledPickerCreatesNothing: true, narrowDarkLayout: true,
      profile };
  } finally {
    server.closeAllConnections();
    server.close();
    for (const active of BrowserWindow.getAllWindows()) active.destroy();
    const owned = await fs.realpath(scratch);
    assert.equal(path.dirname(owned), profile);
    assert.match(path.basename(owned), /^isolated-sample-/);
    await fs.rm(owned, { recursive: true });
  }
  summary.syntheticScratchRemoved = true;
  await fs.writeFile(path.join(profile, 'workbench-results.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary));
}

const watchdog = setTimeout(() => app.exit(1), 45000);
main().then(() => app.exit(0), (error) => {
  console.error(error);
  app.exit(1);
}).finally(() => clearTimeout(watchdog));
