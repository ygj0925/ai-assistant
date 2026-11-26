const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { BrowserWindow, dialog, ipcMain, protocol, session } = require('electron');
const { WorkbenchError, WorkbenchStore } = require('./workbench-store.cjs');
const { DesktopCompanionClient } = require('./companion-client.cjs');
const { CompanionWorkbench } = require('./companion-workbench.cjs');

const scheme = 'qingyu-workbench';
const origin = `${scheme}://local`;
const page = `${origin}/index.html`;
const channel = 'qingyu:local-workbench';
const assets = new Map([
  [page, ['index.html', 'text/html; charset=utf-8']],
  [`${origin}/renderer.js`, ['renderer.js', 'text/javascript; charset=utf-8']],
  [`${origin}/companion.js`, ['companion.js', 'text/javascript; charset=utf-8']],
  [`${origin}/ui.css`, ['ui.css', 'text/css; charset=utf-8']],
]);
const csp = "default-src 'none'; script-src 'self'; style-src 'self'; object-src 'none'; " +
  "connect-src 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'";

function registerWorkbenchScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme, privileges: { standard: true, secure: true } }]);
}

function isolateWorkbenchSession() {
  const renderer = session.fromPartition('qingyu-local-code-workbench', { cache: false });
  if (renderer.protocol.isProtocolHandled(scheme)) return renderer;
  renderer.protocol.handle(scheme, async (request) => {
    const asset = assets.get(request.url);
    if (request.method !== 'GET' || !asset) return new Response(null, { status: 404 });
    const [file, type] = asset;
    return new Response(await readFile(path.join(__dirname, 'workbench', file)), { headers: {
      'Content-Type': type, 'Content-Security-Policy': csp, 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Permissions-Policy': 'camera=(), microphone=(), display-capture=()',
    } });
  });
  renderer.webRequest.onBeforeRequest(({ url, resourceType }, callback) => {
    callback({ cancel: !assets.has(url) || resourceType === 'subFrame' || (resourceType === 'mainFrame' && url !== page) });
  });
  renderer.setPermissionCheckHandler(() => false);
  renderer.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  renderer.setDevicePermissionHandler(() => false);
  renderer.on('will-download', (event) => event.preventDefault());
  return renderer;
}

async function selectDirectory(window, exporting) {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: exporting ? '选择验证报告的保存目录' : '选择自有青屿样例目录',
    buttonLabel: exporting ? '保存报告' : '读取样例',
    properties: ['openDirectory', ...(process.platform === 'darwin' ? ['noResolveAliases'] : []),
      ...(process.platform === 'win32' ? ['dontAddToRecent'] : [])],
  });
  return !canceled && filePaths.length === 1 ? filePaths[0] : undefined;
}

function createWorkbenchWindow({ chooseDirectory = selectDirectory, showWhenReady = true,
  companionOrigin = process.env.ASSISTANT_DESKTOP_COMPANION_API_ORIGIN } = {}) {
  const store = new WorkbenchStore();
  const companion = new CompanionWorkbench(store, new DesktopCompanionClient(companionOrigin));
  const window = new BrowserWindow({
    title: '青屿 · 本地代码工作台', width: 1120, height: 780, minWidth: 360, minHeight: 520,
    backgroundColor: '#f8faf8', show: false,
    webPreferences: {
      session: isolateWorkbenchSession(), preload: path.join(__dirname, 'workbench-preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, devTools: false, spellcheck: false,
    },
  });
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-frame-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());

  let nativePromptOpen = false;
  let generation = 0;
  function revoke() { generation++; companion.sourceChanged(); return store.clear(); }
  function resetWindow() { void companion.signOut(); revoke(); }
  contents.on('did-start-loading', resetWindow);
  contents.on('render-process-gone', resetWindow);

  async function withChooser(exporting, action) {
    if (nativePromptOpen) throw new WorkbenchError('请先完成已打开的目录选择。');
    nativePromptOpen = true;
    const ticket = generation;
    try {
      const selection = await chooseDirectory(window, exporting);
      if (ticket !== generation || window.isDestroyed()) throw new WorkbenchError('目录授权已失效。');
      return selection ? await action(selection) : null;
    } finally { nativePromptOpen = false; }
  }

  ipcMain.handle(channel, async (event, action, ...args) => {
    const sender = event.senderFrame;
    if (contents.isDestroyed() || event.sender !== contents || !sender || sender !== contents.mainFrame || sender.url !== page) {
      return { ok: false, message: '工作台操作仅在授权窗口可用。' };
    }
    try {
      const [id, revision, source] = args;
      let value;
      switch (action) {
        case 'choose': value = await withChooser(false, (selected) => {
          companion.sourceChanged();
          return store.select(selected);
        }); break;
        case 'snapshot': value = store.snapshot(); break;
        case 'clear': value = revoke(); break;
        case 'inspect': value = store.inspect(id, revision); break;
        case 'save':
          value = store.save(id, revision, source);
          if (value.revision !== revision) companion.sourceChanged();
          break;
        case 'review': value = store.review(id, revision); break;
        case 'build': value = store.build(id, revision); break;
        case 'export': value = await withChooser(true, (selected) => store.export(id, revision, selected)); break;
        case 'companionState': case 'companionLogin': case 'companionLogout': case 'companionOffer':
        case 'companionConfirm': case 'companionUnpair': case 'companionPublish': case 'companionBuild':
          value = await companion.perform(action, id, revision);
          break;
        default: throw new WorkbenchError('无效的工作台操作。');
      }
      return { ok: true, value };
    } catch (error) {
      return { ok: false, message: error instanceof WorkbenchError ? error.message : '暂时无法完成工作台操作。' };
    }
  });
  window.once('closed', () => {
    resetWindow();
    ipcMain.removeHandler(channel);
  });
  if (showWhenReady) window.once('ready-to-show', () => window.show());
  return window;
}

module.exports = { createWorkbenchWindow, registerWorkbenchScheme, workbenchUrl: page };
