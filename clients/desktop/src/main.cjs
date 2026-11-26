const { app, dialog } = require('electron');
const { createAssistantWindow, isolateSession, installApplicationMenu } = require('./host.cjs');
const { parseWebOrigin } = require('./policy.cjs');
const { createWorkbenchWindow, registerWorkbenchScheme, workbenchUrl } = require('./workbench-window.cjs');

app.enableSandbox();
app.setName('青屿助手');
registerWorkbenchScheme();

function start() {
  let window;
  let workbench;
  let trustedOrigin;
  let renderer;
  const workbenchOnly = process.argv.includes('--workbench');

  function showWorkbench() {
    if (!app.isReady()) return;
    if (workbench && !workbench.isDestroyed()) {
      if (workbench.isMinimized()) workbench.restore();
      workbench.show();
      workbench.focus();
      return;
    }
    const next = createWorkbenchWindow();
    workbench = next;
    next.once('closed', () => { workbench = undefined; });
    void next.loadURL(workbenchUrl).catch(() => {
      if (!next.isDestroyed()) next.destroy();
    });
  }

  async function load(active) {
    while (!active.isDestroyed()) {
      try {
        await active.loadURL(trustedOrigin);
        return;
      } catch {
        if (active.isDestroyed()) return;
        const { response } = await dialog.showMessageBox(active, {
          type: 'error',
          title: '连接失败',
          message: '暂时无法连接青屿助手。',
          detail: trustedOrigin,
          buttons: ['重试', '关闭窗口'],
          cancelId: 1,
          defaultId: 0,
        }).catch(() => ({ response: 1 }));
        if (response === 1) {
          if (!active.isDestroyed()) active.close();
          return;
        }
      }
    }
  }

  function show() {
    if (!renderer) return;
    if (window && !window.isDestroyed()) {
      if (window.isMinimized()) window.restore();
      window.focus();
      return;
    }
    window = createAssistantWindow(trustedOrigin, renderer);
    window.once('closed', () => { window = undefined; });
    void load(window);
  }

  app.on('second-instance', (_event, arguments_) => {
    if (workbenchOnly || arguments_.includes('--workbench')) showWorkbench();
    else show();
  });
  app.on('activate', workbenchOnly ? showWorkbench : show);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  void app.whenReady().then(() => {
    try {
      installApplicationMenu({ openWorkbench: showWorkbench });
      if (workbenchOnly) { showWorkbench(); return; }
      const configured = process.env.ASSISTANT_DESKTOP_WEB_ORIGIN;
      if (!configured && app.isPackaged) throw new Error('请配置 ASSISTANT_DESKTOP_WEB_ORIGIN。');
      trustedOrigin = parseWebOrigin(configured || 'http://127.0.0.1:3000');
      renderer = isolateSession(trustedOrigin);
      show();
    } catch (error) {
      dialog.showErrorBox('无法启动青屿助手', error.message);
      app.quit();
    }
  });
}

if (app.requestSingleInstanceLock()) start();
else app.quit();
