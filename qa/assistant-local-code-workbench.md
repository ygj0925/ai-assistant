# 本地代码工作台验收

桌面工作台使用独立的 Electron 窗口、进程内会话和自定义资源协议。主页面、脚本和样式均来自应用包内的固定资源。常规助手窗口继续按其 Web 源地址策略运行。工作台的预加载脚本仅公开专用操作，主进程核对发送窗口、主框架和页面地址。 [Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security) · [自定义协议](https://www.electronjs.org/docs/latest/api/protocol)

打开系统目录选择器后，只读取用户选定目录里的 `qingyu-workbench.json` 和 `main.cjs`。读取前后核对目录及普通文件的身份，并检查 UTF-8、32 KiB 和 400 行上限。样例副本和最多 24 个修订保存在窗口会话内。源码按 LF 保存，变更后需重新审阅。撤销、重载或关闭清除授权及会话数据。

工作台用 `vm.Script` 编译当前已审阅修订。报告包含修订号、编译器版本、源码 SHA-256、诊断和成功编译时的 V8 缓存。此步骤检查 JavaScript 语法。应用功能、依赖和运行行为需在项目环境单独验证。选择保存目录后按固定文件名创建 JSON，同名文件需要改选目录。 [V8 Script 编译接口](https://nodejs.org/api/vm.html#new-vmscriptcode-options)

## 复跑

在 `clients/desktop` 运行以下命令。工作台测试通过创建合成目录取得固定的选择或取消结果。测试窗口、进程隔离、权限校验、文件读取和导出均使用实际 Electron 进程。

```powershell
npm test
npm run test:electron
npm run test:workbench
npm run package -- --platform win32 --arch x64
npm run test:package
```

## 结果

2026 年 11 月 24 日，Windows x64 上的 Electron 45.4.1 拒绝目录链接、源文件硬链接、超限文件、旧修订及过期目录授权。语法错误显示诊断，有效源码的差异与历史版本可查看。测试源码里的字面标记按原文显示，其文件写入语句未触发。外部测试窗口的工作台调用被拒绝，工作台出站请求未到达隔离的回环测试服务。目录选择取消和保存过程中撤销均未写入文件。同名产物保留原字节。第 2 版报告的 1,238 字节内容与应用内结果一致，552 字节缓存可由相同的 V8 编译器读取。窄屏深色布局通过。 [Electron 结果](verify-results/local-code-workbench-2026-11-24/workbench-results.json) · [界面审阅](verify-results/local-code-workbench-2026-11-24/workbench-reviewed.png) · [语法验证结果](verify-results/local-code-workbench-2026-11-24/workbench-verification.png)

Windows x64 打包通过。打包应用用 `--workbench` 在独立配置中启动，实际载入工作台和专用接口。现有 Windows Web 宿主打包启动复测通过。 [独立工作台启动](verify-results/local-code-workbench-2026-11-24/standalone-launch.json)
