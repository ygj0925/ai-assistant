# 青屿助手 Web

独立的 Next.js App Router 客户端，共享根工程 `packages/contracts` 中的 TypeScript SDK 和 OpenAPI 类型。

## 本地运行

使用 Node.js 20.9 或更新版本。在本目录执行：

```powershell
npm ci --prefix ../../packages/contracts
npm run generate --prefix ../../packages/contracts
npm ci
$env:ASSISTANT_API_ORIGIN = 'http://127.0.0.1:18080'
npm run dev
```

访问 [本地 Web 工作区](http://localhost:3000)。Web 通过同源 `/api/assistant/v1` 路由访问助手后端。后端需要启用用户注册和至少一个文本模型。登录凭据、浏览中的运行游标和草稿保存在当前页面的内存中，退出会话时清除。

登录后可从历史回复提交举报。侧栏头像可查看生成额度和预留，或下载当前工作空间的个人数据。导出每次生成一份 JSON，界面会提示是否还有下一份。 [举报和后台权限](../../qa/assistant-moderation.md) · [个人数据导出](../../qa/assistant-privacy-export.md)

后端开放账号注销能力时，账号面板允许输入当前密码和 `DELETE` 确认。注销成功会退出此前的工作区并撤销所有设备的会话。 [注销与恢复演练](../../qa/assistant-erasure.md)

侧栏「项目」入口可创建项目、修改说明并筛选历史。使用对话菜单中的「移动到项目」可迁移原会话。启动后端时添加 `--assistant.jobs.enabled=true`，对话菜单将提供「后台导出」，侧栏可查看任务进度或下载当前选定分支的 Markdown。 [项目与后台任务验证](../../qa/assistant-jobs.md)

启用会话分享后，可从「对话操作」分享当前分支，也可在助手消息上分享单条回复。确认预览后生成限期链接。发布者在「管理分享」撤回链接，接收者登录后可保存独立副本。 [分享配置和撤回演练](../../qa/assistant-sharing.md)

## 验证

```powershell
npm run typecheck
npm run build
npx playwright install chromium
npm test
```

Playwright 默认以合成数据模拟助手服务。它使用 3100 和 3101 端口，覆盖注册、登录、会话管理、中文输入事件、Markdown 安全渲染、断线恢复、停止生成、下载和账号切换。

也可使用已经安装的 Chrome：

```powershell
$env:ASSISTANT_WEB_TEST_BROWSER = 'chrome'
npm test
```

启动本地实际助手后端并启用 `local-echo` 后，可执行后端联调。联调会向测试后端注册隔离账号并创建和删除临时对话。

```powershell
$env:ASSISTANT_WEB_TEST_API_ORIGIN = 'http://127.0.0.1:18080'
npm test
```

同时验证项目面板和后台导出时，给上述配置增加 `ASSISTANT_WEB_TEST_JOB_FEATURES=true`。本机 Chromium 已通过该用例。Windows Chrome 和 Android 模拟器的 Chrome 另已通过中文输入、键盘、125% 缩放、断网与恢复、Markdown 下载自测。Android 使用 Fcitx5 拼音输入法，并在生成中按系统 Home 键退到后台再返回。Safari 与真实设备仍需现场验证。 [跨浏览器自测](../../qa/assistant-web-platform.md)

验证分享旅程时，使用带独立删除日志的测试后端，设置 `ASSISTANT_WEB_TEST_SHARE_FEATURES=true`，然后运行 `npm test -- sharing-live.spec.ts`。

单独验证隐私功能时运行 `npm test -- privacy-modes-live.spec.ts`。按后端已启用的能力设置 `ASSISTANT_WEB_TEST_SHARE_RESTRICTION=true`、`ASSISTANT_WEB_TEST_TEMPORARY=true` 或 `ASSISTANT_WEB_TEST_MEMORY=true`。需要测试生产构建时，先运行 `npm run build`，再启用 `ASSISTANT_WEB_TEST_PRODUCTION=true`。 [临时对话](../../qa/assistant-temporary-chat.md) · [手动记忆](../../qa/assistant-memory.md)

准备好私有对象存储和回环扫描器后，设置 `ASSISTANT_WEB_TEST_ATTACHMENTS=true`，运行 `npm test -- project-attachments-live.spec.ts`。本机朗读测试默认使用可控语音夹具。具备真实本机语音且已选择系统 Chrome 时，还可设置 `ASSISTANT_WEB_TEST_NATIVE_SPEECH=true` 验证实际引擎。 [PNG 附件](../../qa/assistant-png-attachments.md) · [本机朗读](../../qa/assistant-local-read-aloud.md)

研究和定时提醒分别在隔离 API 启用后设置 `ASSISTANT_WEB_TEST_RESEARCH=true` 或 `ASSISTANT_WEB_TEST_REMINDERS=true`。运行 `npm test -- research-live.spec.ts` 或 `npm test -- reminders-live.spec.ts`。研究浏览器用例使用合成来源，提醒用例等待实际分钟边界并检查未读状态和删除。 [本地研究](../../qa/assistant-local-research.md) · [站内提醒](../../qa/assistant-reminders.md)

定制助手验收启用隔离注册表和 `local-echo`，设置 `ASSISTANT_WEB_TEST_CUSTOM_ASSISTANTS=true` 后运行 `npm test -- custom-assistants-live.spec.ts`。用例创建私有项目助手，将旧指令还原为新版本，在同项目对话选择此版本并校验本地资料检索结果。 [定制与版本验收](../../qa/assistant-custom-assistants.md)

「学习模式」内置图表练习，也可以导入结构化课程。文本答题与交互界面使用相同答案和解析，支持键盘及断网。执行 `npm test -- learning.spec.ts` 复测。 [学习与文本回退](../../qa/assistant-learning.md)

定时提醒的分享入口依赖 `reminder_templates` 能力。所有者在「分享设置」核对精确日程后生成链接，接收者登录核对后启用独立提醒。设置 `ASSISTANT_WEB_TEST_REMINDER_SHARES=true` 后运行 `npm test -- reminder-share-live.spec.ts`。 [分享权限与恢复](../../qa/assistant-reminder-templates.md)
