const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, Menu } = require('electron');
const { createAssistantWindow, installApplicationMenu, isolateSession } = require('../src/host.cjs');
const { parseWebOrigin } = require('../src/policy.cjs');

const cache = path.resolve(__dirname, '../.cache');
fs.mkdirSync(cache, { recursive: true });
const realWeb = process.env.ASSISTANT_DESKTOP_REAL_WEB_TEST_ORIGIN;
const result = path.join(cache, realWeb ? 'real-web-result.log' : 'fixture-result.log');
fs.writeFileSync(result, '');
function record(message) {
  fs.appendFileSync(result, message + '\n');
  console.log(message);
}
app.enableSandbox();

const controls = `<h1>青屿助手测试页面</h1>
  <a id="external" href="https://example.com/guide" target="_blank" rel="noopener noreferrer">外部链接</a>
  <a id="unsafe" href="http://example.com/" target="_blank">明文链接</a>`;
const servers = [];

async function fixture(handler) {
  const server = http.createServer(handler).listen(0, '127.0.0.1');
  servers.push(server);
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function until(condition) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await condition()) return;
    await delay(60);
  }
  throw new Error('Timed out waiting for an Electron smoke result.');
}

async function checkFixture() {
  let externalRequests = 0;
  let framesRequested = 0;
  let externalApproved = false;
  const confirmations = [];
  const opened = [];
  const other = await fixture((_request, response) => {
    externalRequests += 1;
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.end('outside');
  });
  const origin = await fixture((request, response) => {
    if (request.url === '/redirect') {
      response.writeHead(302, { Location: other + '/unexpected' }).end();
      return;
    }
    if (request.url === '/frame') framesRequested += 1;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(controls);
  });

  const renderer = isolateSession(origin);
  assert.equal(renderer.isPersistent(), false);
  const window = createAssistantWindow(origin, renderer, {
    showWhenReady: false,
    confirm: async (_window, candidate) => {
      confirmations.push(candidate);
      return externalApproved;
    },
    openExternal: async (candidate) => { opened.push(candidate); },
  });
  const contents = window.webContents;
  await window.loadURL(origin);
  assert.equal(await contents.executeJavaScript('document.querySelector("h1").textContent'), '青屿助手测试页面');
  assert.deepEqual(await contents.executeJavaScript('[typeof require, typeof process, typeof module, typeof electron]'),
    ['undefined', 'undefined', 'undefined', 'undefined']);
  assert.deepEqual(await contents.executeJavaScript(
    `['camera', 'microphone', 'display-capture'].map((feature) => document.featurePolicy.allowsFeature(feature))`,
  ), [false, false, false]);

  const ownPage = once(contents, 'did-finish-load');
  void contents.executeJavaScript('location.assign("/same-origin"); void 0').catch(() => undefined);
  await ownPage;
  assert.equal(contents.getURL(), origin + '/same-origin');
  assert.equal(await contents.executeJavaScript(
    `fetch(${JSON.stringify(other + '/api')}).then(() => false, () => true)`,
  ), true);

  const attemptedNavigation = once(contents, 'will-frame-navigate');
  void contents.executeJavaScript(`location.assign(${JSON.stringify(other)}); void 0`).catch(() => undefined);
  await attemptedNavigation;
  assert.equal(contents.getURL(), origin + '/same-origin');
  await assert.rejects(window.loadURL(origin + '/redirect'));
  assert.equal(contents.getURL(), origin + '/same-origin');

  await contents.executeJavaScript(`new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.src = '/frame';
    document.body.append(frame);
    setTimeout(resolve, 120);
  })`);
  assert.equal(framesRequested, 0);
  assert.equal(externalRequests, 0);
  assert.equal(await contents.executeJavaScript(`new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(() => resolve(0), (failure) => resolve(failure.code));
  })`), 1);

  await contents.executeJavaScript('document.querySelector("#unsafe").click()');
  await contents.executeJavaScript('document.querySelector("#external").click()');
  await until(() => confirmations.length === 1);
  assert.deepEqual(confirmations, ['https://example.com/guide']);
  assert.deepEqual(opened, []);
  externalApproved = true;
  await contents.executeJavaScript('document.querySelector("#external").click()');
  await until(() => opened.length === 1);
  assert.deepEqual(opened, ['https://example.com/guide']);
  assert.equal(BrowserWindow.getAllWindows().length, 1);

  const markdown = '# 青屿会话导出\n经过沙箱渲染的下载。\n';
  const downloadDirectory = fs.mkdtempSync(path.join(cache, 'download-'));
  const destination = path.join(downloadDirectory, '对话导出.md');
  const finished = new Promise((resolve, reject) => {
    renderer.once('will-download', (event, item) => {
      try {
        assert.ok(!event.defaultPrevented);
        assert.equal(item.getFilename(), '对话导出.md');
        assert.ok(item.getURL().startsWith(`blob:${origin}/`));
        item.setSavePath(destination);
        item.once('done', (_event, state) => resolve(state));
      } catch (error) {
        event.preventDefault();
        reject(error);
      }
    });
  });
  try {
    const click = contents.executeJavaScript(`(() => {
      const file = new Blob([${JSON.stringify(markdown)}], { type: 'text/markdown;charset=UTF-8' });
      const url = URL.createObjectURL(file);
      const link = document.createElement('a');
      link.href = url;
      link.download = '对话导出.md';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    })()`, true);
    const [state] = await Promise.all([finished, click]);
    assert.equal(state, 'completed');
    assert.equal(fs.readFileSync(destination, 'utf8'), markdown);
  } finally {
    if (fs.existsSync(destination)) fs.unlinkSync(destination);
    fs.rmdirSync(downloadDirectory);
  }

  installApplicationMenu();
  const items = Menu.getApplicationMenu().items.flatMap(({ submenu }) => submenu?.items ?? []);
  const roles = items.map(({ role }) => role?.toLowerCase());
  for (const role of ['copy', 'paste', 'selectall', 'reload', 'zoomin', 'zoomout', 'resetzoom', 'close']) {
    assert.ok(roles.includes(role), role);
  }
  record('Electron renderer, navigation, requests, permissions, external confirmation, Markdown download and native menu passed.');
}

