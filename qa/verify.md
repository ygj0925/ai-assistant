# 工程自测与运行证据

在项目根目录执行 `node qa/verify.mjs`。验证入口需要 Node.js 20.9 或以上版本，后端层另需 JDK 17 或以上版本以及助手后端工作树。后端可以放在 `services/api`，也可以作为相邻的 `ai-assistant-api` 子模块。默认依次执行共享契约、后端单元测试及打包、API 集成自测和 Web 浏览器端到端测试。npm 依赖按锁文件安装，Playwright 按项目版本准备 Chromium。Linux CI 可加 `--with-browser-deps` 安装 Chromium 所需的系统依赖。 [Playwright CI 配置](https://playwright.dev/docs/ci)

## 本地测试环境

API 层使用已启动的隔离服务。标准服务需要 PostgreSQL、Redis、消费者注册、合成模型和 20–100 毫秒的模拟片段间隔。按账号和模型文档准备服务，保留默认的事件数量上限。运行脚本会写入随机生成的合成账号、会话和运行。 [账号服务启动](assistant-account.md) · [合成模型配置](assistant-model-gateway.md)

可以选择单层执行，也可为游标截断用例提供一个使用独立数据库和缓存命名空间的第二个服务。第二个服务配置 `--assistant.runs.retained-events=3`。两个服务使用同一套 Redis 实例时，给测试服务指定不同的 `REDIS_DB`，以隔离本地注册限流窗口。

```powershell
node qa/verify.mjs --only contracts,web
node qa/verify.mjs --only backend
node qa/verify.mjs --only api --api-url http://127.0.0.1:18090 --expired-api-url http://127.0.0.1:18081
node qa/verify.mjs --only contracts,web --skip-install
```

`--skip-install` 复用已安装的 npm 依赖和 Chromium。已安装系统 Chrome 时，可配合 `ASSISTANT_WEB_TEST_BROWSER=chrome`。`--help` 查看完整参数。API 层接受 HTTP 或 HTTPS 回环地址。Web 层生成共享契约，启动生产构建后对确定性的模拟 API 运行 Chromium 测试。在 Web 目录单独运行 `npm test` 时使用开发服务。可将 `ASSISTANT_WEB_TEST_API_ORIGIN` 设置为已启动的本地 API 地址，使用同一个 Playwright 入口验证真实后端。

## 持续集成

项目仓库的 GitHub Actions 工作流在拉取请求和主分支推送时执行契约测试、Web 浏览器测试和离线模型题集回归，并上传 JSON、日志和浏览器测试产物。模型回归使用进程内 SSE 夹具，文本和视觉报告位于 `qa/verify-results/m0-model/`。 [QA 工作流](../.github/workflows/qa.yml)

文档处理 Worker 的基础 CI 校验请求格式和 Unicode 文本限制。需要 Linux 隔离运行时的测试在专用环境执行，WSL 的通用解析与中文 OCR 配置组合通过 13 项，独立英文模型配置通过 3 项。 [Worker 运行与独立验证](../services/document-worker/README.md#测试)

并行客户端检查包含 Electron 来源、导航及权限策略单测，以及 React Native 类型检查和 Android、iOS Hermes 打包。Windows 实际窗口和 macOS 签名测试需在各自的目标平台运行。 [桌面验证](../clients/desktop/README.md) · [移动验证](../clients/mobile/README.md)

主分支触发的后端 CI 检出独立工作树到 `services/api`。团队远端的 GitHub 仓库标识填入 `ASSISTANT_BACKEND_REPOSITORY`，完整产品提交填入 `ASSISTANT_BACKEND_COMMIT`。私有后端可在 `ASSISTANT_BACKEND_READ_TOKEN` 提供仅限该仓库的读取凭据。作业核对实际检出提交，再使用 Temurin 21.0.10 调用本工程的 Maven 验证入口。外部拉取请求不运行该作业。本地静态检查及五条 Bash 校验通过，包含错误提交与错误来源拒绝，GitHub 托管运行待团队远端接通。真实 API 回归另需运行在回环地址的隔离服务。 [后端 CI](../.github/workflows/qa.yml) · [本地配置校验](verify-results/backend-quality-workflow-2026-11-24/workflow-guards.json) · [GitHub 独立仓库检出](https://github.com/actions/checkout#checkout-multiple-repos-private)

## 查看运行结果

每次执行创建 `qa/verify-results/<UTC 时间>-<进程号>/`。其中 `summary.json` 提供总体状态及各检查的状态、日志文件、运行时间和进程退出码。单个检查失败时继续运行其他独立检查，依赖失败的检查记录为 `skipped`。全部所选检查通过时进程返回 `0`，测试失败时返回 `1`，参数或入口运行错误时返回 `2`。

隔离多页 PDF 和组织目录停用合入后，标准入口通过 29 项共享契约测试、160 项助手模块测试和四项真实 API 回归，生产构建的 Chrome 通过 12 项默认场景。其余按能力启用并在专项运行保存证据。已单独验证组织目录的实际签名、并发与旧库恢复，以及 PDF 解析、扫描件标记、下载确认和撤权。 [标准入口](verify-results/2026-11-24T12-19-41-271Z-53932/summary.json) · [目录停用](assistant-organization-directory.md) · [PDF 和扫描件](assistant-project-pdf.md)

含单页 OCR 和组织 SSO 的候选通过 31 项共享契约测试、162 项助手模块测试、Maven 静态检查与打包，以及四项真实 API 回归。Next.js 生产构建通过 TypeScript 和 12 项默认 Chrome 场景。51 项专项受运行配置限制，由相应证据覆盖其已验证的范围。实际 Keycloak 浏览器登录、私有 OCR 和移动端下载已在隔离环境单独验证。 [完整运行](verify-results/2026-11-24T13-06-00-733Z-50292/summary.json) · [Keycloak 浏览器](verify-results/organization-sso-2026-11-24/browser-final.log) · [OCR 浏览器](verify-results/pdf-ocr-2026-11-24/browser.log)

| 阶段 | 用例与证据 |
| --- | --- |
| M0 | [功能与渠道追踪](m0-capability-trace.md)、[后端基线](m0-backend-baseline.md)、[供应商和真机联调准备](m0-live-readiness.md) |
| M1 | [API 契约](../packages/contracts/README.md)、[消费者账号](assistant-account.md)、[会话和历史](assistant-conversation.md)、[运行与账本迁移](assistant-run-storage.md)、本入口生成的运行结果 |
| M2、M3 | [私有项目、后台导出及重启验收](assistant-jobs.md)、[对话分享及撤回恢复](assistant-sharing.md)、[来源检索](assistant-retrieval.md)、[项目文本资料](assistant-project-resources.md)、[私有 CSV 分析与恢复](assistant-csv-analysis.md)、[临时对话](assistant-temporary-chat.md)、[手动记忆](assistant-memory.md)、[私有 PNG 附件](assistant-png-attachments.md)、[浏览器本机朗读](assistant-local-read-aloud.md) |

2026 年 11 月 22 日，12 项共享契约测试、Web 生产构建、在该构建上执行的 7 项 Chrome 浏览器测试均通过。后端 API 的账号、会话和标准流式运行在最新打包版上复测通过。过期游标与容量裁剪使用独立配置的服务验证。独立后端 Maven `verify` 通过，包含 33 项助手模块单测。 [账号注销与数据库恢复](assistant-erasure.md) · [并发与重启演练](assistant-resilience.md)

接入项目与后台导出后，15 项 SDK 测试和 36 项助手模块单测通过。Web 生产版在模拟 API 和实际 PostgreSQL 后端分别通过 7 项与 6 项浏览器用例，两个环境按能力执行各自适用的用例。 [私有项目和后台导出演练](assistant-jobs.md)

2026 年 11 月 24 日，带临时对话、记忆编辑、分享限制及运行撤权的后端通过 Maven `verify`，22 项 SDK 测试通过。生产 Web 在真实服务上通过全部三项隐私用例。隔离 API 回归覆盖账号、历史、运行、资料导出及撤权后预留释放。 [记忆与恢复](assistant-memory.md) · [个人资料导出](assistant-privacy-export.md) · [运行撤权](assistant-run.md)

加入私有 PNG 和本机朗读后，Maven `verify` 中的 53 项助手测试、23 项 SDK 测试和 Web 生产构建通过。Chrome 对生产构建和模拟 API 通过 11 项适用用例，其中本机语音使用真实浏览器语音引擎启动及停止。真实后端、扫描器和对象存储另通过 Web PNG 上传、预览、精确下载及撤权。附件关闭时再次通过原有账号注销和双设备撤权。 [扫描和下载授权](assistant-png-attachments.md) · [本机朗读](assistant-local-read-aloud.md)

本地模型的记忆上下文通过两套隔离配置、自定义指令预算、项目迁移、关闭及成员撤权的真实 HTTP 用例，生产 Web 验证回复格式和实际使用预算。个人导出在真实后端验证了三页共享上限、停用时保留的记忆、撤回内容过滤及已批准附件元数据。生产 Web 单独验证从账号界面导出本人的保留记忆。 [本地模型上下文](assistant-personalized-run.md) · [个人数据导出](assistant-privacy-export.md)

审核来源研究核验沿用与站内定时提醒通过独立后端 Maven `verify`，助手模块 75 项单测及共享 SDK 24 项测试通过。生产 Web 在真实 PostgreSQL 后端验收了两会话修订、旧审批冲突、报告下载和实际日历投递。Android API 36 验证了接续研究、报告保存、到期通知、过期、重启和账号隔离。 [研究验收](assistant-local-research.md) · [提醒验收](assistant-reminders.md)

定制助手及其运行绑定加入后，独立后端 Maven `verify` 的 79 项助手单测通过。PostgreSQL 恢复、MySQL 增量和 Chrome 的版本回退实际通过。恢复后的服务重新通过账号、会话及持续生成的 API 回归。Web 生产构建通过 12 项模拟场景的 Chrome 测试，含离线学习和文本答题。Windows x64 使用本地 Electron 45.4.1 再次通过 4 项策略测试、真实窗口和打包启动。 [定制助手](assistant-custom-assistants.md) · [运行回归结果](verify-results/2026-11-24T03-22-52-705Z-21152/summary.json) · [学习模式](assistant-learning.md)

定时提醒分享和扩展导出加入后，Maven `verify` 的 83 项助手单测和共享 SDK 的 27 项测试通过。最新整包的真实 API 通过账号、会话、流式运行和个人数据导出回归。Chrome 通过 12 项适用的模拟场景以及独立服务上的分享和投递用例。Android 和 iOS 的 Hermes 导出通过。Pixel Tablet API 36 模拟器验证了横屏系统键盘、生成中进程重启和离线文本练习。 [计划分享](assistant-reminder-templates.md) · [个人数据导出](assistant-privacy-export.md) · [最新 API 回归](verify-results/2026-11-24T03-43-30-991Z-6028/summary.json)

项目邀请、共享文字和私有文稿加入后，Maven `verify` 的 84 项助手单测及 29 项共享 SDK 测试通过。两个新功能在隔离 PostgreSQL 初始化 110 个变更集，均通过实际旧库恢复和 MySQL 8.4 增量。生产 Chrome 验证双账号的查看角色和撤权，以及文稿回退、逐字节下载、从完成回复创建及撤回关联会话。Android 的虚拟后置相机通过授权、重拍、私有扫描和缓存清理。 [项目协作](assistant-project-collaboration.md) · [私有文稿](assistant-private-artifacts.md) · [Android 拍照](../clients/mobile/README.md#拍照上传私有-png)

加入文稿发布和个人历史文稿导出后，Maven `verify` 的 87 项助手单测、29 项共享 SDK 测试和 Web 生产构建通过。PostgreSQL 空库执行 112 个变更集，恢复与重启均为 0 个新增。双账号浏览器及独立日志恢复验证发布冻结版本、精确下载、旧会话和旧链接撤权。MySQL 8.4 验证发布记录只保存引用及所有权约束，个人导出实测四页和 60 个本人文稿版本。Android 真正断网时通过本机朗读，切换对话、打开历史、退后台、移出屏幕和手动停止均中止播放。 [项目文稿发布](assistant-project-artifact-publication.md) · [个人导出](assistant-privacy-export.md) · [Android 本机朗读](../clients/mobile/README.md#android-本机朗读)

复查修复了部分下载路由在客户端只声明文件媒体类型时返回 500 的问题。实际回环测试验证后台导出、CSV 分析、研究报告、私有文稿、公开给项目成员的文稿、图片和 SSE 七项入口在缺失身份时均返回 401、JSON 错误和禁止缓存的响应。后台导出、CSV 分析和研究报告也通过正常使用和撤权回归。 [媒体类型回归脚本](assistant-download-negotiation-smoke.mjs)

文稿版本评论和私有工作表接入后，Maven `verify` 的 92 项助手单测全部通过。修正请求正文解析后，既有 Markdown 创建和编辑重新通过实际 HTTP。PostgreSQL 空库运行 115 个变更集，同包重复启动执行 0 个新增。MySQL 8.4 隔离库验证了评论引用和工作表格式约束。Chrome 生产构建通过双账号评论、撤权以及工作表创建、类型输入、版本回退和下载。Python 独立读取下载的 XLSX，核对数字、布尔值和原样保存的公式样式字符串。评论旧库恢复保留正常对照，角色撤回、删除和作者注销均继续生效。 [评论与恢复](assistant-project-artifact-comments.md) · [工作表](assistant-spreadsheet.md)

Windows Chrome 生产构建的三个项目图片用例通过。验证了浏览器的摄像头拒绝与恢复、无音轨取帧、浏览器捕获源关闭、手动停止、未确认前无上传，以及真实私有对象存储与 ClamAV 的上传、扫描和撤回。 [Web 媒体取帧](assistant-png-attachments.md#web-摄像头与屏幕取帧)

Windows Chrome 生产构建的两个 WAV 用例通过。真实浏览器权限拒绝、撤回和断网均终止本机录音，未确认前无上传。显式上传后由隔离 ClamAV 扫描，下载检验规范头与非零 PCM 样本。Pixel Tablet 模拟器通过基础 PDF 系统选择、提取文本和保存期间撤回。 [Web 本机录音](assistant-project-audio.md#web-本机录音) · [Android PDF](assistant-project-pdf.md#回归验收)

共享 Markdown 与私有幻灯片加入后，Maven `verify` 的 96 项助手单测、共享 SDK 的 29 项测试、Web 生产构建和 12 项适用的模拟浏览器用例通过。实际 API 回归通过账号、历史及运行；PostgreSQL 从 115 增至 119 个变更集，重复启动为 0 个新增。真实 Chrome 验证协作冲突处理、恢复历史版本和失去角色后的读取拦截，以及幻灯片滚回旧内容后下载。Microsoft PowerPoint 16.0 与 Python 分别读取实际 PPTX。旧数据库恢复保留未受影响的协作文稿，并拒绝已撤销授权和已注销贡献者的衍生稿件。 [Chrome 与 SDK 回归](verify-results/2026-11-24T05-27-56-904Z-33260/summary.json) · [API 回归](verify-results/2026-11-24T05-29-24-357Z-44416/summary.json) · [共享文稿](assistant-project-shared-drafts.md) · [幻灯片](assistant-presentation.md)

Android API 36 通过原生阅读两个协作文稿版本、切换工作空间、查阅权限和撤权后清除已展示正文。系统恢复到前台时重新校验权限，接口暂时不可用时旧正文保持隐藏。Android 与 iOS Hermes 导出、移动端 TypeScript 检查通过。 [Android 实测](../clients/mobile/README.md#共享文稿)

独立的 API 36 x86_64 手机模拟器验证 Fcitx5 中文候选提交、键盘返回保留草稿和系统返回保留对话。生成途中强制停止再冷启动后，应用从同一次运行的序号 62 续流，展示一次完整回复。API 重启后，同键同请求仍返回原运行，不同正文返回 409，单次终态和账本保持一致。 [手机运行和账本结果](../clients/mobile/README.md#android-手机布局和中文输入)

源代码草案启用后，Maven `verify` 的 99 项助手单测通过。PostgreSQL 增量至 120 个变更集，MySQL 增量保留原有数据。Chrome 生产构建通过实际语言切换、原字节换行、版本回退和文本下载。关闭编辑后，既有草案仍可读取、导出和撤回，新建、编辑和回退均由服务端拒绝。 [代码稿验收](assistant-code-draft.md)

主动退出工作空间加入后，Maven `verify` 的 100 项助手单测通过，PostgreSQL 运行到 122 个变更集。Chrome 记录用户明确确认退出、服务端返回 204、回到个人空间及旧工作空间消失。还原退出前的快照后，旧授权、分享、进行中任务和关联结算按同一独立日志重放，新一代授权需重新申请。持有同工作空间分享链接的接收者可读文本，实际图片下载授权仍返回 404。 [退出工作空间](assistant-workspace-departure.md) · [分享与附件边界](assistant-sharing.md)

私有网页草案加入后，Maven `verify` 的 103 项助手单测通过，PostgreSQL 迁移至 123 个变更集。Chrome 验证沙箱内的版本内容、固定样式、字面标签无外部请求、HTML 下载和独立草案复制。Android 原生文件选择器通过文本格式和字节上限、确认前无写入、中文和 emoji 的字面检索、精确下载、前台恢复和旧标识撤权。 [网页草案](assistant-webpage.md) · [Android 文本资料](../clients/mobile/README.md#项目文本资料)

回复生成和限项目成员网页发布加入后，Maven `verify` 的 104 项助手单测通过。PostgreSQL 到 126 个变更集，重复启动为 0 个新增。Chrome 生产构建通过私有预览与复制、从回复生成后删除来源、明确选择旧版本并分享三条用例。真实协作权限、预览 503 时读取文本、旧浏览器访问撤回、HTML 字节、关闭再开启保留记录及旧 Markdown 发布均有测试记录。 [静态网页发布](assistant-webpage-publication.md) · [三条生产浏览器用例](verify-results/webpage-sharing-chrome-2026-11-24/browser.log)

Android Pixel Tablet API 36 验证私有产物版本阅读、前台重新授权和实际文件保存。Markdown、带 CRLF 的代码、空源文件、XLSX、PPTX 及 HTML 的设备落盘字节与服务响应一致。选择保存目录期间撤权，确认后没有生成新文件。 [Android 私有产物证据](../clients/mobile/README.md#私有产物) · [最新普通 API 回归](verify-results/2026-11-24T06-19-58-461Z-47632/summary.json)

会话阅读锁加入后，Maven `verify` 通过 106 项助手单测。真实 Chrome 双会话验证隐藏已打开正文、旧历史访问拒绝、密码错误仍可重试和正确密码恢复。PostgreSQL 旧库重放拦截旧会话、旧 SSE、报告、回复派生文稿和旧分享，保留独立对照。关闭新增锁开关后，既有锁继续生效，并可重新验证密码解锁。 [会话阅读锁验收](assistant-conversation-read-lock.md)

图片版本、历史引用和项目记忆来源加入后，Maven `verify` 通过 116 项助手单测，共享 SDK 通过 29 项测试，Web 生产构建通过。实际 Chrome、Android 和回环 API 分别复测私有图片精确字节、当前权限下的来源查看以及撤回。PostgreSQL 支持空库执行 133 个变更集以及旧库重放，符合撤回约束。 [私有 PNG](assistant-image-artifacts.md) · [历史引用](assistant-explicit-history.md) · [项目记忆来源](assistant-project-memory-sources.md)

公开网页托管、组织策略、主动助手和 PDF 文本提取加入后，Maven `verify` 通过 136 项助手测试。PostgreSQL 增量、独立旧快照重放和 MySQL 8.4 约束已验证。Chrome 生产构建通过站点更新与撤回、组织策略冲突、PDF 字面提取和授权撤回专题用例。Android 验证两种主动建议；实际故障注入核对一个坏调度记录不会阻塞另一个账号。Windows x64 的独立工作台通过实际 Electron IPC、语法检查与打包启动。 [托管](assistant-hosted-sites.md) · [组织策略](assistant-organization-policies.md) · [主动助手](assistant-local-proactive.md) · [PDF](assistant-project-pdf.md) · [工作台](assistant-local-code-workbench.md)

合成监护后端完成 166 至 170 的 PostgreSQL 增量迁移后，基础检查通过 29 项共享 SDK 测试、Web 生产构建、12 项适用 Chrome 用例和账号、会话、流式运行三条真实 API 用例。基础浏览器配置跳过 47 项需要专用能力与隔离配套服务的用例，已测专题在对应文档保存单独证据。 [合并结果](verify-results/2026-11-24T10-46-12-492Z-49480/summary.json) · [Chrome 结果](verify-results/2026-11-24T10-46-12-492Z-49480/web-e2e.log)

目录审核、组织日度用量和设备接续加入后，独立后端 Maven `verify` 通过 142 项助手测试。目录真实运营权限、旧库恢复和紧急关闭通过。PostgreSQL 从 157 项增量至 163 项时，旧运行和结算数一致。Windows Electron 与 Android 模拟器通过两轮当前修订审批及解绑。真实事务锁竞态证实先撤销设备会话后，等待中的手机审批失效。 [目录](assistant-reviewed-catalog.md) · [组织用量](assistant-organizations.md#组织用量汇总) · [设备接续](assistant-desktop-companion.md)

本地图片编辑和合成监护试点加入后，独立后端 Maven `verify` 通过 147 项助手测试。生产 Chrome 通过本地裁剪旋转、真实运营登记和用户明确授权与撤回。原图撤回后，恢复旧库及对象仍无法访问编辑派生图。合成监护从登记前和撤回前分别恢复两份备份，旧连接器权限保持关闭。PostgreSQL 完成 170 项变更，MySQL 8.4 配对迁移通过。 [图片编辑](assistant-local-image-edit.md) · [监护](assistant-guardian-eligibility.md)

加入组织模型用量上限后，Maven `verify` 的 152 项助手测试、Chrome 所有者复核以及 MySQL 两个事务的并发检验通过。PostgreSQL 有 172 项变更。恢复的旧库即使保留相同额度版本也无法新增运行，旧队列在生成任何回复之前安全终止。恢复一致的账本后，原上限和已结算的 14 个码点保留。 [组织月度预算](assistant-organization-model-budget.md)

共享回复、公开站点与提醒模板进入统一举报后，最新后端通过 154 项助手测试，PostgreSQL 在空库应用 175 项变更，在已有 170 项的库追加五项。独立 MySQL 增量保留旧举报与审计。完整本机验收通过契约、Maven 验证、四项实际 API（含过期游标）、生产构建和 12 项基础 Chrome 测试。基础浏览器配置中，48 项需专门配套服务；各主题的实际验收在相应报告记录。最终会话加锁包另通过分享、提醒和站点的四项生产 Chrome 测试。 [完整运行](verify-results/2026-11-24T11-33-29-370Z-53440/summary.json) · [实际主题浏览器](verify-results/content-moderation-final-chrome-2026-11-24/browser.log) · [运营权限](assistant-moderation.md)

同一 SDK 的移动端 TypeScript 严格检查与 Android、iOS Hermes 导出通过，Windows 桌面 11 项权限与工作台单元测试通过。已生成 Android 与 iOS 字节码摘要，签名与商店验证仍使用对应平台的真实环境。 [移动端构建与摘要](verify-results/mobile-final-2026-11-24/summary.json) · [Windows 验收](../clients/desktop/README.md)
