const { BrowserWindow, Menu, dialog, session, shell } = require('electron');
const { allowsNavigation, allowsDownload, allowsResource, externalDestination, allowsClipboardWrite } = require('./policy.cjs');

const EMBEDDING_POLICY = "base-uri 'self'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'";
const MEDIA_POLICY = 'camera=(), microphone=(), display-capture=()';

function isolateSession(trustedOrigin) {
  const renderer = session.fromPartition('qingyu-assistant', { cache: false });
  function permissionGranted(contents, permission, url, { isMainFrame }) {
    if (!contents || contents.isDestroyed() || !allowsNavigation(contents.getURL(), trustedOrigin)) return false;
    return allowsClipboardWrite({
      permission, url, mainFrame: isMainFrame, focused: Boolean(BrowserWindow.fromWebContents(contents)?.isFocused()),
    }, trustedOrigin);
  }
  renderer.setPermissionCheckHandler((contents, permission, origin, details) =>
    permissionGranted(contents, permission, details.requestingUrl ?? origin, details));
  renderer.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(permissionGranted(contents, permission, details.requestingUrl, details)));
  renderer.setDevicePermissionHandler(() => false);

  renderer.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !allowsResource(details, trustedOrigin) });
  });

  renderer.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders ?? {};
    if (details.resourceType === 'mainFrame' && allowsNavigation(details.url, trustedOrigin)) {
      const key = Object.keys(headers).find((name) => name.toLowerCase() === 'content-security-policy') ??
        'Content-Security-Policy';
      headers[key] = [...(headers[key] ?? []), EMBEDDING_POLICY];
      const policy = Object.keys(headers).find((name) => name.toLowerCase() === 'permissions-policy') ??
        'Permissions-Policy';
      headers[policy] = [...(headers[policy] ?? []), MEDIA_POLICY];
    }
    callback({ responseHeaders: headers });
  });

  renderer.on('will-download', (event, item) => {
    if (!item.getURLChain().every((url) => allowsDownload(url, trustedOrigin))) {
      event.preventDefault();
      return;
    }
    item.setSaveDialogOptions({ title: '保存下载' });
  });
  return renderer;
}

async function confirmExternal(window, destination) {
  const { response } = await dialog.showMessageBox(window, {
    type: 'question',
    title: '打开外部链接',
    message: '在系统浏览器中打开这个链接？',
    detail: destination,
    buttons: ['取消', '打开链接'],
    cancelId: 0,
    defaultId: 0,
    noLink: true,
  });
  return response === 1;
}

function createAssistantWindow(trustedOrigin, renderer, {
  showWhenReady = true,
  confirm = confirmExternal,
  openExternal = (destination) => shell.openExternal(destination),
} = {}) {
  const window = new BrowserWindow({
    title: '青屿助手',
    width: 1180,
    height: 820,
    minWidth: 360,
    minHeight: 520,
    backgroundColor: '#f8faf8',
    show: false,
    webPreferences: {
      session: renderer,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: false,
      spellcheck: false,
    },
  });
  const contents = window.webContents;

  function guardNavigation(event) {
    if (!event.isMainFrame || !allowsNavigation(event.url, trustedOrigin)) event.preventDefault();
  }
  contents.on('will-frame-navigate', guardNavigation);
  contents.on('will-redirect', guardNavigation);
  contents.on('will-attach-webview', (event) => event.preventDefault());

  let pending = false;
  async function openAfterConfirmation(destination) {
    pending = true;
    try {
      if (await confirm(window, destination) && !window.isDestroyed() &&
          allowsNavigation(contents.getURL(), trustedOrigin)) {
        await openExternal(destination);
      }
    } catch {
      if (!window.isDestroyed()) {
        await dialog.showMessageBox(window, {
          type: 'error',
          message: '无法打开系统浏览器。',
          buttons: ['确定'],
        }).catch(() => undefined);
      }
    } finally {
      pending = false;
    }
  }

  contents.setWindowOpenHandler(({ url, postBody }) => {
    const destination = externalDestination(url);
    if (!pending && !postBody && destination && !allowsNavigation(url, trustedOrigin) &&
        allowsNavigation(contents.getURL(), trustedOrigin)) {
      void openAfterConfirmation(destination);
    }
    return { action: 'deny' };
  });

  if (showWhenReady) window.once('ready-to-show', () => window.show());
  return window;
}

function installApplicationMenu({ openWorkbench } = {}) {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu', label: '青屿助手' }] : []),
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { type: 'separator' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'togglefullscreen', label: '切换全屏' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
    ...(openWorkbench ? [{ label: '工具', submenu: [
      { label: '本地代码工作台', click: openWorkbench },
    ] }] : []),
  ]));
}

module.exports = { createAssistantWindow, isolateSession, installApplicationMenu };
