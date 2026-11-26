# 工作空间内的项目协作验收

项目所有者可以通过同工作空间内的准确用户名邀请查看者或编辑者。邀请需本人确认，七天内可接受。成员退出、所有者撤销或相关账号注销会结束已接受的角色。每次访问都重新检查工作空间权限。改换角色时先撤销旧邀请或授权，再发出新的邀请。接受新邀请会使用新的标识。

协作区显示项目名称、角色和用户明确提交的文本。查看者可读。编辑者可新增并删除自己的协作文本。所有者可撤销角色、删除协作文本并继续通过私有项目页面管理个人项目内容。每个项目最多保存 64 份协作文本，每份最多 16 KiB。邀请角色不提供个人项目描述、对话、记忆、私有资料或附件的访问。协作接口不生成附件授权，也不创建工作空间成员身份。

需要在独立回环 API 上启用 `assistant.project-collaboration.enabled=true`、`assistant.project-resources.enabled=true`、消费者注册与绑定的删除日志。测试仅创建合成内容。邀请和协作文本的撤销在独立日志中保存，即使数据库从更早的备份恢复，旧访问仍应失效。

| 模式 | 命令 | 覆盖 |
| --- | --- | --- |
| 常规 | `node qa/assistant-project-collaboration-smoke.mjs http://127.0.0.1:18126 enabled <新证据目录>` | 工作空间成员限制、定向邀请、并发确认、私有资源隔离、角色权限、现有会话撤权、新授权、作者注销。 |
| 恢复 | `node qa/assistant-project-collaboration-smoke.mjs http://127.0.0.1:18126 restore <新证据目录> http://127.0.0.1:18127` | 常规用例及旧备份恢复后已撤回、已退出、已拒绝的邀请不可用，删除的协作文本不恢复。 |
| 关闭 | `node qa/assistant-project-collaboration-smoke.mjs http://127.0.0.1:18127 disabled <新证据目录>` | 在关闭协作功能的独立环境中验证能力标志和接口一致拒绝。 |

协同脚本在 `membership-ready.json` 中写出合成所有者的账号、工作空间和两个合成成员的 ID。测试驱动在独立数据库为这两个现有账号添加工作空间成员记录，然后写入 `membership-added.json`。观察到 `workspace-loss-ready.json` 后移除指定合成编辑者的工作空间成员记录并写入 `workspace-member-removed.json`。观察到 `workspace-loss-confirmed.json` 后恢复该合成成员记录并写入 `workspace-member-restored.json`。

恢复模式额外在 `snapshot-ready.json` 后用 PostgreSQL 原生工具备份，再写入 `snapshot-done.json`。随后验证撤回、退出、拒绝及文本删除。等 `revoke-ready.json` 后停止源 API，将备份恢复到空目标数据库。先验证旧行处于备份时状态，再用原独立日志和身份启动目标 API。查看目标 SQL 确认已重放的状态及文本，再写入 `database-switched.json`。验收脚本会使用源库签发的原会话再次检验权限，并写出 `summary.json`。标记文件仅保留合成标识和结果。

此阶段验证已显式共享的文本角色。项目迁移、现有私有聊天和附件的共同使用、客户端离线副本、跨工作空间发放组织身份不在此实现之中。

2026-11-24，独立 PostgreSQL 环境启动时共校验或应用 110 个 Liquibase 变更集，其中项目协作新增 3 个。恢复前后分别通过原生 SQL 和 HTTP 对照权限。恢复前存在两个已接受授权、一个待接受邀请及已删除文本。独立日志重放后，三个旧授权均已撤销，已删除文本缺失，未撤销的控制文本保留。原会话无法访问旧范围，重新发起的新邀请可正常接受。授权完成后注销文本作者，所有者和查看者都无法再读取该作者的协作文本。MySQL 8.4 隔离环境通过角色约束、外键作用域、级联清理和状态变更验证。 [恢复前 SQL](verify-results/project-collaboration-1795493271368/restore/pre-replay-db.json) · [恢复后 SQL](verify-results/project-collaboration-1795493271368/restore/post-replay-db.json) · [恢复后 API](verify-results/project-collaboration-1795493271368/restore/summary.json) · [MySQL DDL](verify-results/project-collaboration-1795493271368/mysql-migration.json)

生产 Web 在两个独立 Chrome 会话验证所有者新建共享文本、受邀者确认查看者权限、个人资料隔离，以及所有者撤销后旧浏览器会话刷新清除已展开的共享文本。Maven 全量验证和项目协作日志测试通过。 [浏览器用例](../clients/web/tests/collaboration-live.spec.ts)

使用同一构建关闭协作开关重启后，能力列表隐藏入口，直接调用返回不缓存的 403。 [关闭能力的 API 验收](verify-results/project-collaboration-1795493271368/disabled/summary.json)