async function checkRealWeb(value) {
  const origin = parseWebOrigin(value);
  assert.equal(new URL(origin).hostname, '127.0.0.1', 'Use a disposable loopback Web service for integration QA.');
  const window = createAssistantWindow(origin, isolateSession(origin), { showWhenReady: false });
  await window.loadURL(origin);
  const contents = window.webContents;
  await until(() => contents.executeJavaScript(
    'document.querySelector("h1")?.textContent.includes("登录青屿") && !!document.querySelector("input[autocomplete=username]")',
  ));
  await until(() => contents.executeJavaScript(`(() => {
    if (document.querySelector('h1')?.textContent === '创建账号') return true;
    Array.from(document.querySelectorAll('button')).find(
      (button) => button.textContent === '创建账号',
    )?.click();
    return false;
  })()`));
  record('The existing Web app rendered and hydrated inside the isolated Electron renderer.');
}

const watchdog = setTimeout(() => {
  record('Electron smoke exceeded its runtime budget.');
  app.exit(1);
}, 25_000);

void app.whenReady().then(async () => {
  let exit = 0;
  try {
    if (realWeb) {
      await checkRealWeb(realWeb);
    } else {
      await checkFixture();
    }
  } catch (error) {
    record(error.stack ?? String(error));
    exit = 1;
  } finally {
    clearTimeout(watchdog);
    for (const window of BrowserWindow.getAllWindows()) window.destroy();
    for (const server of servers) {
      server.closeAllConnections();
      server.close();
    }
    app.exit(exit);
  }
});
