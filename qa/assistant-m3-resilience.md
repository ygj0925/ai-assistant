# M3 故障演练

演练在独立回环应用、PostgreSQL、Redis 和绑定撤权日志上运行。连接器使用单独的合成回执文件。测试账号、研究来源、评论和触发事件均使用合成数据。应用、数据库和回执文件各自保留可核对的结果。

| 场景 | 已观察到的结果 | 证据 |
| --- | --- | --- |
| 长任务进程重启 | 恢复旧库时保留同一研究任务和已完成的核验检查点，旧修订审批和已经取消的报告继续不可用。 | [研究检查点和恢复](assistant-local-research.md) |
| 重复触发与补偿 | 五路并发送达同一经过核实的事件，每个订阅只产生一条记录。暂停、取消授权及删除后，旧快照中的三条等候记录均未投递。固定时钟覆盖夏令时与 24 小时补偿边界。 | [事件恢复前态](verify-results/sandbox-event-reminders-1795506524602/restore/before-replay.json) · [恢复后态](verify-results/sandbox-event-reminders-1795506524602/restore/after-replay.json) |
| 外部回执未知 | 模拟结果返回前失联时，原操作可继续查询。旧数据库恢复与多次核实后，独立回执文件中每个已派发操作仍只有一条记录。撤销前尚未派发的操作保持零条。 | [恢复 HTTP](verify-results/sandbox-connector-1795504971068/restore/summary.json) · [独立账本](verify-results/sandbox-connector-1795504971068/restore/ledger-after-reconcile.json) |
| 共编冲突 | 两个编辑者提交同一基线分别得到 201 和 409。Web 保留失败方草稿，可显式使用新基线，恢复历史版本时创建新版本。 | [共享 Markdown 演练](assistant-project-shared-drafts.md) |
| 权限撤销 | 旧库恢复后，已发布版本、评论、共享文稿和项目角色继续按当前权限收敛。授权撤销期间，Android 等待保存的文件未落盘。 | [版本协作](assistant-typed-artifact-collaboration.md) · [Android](../clients/mobile/.expo/published-documents-2026-11-24/android-results.json) |
| 资源预算 | 9 个同账号并发申请接受 8 个，另 1 个返回 429。取消后释放额度。一项任务允许 16 个版本，第 17 个请求返回 409，模型用量保持一致。 | [真实 API](verify-results/research-handoff-2026-11-24/budget.log) |
| 灰度关闭 | 连接器停用后拒绝新授权与创建，事件提醒停用后拒绝新增与接收。表格、幻灯片、代码发布可分别停用，其他格式和原私有版本维持各自权限。 | [连接器关停](verify-results/sandbox-connector-1795504971068/disabled.json) · [事件关停](verify-results/sandbox-event-reminders-1795506524602/disabled.json) · [格式开关](assistant-typed-artifact-collaboration.md) |

本轮完成本地故障注入。正式供应商 OAuth、外部回执查证与生产目标阈值的验收分别由供应商、连接器和全量发布任务记录。 [本地连接器](assistant-sandbox-connector.md) · [发布预检](m0-live-readiness.md)
