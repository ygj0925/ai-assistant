# 主动退出工作空间

已登录用户可以在工作空间列表中退出自己加入的空间。退出前预览当前成员关系，确认后提交它的版本号。个人工作空间始终保留。退出后设备会话仍可访问个人空间及其他获准的空间，使用旧空间请求头则被拒绝。

退出在独立日志与同一次数据库事务中撤销当前成员关系、该成员的项目角色和由其发布的工作空间链接。服务结清当时仍活跃的聊天任务，并按已持久化的输出片段计算用量。服务取消相应的待处理本地导出和研究审批，暂停该空间里由离开者配置的站内提醒，并使旧下载授权失效。空间中保留的数据仍由现行规则管理。再次获准加入需要新的成员关系标识，旧确认不会删除新的成员关系，旧项目授权与旧发布链接也不会重新开放。

独立回环验收开启 `assistant.workspace-departure.enabled`、项目协作、对话分享、本地导出、模拟模型、消费者注册及绑定的独立删除日志。用模型延迟和本地导出检查点延迟稳定复现退出前正在执行和排队的任务。退出调用由测试账号通过实际 API 执行。

| 模式 | 命令 | 验证 |
| --- | --- | --- |
| 恢复 | `node qa/assistant-workspace-departure-smoke.mjs http://127.0.0.1:18133 restore <新证据目录> http://127.0.0.1:18134` | 同会话退出、保护个人空间、旧会话请求、运行与本地导出结清、双向项目角色、旧分享、备份重放及新成员关系。 |
| 关闭 | `node qa/assistant-workspace-departure-smoke.mjs http://127.0.0.1:18134 disabled <新证据目录>` | 功能关闭时预览和能力拒绝入口。 |

先用 `membership-ready.json` 中的合成账号和工作空间 ID 创建测试成员关系，再写入 `membership-added.json`。通过 `snapshot-ready.json` 和 `snapshot-done.json` 记录及确认源 PostgreSQL 的备份。完成退出后脚本写入 `revoke-ready.json`，测试驱动把备份还原至空目标库，检查旧成员关系和任务后用同一独立日志启动目标 API。核对重放后写入 `database-switched.json`。

脚本用原会话确认退出与撤权，再写入 `rejoin-ready.json`。测试驱动在隔离目标库以一个新的 UUID 建立指定的测试成员关系，写入 `membership-renewed.json`。脚本验证旧退出请求保持失效、旧授权不再出现，只有明确发出新授权后可重新访问。

2026-11-24，PostgreSQL 独立环境共执行或校验 122 个 Liquibase 变更集，其中退出工作空间新增 2 个。以自动化标记触发原生备份时，旧成员关系、运行中的回复、排队中的回复、两条项目授权、已有发布链接和本地导出均处于可验收的旧状态。还原后重放原独立日志，两个旧回复准确结清，旧导出和递送记录已撤销，旧角色和链接失效。原会话的个人回复继续完成。以新 UUID 录入的合成成员关系只接受重新确认的授权，旧退出版本和旧项目分享均保持失效。 [恢复前 SQL](verify-results/workspace-departure-1795499069609/restore-active/pre-replay-db.json) · [恢复后 SQL](verify-results/workspace-departure-1795499069609/restore-active/post-replay-db.json) · [HTTP 验收](verify-results/workspace-departure-1795499069609/restore-active/summary.json)

生产 Chrome 验证了取消退出、明确确认、实际返回 204、自动回到个人空间和移除旧空间入口。MySQL 8.4 原生验证了旧版本默认值、个人空间保护、旧版本删除、以新版本重新加入后的范围保护和版本字段约束。 [浏览器用例](../clients/web/tests/workspaces-live.spec.ts) · [浏览器记录](verify-results/web-workspace-departure-2026-11-24/browser.log) · [MySQL DDL](verify-results/workspace-departure-1795499069609/mysql-migration.json)

单独关闭退出工作空间开关时，预览返回不缓存的 403，能力也处于关闭状态。Maven 全量验证和五项协作、退出日志回归通过。 [关闭能力](verify-results/workspace-departure-1795499069609/disabled/summary.json)

附加验收 `automation` 模式在同一构建的独立数据库启用本地审核研究、日历提醒和提醒模板。实际 API 退出工作空间时，在运行的审核计划停止且清除批准和到期调度，空间提醒暂停、清除唤醒任务，原模板无法读取。录入新成员关系后，原研究修订无法重新批准，只有明确修订并批准后才生成报告。明确恢复提醒后原模板仍不可用，新模板可以发布。个人空间提醒全程保持活动。 [附加 HTTP](verify-results/workspace-departure-1795499069609/automation/summary.json) · [SQL 检查](verify-results/workspace-departure-1795499069609/automation/native-closure.json)
