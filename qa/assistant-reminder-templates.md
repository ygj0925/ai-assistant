# 定时提醒模板分享与套用

在独立回环环境启用 `assistant.reminders.enabled`、`assistant.reminder-templates.enabled` 和已绑定的删除日志。模板由提醒所有者先预览，再确认发布。邀请只对已登录、持有令牌且仍属于所选工作空间的用户开放。浏览器可以将令牌留在链接片段中，API 仅通过请求正文接收令牌。

预览和副本包含标题、首次实际将要使用的本地时间、IANA 时区、单次或每日或每周频率与静默时间。接口返回确切计划和送达时刻，浏览器在所选时区显示预计送达。邀请到期时间取首次计划时刻与发布后七天中较早者。若邀请或来源在确认前失效，接收人需重新预览。

接收人的确认版本绑定当前账号和目标工作空间。套用使用接收人的提醒额度，并创建独立提醒。同一邀请在同一接收人工作空间重复提交时返回同一副本。源邀请撤回、源提醒暂停或删除之后，旧链接失效，已创建的独立副本按接收人的计划保留。提醒只在应用内产生通知。

| 模式 | 命令 | 验证内容 |
| --- | --- | --- |
| 常规 | `node qa/assistant-reminder-templates-smoke.mjs http://127.0.0.1:18122 enabled` | 所有者与接收方、工作空间权限、明确确认、时区/静默时间、每日和每周的首次时段、并发幂等、撤回与独立副本。 |
| 配额 | `node qa/assistant-reminder-templates-smoke.mjs http://127.0.0.1:18122 quota` | 接收方已达 32 条提醒时，套用失败，提醒数量保持一致。 |
| 关闭 | `node qa/assistant-reminder-templates-smoke.mjs http://127.0.0.1:18123 disabled` | 调用运行在关闭模板分享的独立 API，验证能力和接口拒绝。 |
| 恢复 | `node qa/assistant-reminder-templates-smoke.mjs http://127.0.0.1:18122 restore <空证据目录> http://127.0.0.1:18123` | 旧备份恢复后，已撤回和来源已删除的邀请均不能预览或套用，独立副本和未受影响的邀请继续可用。 |

恢复用例通过目录中的标记协调两个数据库环境。`backup-ready.json` 出现后备份源库并创建 `backup-done.json`。等到 `restore-ready.json`，停止源 API，将备份还原到独立目标库，用相同独立日志与身份启动目标 API。目标 API 就绪后创建 `database-switched.json`，测试会写出 `summary.json`。标记只包含测试对象 ID 和结果。

验收范围为本地日历提醒。带连接器、外部动作、外部通知的任务以及 M3 联合故障回归仍需另外验证。

2026-11-24，PostgreSQL 隔离环境执行了 104 个 Liquibase 变更集，本功能新增的 3 个通过。独立日志恢复用例在重放前确认旧链接仍在备份里，重放后通过 SQL 和 HTTP 核对撤回、来源删除、未受影响的链接及接收方副本。MySQL 8.4 隔离环境执行了相同的增量 DDL，并验证事件种类、撤回字段和来源删除级联。两项针对性的 Java 测试通过。

生产 Web 以两个独立 Chrome 会话验证分享前预览、接收人显式确认、静默与时区保留、撤销和独立副本。接收人登录前未展示提醒内容，页面读取令牌后从地址栏移除链接片段。实际分钟投递与已读的回归也通过。API 验证达到提醒配额时不产生部分副本，以及关闭能力后拒绝入口。 [Chrome 验收](../clients/web/tests/reminder-share-live.spec.ts) · [备份恢复结果](verify-results/reminder-template-1795490686003/restore/summary.json)
