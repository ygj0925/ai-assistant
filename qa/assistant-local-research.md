# 审核来源研究验收

使用隔离回环 API、数据库、Redis 与独立删除日志。启用 `assistant.retrieval.enabled`、`assistant.research.enabled` 和 `assistant.privacy.erasure-enabled`，并设置 `assistant.research.checkpoint-delay-ms=4000`。迁移完成后，可在测试 PostgreSQL 执行 `qa/assistant-research-catalog-pg.sql`。

创建计划时必须明确选定一至六个经审核的来源。计划保持待确认，直到任务所有者批准当前版本。执行过程有两个可恢复检查点。修订问题、来源或来源版本需要再次确认，取消时撤销现有批准。报告下载对当前账号、工作空间成员关系、计划版本、独立撤权日志、来源安全性和时效重新校验。

已批准任务通过来源核验检查点后，修订可沿用同一任务中来源标识、内容和核查版本均未变化的记录。`reusedSourceCount` 表示该修订沿用的数量。新增或刷新后的来源仍需核验，修订需要重新批准。最终完成和下载仍检查全部来源。旧数据升级后保留原有状态和报告条件，下一次任务实际执行核验时开始记录。

| 测试 | 入口 | 覆盖 |
| --- | --- | --- |
| 常规 | `node qa/assistant-local-research-smoke.mjs http://127.0.0.1:18114 enabled` | 工作空间权限、幂等、显式批准、运行中修订、旧批准冲突、新来源的纯文本报告、撤回和用量。 |
| 关闭 | `node qa/assistant-local-research-smoke.mjs http://127.0.0.1:18114 disabled` | 在关闭研究入口的独立 API 中确认请求被拒绝。 |
| 来源变化 | `node qa/assistant-local-research-smoke.mjs http://127.0.0.1:18114 source-change <空证据目录>` | 已完成的报告在关联来源刷新或撤回后禁止下载。等待 `source-change-ready.json`，更新合成来源，再创建 `source-change-applied.json`。 |
| 检查点与备份恢复 | `node qa/assistant-local-research-smoke.mjs http://127.0.0.1:18114 restore <空证据目录> http://127.0.0.1:18115` | 从旧备份恢复，已修订和已取消的旧批准无法重新执行或下载。未撤权的同一任务能继续完成。 |
| 修订沿用核验结果 | `node qa/assistant-local-research-smoke.mjs http://127.0.0.1:18119 lineage <空证据目录>` | 核对未获批准的草稿、已核验的未变化来源、新增和已刷新来源，以及重新批准和最终阶段撤回。 |

恢复测试使用时序标记。等待 `backup-ready.json`，保存当前源数据库的备份并创建 `backup-done.json`。等待 `restore-ready.json`，停止源 API，将备份导入独立数据库。用同一独立日志与日志 ID 启动还原 API，API 就绪后创建 `database-switched.json`。脚本写出 `summary.json`。

沿用核验结果测试先刷新合成来源甲，在 `lineage-proof-ready.json` 后检查指定修订。甲的 `verified_revision` 和 `verified_at` 应为空，未变化来源乙的 `verified_revision` 应为 3，随后创建 `lineage-proof-confirmed.json`。等待 `final-revoke-ready.json` 后将乙设为不可用，并创建 `final-revoke-applied.json`。脚本核对任务进入失败状态且禁止下载。测试结束后恢复两个合成来源原值。

当前研究读取服务端审核的固定文字来源，报告保留可核对链接、核查时间和审核证据。监督范围和跨端续接在该目录内验收。授权供应商及外部来源获取仍随检索接入任务验收。 [检索验收](assistant-retrieval.md)

2026-11-24，真实 PostgreSQL 与 Redis 回环环境通过常规、功能关闭、来源变化和备份恢复四种模式。源数据库的挂起任务在备份中处于 `running`、进度 50。恢复后继续完成同一任务，两个过时批准保持撤销。三项服务端权限测试和一项独立日志测试通过。

同日，增量检查点迁移在独立的 PostgreSQL 环境生效，常规回归与修订沿用核验测试均通过。数据库确认，新版本保留了乙的原始核验时间与来源指纹，已刷新的甲没有继承旧核验记录。乙在最终阶段撤回后，任务停止且报告无法下载。

生产 Web 在两个 Chrome 会话中通过研究中途修订。新计划沿用一项已核验的来源，另一个会话的旧批准被拒绝，重新批准后下载的报告仅包含当前计划选择的两个来源。MySQL 8.4 命名管道测试库应用新增检查点列和约束，迁移前后的三条审核来源保持一致。 [Web 端到端用例](../clients/web/tests/research-live.spec.ts)

同日使用实际 Chrome 和独立登录的 Android Pixel Tablet 会话完成同一任务的接力。Chrome 创建并审批版本 1，另一个会话在服务报告执行中时限定来源并保存版本 2。旧审批和未审批下载被拒绝，Android 显式批准版本 2，原 Chrome 恢复同一任务并下载 294 字节报告，与认证回查逐字节一致。合成引用题集的 3 个案例中 4 对陈述、证据与链接准确匹配，未出现额外来源，空选择和过期来源均拒绝。 [Chrome 记录](../clients/mobile/.expo/research-handoff-2026-11-24/chrome-verified.json) · [Android 审批](../clients/mobile/.expo/research-handoff-2026-11-24/android-approved.json) · [引用题集](verify-results/research-handoff-2026-11-24/citations.log)
