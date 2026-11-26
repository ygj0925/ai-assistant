# 项目产物版本的显式发布

项目所有者在私有产物里选择一个已保存的纯文本或 Markdown 版本，然后确认发布。项目编辑者和查看者持当前工作空间成员身份和项目角色阅读、下载该版本。私有产物的详情、其他版本、来源对话及附件仍遵循原有权限。产物后续编辑不会改变已经发布的版本。

发布服务仅保存版本与项目授权范围的引用。每个项目最多有 32 个有效发布。同一版本已经发布时再次提交会得到 409。撤回后可以重新明确发布，生成新的标识。逐次读取、下载都检查当前项目角色、原版本及来源。撤回发布或角色、删除产物及其来源对话会关闭相应旧地址。来源对话加锁后，旧发布保持失效，解锁后仍需重新确认发布。下载使用固定文件名，保留原始 UTF-8 字节并禁止缓存。

需要独立回环 API、消费者注册、本地模拟模型和已绑定的独立删除日志。发布验证还需开启 `assistant.project-collaboration.enabled`、`assistant.artifacts.enabled`、`assistant.project-artifact-publications.enabled`，并启用来源对话的分享限制操作。仅使用合成账号、项目、文稿和消息。

| 模式 | 命令 | 验证 |
| --- | --- | --- |
| 恢复 | `node qa/assistant-project-artifact-publication-smoke.mjs http://127.0.0.1:18130 restore <新证据目录> http://127.0.0.1:18131` | 定向成员、只读权限、精确版本、未公开头版本、UTF-8 下载、撤回、角色移除、来源删除、来源分享政策及备份重放。 |
| 关闭 | `node qa/assistant-project-artifact-publication-smoke.mjs http://127.0.0.1:18131 disabled <新证据目录>` | 保持基础协作和私有产物可用，关闭产物发布入口直接请求返回 403。 |

当 `membership-ready.json` 出现时，在独立源数据库为两个合成账号加入指定工作空间，并写入 `membership-added.json`。当 `snapshot-ready.json` 出现时，用原生 PostgreSQL 工具备份源库，随后写入 `snapshot-done.json`。等到 `revoke-ready.json`，停止源 API 并备份还原到空目标库。先核实旧授权和发布引用仍在备份内，再使用原独立删除日志与身份启动目标 API。确认重放完成后写入 `database-switched.json`。脚本继续使用备份前已有的会话和地址进行验证，最后写入 `summary.json`。验收标记只保留合成对象标识和结果。

此阶段提供只读的已选版本。共同编辑、评论、其他文档格式及第三方访问继续按单独的能力和验收条件推进。

2026-11-24，目标阶段在 PostgreSQL 通过全部 112 个 Liquibase 变更集，其中版本发布新增 2 个。由原生工具还原的旧库包含五个发布引用。使用原独立日志重放后，三个已撤回或源数据已删除的引用不再存在。原角色已撤销，保留的旧政策引用因当前分享政策版本不同无法使用。对照发布仍可读取及下载。恢复后仍可明确发布合格原版本，生成新标识。MySQL 8.4 隔离环境同时验证了错配版本、跨项目引用的外键约束、删除源产物级联以及发布表无标题和文本列。 [恢复前 SQL](verify-results/artifact-publication-1795494713247/restore/pre-replay-db.json) · [恢复后 SQL](verify-results/artifact-publication-1795494713247/restore/post-replay-db.json) · [严格 HTTP 验收](verify-results/artifact-publication-1795494713247/restore/summary.json) · [MySQL DDL](verify-results/artifact-publication-1795494713247/mysql-migration.json)

两套独立 Chrome 会话验证选定第一版、保留第二版的私有访问、Markdown 文件精确下载及撤回。回环 API 以只声明接受纯文本或 Markdown 的请求验证下载拒绝返回不缓存的 JSON 错误和准确的 401 或 404。Maven 全量验证及删除日志两项回归通过。关闭发布开关后基础协作和私有产物能力仍可用。 [关闭能力验收](verify-results/artifact-publication-1795494713247/disabled/summary.json)
