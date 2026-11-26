# 青屿助手桌面版

Electron 宿主在 Windows 和 macOS 复用青屿助手的 Web 界面。渲染进程使用沙箱、上下文隔离和进程内会话。窗口导航、资源请求和下载都受已配置的 Web 源地址约束。外部 HTTPS 链接需要在系统对话框确认后才会交给浏览器。剪贴板权限限定为前台可信主页面的安全写入，系统菜单提供复制、粘贴与缩放快捷键。 [Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)

桌面宿主默认关闭摄像头、麦克风和屏幕采集权限。项目图像页面提供 PNG 文件入口，常规文字聊天可继续使用。Windows Electron 原生自测验证这三项权限在可信主页面仍受限。

## 本地运行

在本目录使用 Node.js 22.12 或更新版本。先启动 Web 工程，默认本机入口为 `http://127.0.0.1:3000`。需要聊天联调时，在 Web 工程配置其所用的助手后端。

```powershell
npm ci
$env:ASSISTANT_DESKTOP_WEB_ORIGIN = 'http://127.0.0.1:3000'
npm start
```

部署时将 `ASSISTANT_DESKTOP_WEB_ORIGIN` 设为可信的 HTTPS 源地址。请使用 Web 服务的最终源地址，以免跨域重定向被拦截。开发时可用本机 HTTP 回环地址。

## 本地代码工作台

在桌面菜单选择「工具 → 本地代码工作台」。也可使用 `npm start -- --workbench` 独立打开工作台。选取 [`samples/local-workbench`](samples/local-workbench) 后，在会话中编辑 `main.cjs`，保存修订，核对逐行差异并确认审阅，然后选择「验证已审阅修订」。当前修订可以导出 SHA-256、诊断和本机 V8 编译缓存组成的 JSON 报告。 [语法验证和权限验收](../../qa/assistant-local-code-workbench.md)

工作台读取目录中的样例标记和一个 UTF-8 源文件，支持 32 KiB、400 行和 24 个修订。选择导出目录后，应用新建当前修订的报告文件。同名文件需要改选目录。撤销目录授权或关闭、重载工作台窗口会清除会话副本。验证检查 JavaScript 语法，应用运行测试需在项目环境单独完成。 [V8 Script 编译接口](https://nodejs.org/api/vm.html#new-vmscriptcode-options)

### 桌面接续

使用本机开发实例时，将 `ASSISTANT_DESKTOP_COMPANION_API_ORIGIN` 设为 API 的 `http://127.0.0.1:<端口>`，然后从工作台的「桌面接续」登录。生成配对码后，用同一账号的 Android 调试端输入，回到桌面确认配对。选择、查看并确认审阅一个修订后，点「交给手机核对当前修订」。手机批准后，桌面需另外点「按手机批准验证」。修改修订、撤销目录授权或退出会中止旧任务。配对、批准和记录只在当前开发服务进程内有效。正式构建工作流使用本地代码工作台的一般验证入口。 [桌面接续验收](../../qa/assistant-desktop-companion.md)

## 打包和自测

```powershell
npm test
npm run test:electron
npm run test:workbench
npm run package -- --platform win32 --arch x64
npm run test:package
```

启动本机 Web 后，可以设置 `ASSISTANT_DESKTOP_REAL_WEB_TEST_ORIGIN` 为其 `127.0.0.1` 源地址，然后运行 `npm run test:electron` 检查实际登录页和注册切换。

Windows x64 的本地输出为 `dist/QingyuAssistant-win32-x64/qingyu-assistant.exe`。本次可执行文件的 SHA-256 为 `547b9f41299fc562c95d67dda1d79ccd421c0211343fbbc0b6f4d54cbc8cac13`。将整个输出目录作为应用包保留。启动打包程序时同样需要设置 `ASSISTANT_DESKTOP_WEB_ORIGIN`。

```powershell
$env:ASSISTANT_DESKTOP_WEB_ORIGIN = 'http://127.0.0.1:3000'
.\dist\QingyuAssistant-win32-x64\qingyu-assistant.exe
```

在 macOS 上可使用 `npm run package -- --platform darwin --arch arm64`。Intel Mac 使用 `--arch x64`。Windows 的 arm64 目标也可用相同参数生成。

本机已使用 Electron 45.4.1 通过四组策略自测、真实 Windows 窗口进程测试和打包启动测试。Windows 测试覆盖同源导航、外域跳转与请求的拦截、位置权限拦截、外部链接确认策略、系统菜单项目以及既有 Web 登录页的加载和交互。渲染沙箱内的 Markdown 下载通过 UTF-8 文件名和内容核对。打包产物启用了 ASAR 完整性验证。macOS 实机、Windows ARM64 实机、正式签名、公证及发布渠道的升级流程仍待验证。 [Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)
