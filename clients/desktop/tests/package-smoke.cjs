const assert = require('node:assert/strict');
const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { once } = require('node:events');
const { promisify } = require('node:util');
const { test } = require('node:test');

const run = promisify(execFile);
const root = path.resolve(__dirname, '..');

test('the Windows packaged app loads its isolated renderer from the configured Web origin', { timeout: 25000 }, async (t) => {
  assert.equal(process.platform, 'win32');
  const executable = path.join(root, 'dist', `QingyuAssistant-win32-${process.arch}`, 'qingyu-assistant.exe');
  assert.ok(fs.existsSync(executable), 'Package Windows before running this smoke.');
  const cache = path.join(root, '.cache');
  fs.mkdirSync(cache, { recursive: true });
  const profile = fs.mkdtempSync(path.join(cache, 'packaged-profile-'));

  let markReady;
  const pageReady = new Promise((resolve) => { markReady = resolve; });
  const server = http.createServer((request, response) => {
    if (request.url === '/ready') {
      markReady(request.headers['user-agent']);
      response.end('ok');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<script>if (typeof process === "undefined" && typeof require === "undefined") fetch("/ready");</script>');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });

  const child = spawn(executable, [`--user-data-dir=${profile}`], {
    cwd: root,
    env: { ...process.env, ASSISTANT_DESKTOP_WEB_ORIGIN: `http://127.0.0.1:${server.address().port}` },
    windowsHide: true,
    stdio: 'ignore',
  });
  t.after(async () => {
    if (child.pid && child.exitCode === null) {
      await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    }
  });
  const userAgent = await Promise.race([
    pageReady,
    once(child, 'exit').then(([code]) => { throw new Error('Packaged Electron exited before loading its renderer: ' + code); }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Packaged Electron renderer did not report ready.')), 16000);
      timer.unref();
    }),
  ]);
  assert.match(userAgent, /Electron\/45\.4\.1/);
});
