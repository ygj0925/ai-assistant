# 聊天运行和断线续流自测

在[消费者后端启动命令](assistant-account.md)中使用专用测试库 `assistant_m1_runs`，追加 `--assistant.models.mock-enabled=true --assistant.models.mock-delay-millis=100`。模拟模型使用合成数据，启动参数需要 `dev` 或 `test` 配置集。

在项目根目录运行标准测试，覆盖两个设备复用同一请求键、不同请求冲突、SSE 顺序和续流、分支编辑、重新生成、输出中停止、重试、删除，以及账号和工作空间隔离。

```powershell
$env:ASSISTANT_QA_EXPECT_SESSION_REVOCATION = 'true'
node qa/assistant-run-smoke.mjs http://127.0.0.1:18080
Remove-Item Env:ASSISTANT_QA_EXPECT_SESSION_REVOCATION
```

在标准测试结束后，将 `QA_POSTGRES_URL` 指向该专用库，并使用启动服务时相同的 `DB_USER` 和 `DB_PWD`。从 `services/api/continew-server/target/app` 运行账本探针，核对唯一终态、单次结算、预留释放及删除时的回复发布。

```powershell
java --class-path 'config;lib/*' '../../../../../qa/AssistantRunLedgerProbe.java'
```

另用隔离库启动事件裁剪测试实例，追加 `--server.port=18081 --assistant.runs.retained-events=3`。测试验证过期游标返回 HTTP `410`、权威快照仍包含完整回复、有效游标仍可读到终态。

```powershell
$env:ASSISTANT_QA_EXPECT_EXPIRED_CURSOR = 'true'
node qa/assistant-run-smoke.mjs http://127.0.0.1:18081
Remove-Item Env:ASSISTANT_QA_EXPECT_EXPIRED_CURSOR
```

本地账本按可见输出的 Unicode 码点结算。真实供应商计量、付费权益、渠道对账和退款验收另见 OpenSpec 任务 2.8 和 2.10。

2026 年 11 月 22 日，打包后端 Maven `verify`、标准 HTTP、事件裁剪和账本自测均通过。专用库核对了 12 次运行及其结算，其中两次主动或撤权取消。生成中删除会话后，数据库没有发布助手回复。账号、会话目录及历史搜索回归同时通过。

模型版本、举报、个人数据导出和用量接口接入后，再次检查专用库的 42 次已结束运行。每次仅有一个匹配终态，所有预留已释放，账本与各运行文字计量一致。6 次运行取消，包含 3 次生成中删除会话。旧消息历史检索回归再次通过。

消费者通过 `GET /api/assistant/v1/usage` 查询账户总额度、预留、已用和可用额度。单位为 `output_code_points`，即回复的可见 Unicode 码点。在启用了本地模型和模拟片段延时的隔离服务运行 `node qa/assistant-usage-smoke.mjs`，可验证生成过程中预留、停止或完成后的结算、匿名拦截和跨工作空间隔离。

最新打包后端在 2026 年 11 月 22 日通过用量自测，中文和 emoji 按可见码点结算，另一个账号的额度保持独立。

2026 年 11 月 24 日，使用带 70 毫秒模拟片段间隔的打包 API，在专用 PostgreSQL 库中加入并移除测试成员。移除后旧工作空间请求返回 403，正在运行的请求停止追加，已排队的请求未开始生成。恢复测试成员资格后，两次运行仍为取消状态，全部预留已释放，已用量只增加已交付内容的码点数。脚本通过 `add.json`、`remove.json`、`rejoin.json` 与隔离数据库驱动同步，每一步只修改标记里的合成成员。 [工作空间运行自测脚本](assistant-run-membership-smoke.mjs)
