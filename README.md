# 青屿助手

这个独立工程包含跨平台 AI 助手的客户端、后端和验收工具。

本地默认数据库名为 `ai_assistant`，助手 API 地址为 `http://127.0.0.1:18090`，Web 和桌面页面入口为 `http://127.0.0.1:3000`。Web 的 `ASSISTANT_API_ORIGIN` 指向 API，桌面的 `ASSISTANT_DESKTOP_WEB_ORIGIN` 指向 Web。数据库连接与密码见 [本地依赖配置](infra/local/README.md)。

| 目录 | 内容 |
| --- | --- |
| [docs](docs/总体规划书.md) | 总体规划、架构和风险审查 |
| [openspec](openspec/changes/build-cross-platform-ai-assistant/tasks.md) | 当前变更、功能规范与实施进度 |
| [clients/web](clients/web/README.md) | Web 客户端及真实后端联调 |
| [clients/mobile](clients/mobile/README.md) | Expo 与 React Native 移动客户端 |
| [clients/desktop](clients/desktop/README.md) | Electron 桌面宿主与 Windows x64 本地包 |
| [packages/contracts](packages/contracts/README.md) | 消费者 OpenAPI、TypeScript SDK 和流式契约测试 |
| [infra/local](infra/local/README.md) | 本地数据库、缓存、对象存储及迁移验证 |
| [qa](qa/verify.md) | 统一自测入口、机器可读结果和阶段证据 |
| [ai-assistant-api](https://github.com/ygj0925/ai-assistant-api) | 基于 ContiNew Admin 的独立后端 Git 仓库 |

通过 `guard-find` 的 Git 子模块获取代码时，`ai-assistant` 和 `ai-assistant-api` 位于同一层。在父仓库根目录执行 `git submodule update --init -- ai-assistant ai-assistant-api` 下载对应版本。单独检出本项目时，可在本项目根目录执行 `git clone https://github.com/ygj0925/ai-assistant-api.git services/api`。自测脚本支持两种目录结构。

本机 QA 结果由测试命令生成到 `qa/verify-results/`，Android 本机验证产物生成到 `clients/mobile/.expo/`。

在项目根目录检查变更和运行合成模型用例。

```powershell
openspec status --change build-cross-platform-ai-assistant
node qa/verify.mjs --only contracts,web
```

在 Windows 上构建和验证后端。

```powershell
$backend = if (Test-Path 'services/api/continew-assistant/pom.xml') { 'services/api' } else { '../ai-assistant-api' }
Push-Location $backend
.\mvnw.cmd -B verify
Pop-Location
```

本地消费者接口支持账号、会话目录、历史搜索、持久化聊天、停止及按序续流。后端用独立的 PostgreSQL 和 Redis 配置启动，本地聊天使用确定性 `local-echo`。 [账号启动方式](qa/assistant-account.md) · [聊天运行与账本自测](qa/assistant-run.md) · [后端基线](qa/m0-backend-baseline.md)

举报采用独立的后台权限和工作空间授权。账户数据提供分页导出，生成用量可以通过消费者接口查询。 [举报权限自测](qa/assistant-moderation.md) · [数据导出](qa/assistant-privacy-export.md)

启用独立删除日志后，用户可在 Web 账号面板确认注销。恢复较早的数据库备份时，后端使用绑定的原日志重放注销与会话删除。订阅状态可用本地合成渠道验证。 [账号注销与恢复](qa/assistant-erasure.md) · [本地订阅对账](qa/assistant-billing-sandbox.md)

Web 可创建私有项目、填写说明并移动会话。后端启用 `--assistant.jobs.enabled=true` 后，可在对话菜单提交 Markdown 导出，在侧栏查看进度、取消任务或下载文件。 [项目与后台导出自测](qa/assistant-jobs.md)

Web 支持预览并发布会话分支或单条回复，接收方可创建独立副本。分享默认关闭，测试启用时需要绑定独立删除日志，以便恢复前次撤回。 [会话分享和撤回自测](qa/assistant-sharing.md)

真实模型、发行渠道和真机验收需要对应的联调环境，进度以 OpenSpec 中逐项记录的证据为准。 [联调条件](qa/m0-live-readiness.md)
