# 本地连接器事件提醒验收

事件提醒绑定当前授权的模拟连接器。用户选择固定的合成回执事件、IANA 时区与可选的静默时间。服务从已明确审批、已完成的合成动作校验同一个独立回执，并为每条订阅记录一次站内提醒。合成事件由回执标识定位。

收到同一个回执标识时，已有事件记录直接计入重复。静默窗口内接受的事件等候到本地窗口结束。暂停会撤销已排队的站内提醒，暂停期间收到的事件记录为跳过。继续后仍依据原始事件标识去重。连接器撤权会撤销待送达事件并隐藏来源操作 ID。阅读状态适用于已送达的站内提醒。

测试环境分别显式启用 `assistant.sandbox-connector.enabled` 与 `assistant.sandbox-event-reminders.enabled`，并绑定独立的隐私日志及模拟回执文件。关闭测试只关闭事件提醒开关。真实连接器的事件签名、第三方通知与授权依照相关供应商另行验收。

```powershell
node qa/assistant-sandbox-event-reminders-smoke.mjs http://127.0.0.1:18141 enabled
node qa/assistant-sandbox-event-reminders-smoke.mjs http://127.0.0.1:18141 restore <新证据目录> http://127.0.0.1:18142
node qa/assistant-sandbox-event-reminders-smoke.mjs http://127.0.0.1:18142 disabled
```

恢复测试在三个合成提醒等候时备份数据，随后单独暂停一条、删除一条和撤回第三条的连接授权。停止旧实例并等其释放回执文件后，用旧数据、相同隐私日志及相同回执文件启动目标实例。日历单元测试使用固定时间，覆盖了春季时间跳跃、秋季两个重复偏移和 24 小时迟到边界。

## 实测结果

- PostgreSQL 16 精确包应用 140 条 Liquibase 变更，其中 3 条为事件提醒。真实 HTTP 验证五路并发重复投递、授权和回执约束、送达与已读、静默和暂停、撤权后隐藏来源、删除与关闭开关。日历测试 7 项通过。[开启结果](verify-results/sandbox-event-reminders-1795506524602/enabled.json) · [关闭结果](verify-results/sandbox-event-reminders-1795506524602/disabled.json)
- 真实旧 PostgreSQL 备份包含三条等候提醒。重放后保留两条撤销记录并移除被删除的订阅，历史提醒未重新送达。继续并收到同一个旧事件时，记录仍为撤销。独立回执文件在重放前后的 SHA-256 一致。[备份状态](verify-results/sandbox-event-reminders-1795506524602/restore/before-replay.json) · [重放状态](verify-results/sandbox-event-reminders-1795506524602/restore/after-replay.json) · [恢复 HTTP](verify-results/sandbox-event-reminders-1795506524602/restore/summary.json) · [回执文件一致性](verify-results/sandbox-event-reminders-1795506524602/restore/ledger-after-replay.json)
- MySQL 8.4 隔离模式验证跨作用域外键、跨配置代数的重复约束、未送达状态约束、撤销和级联清理。[MySQL 结果](verify-results/sandbox-event-reminders-1795506524602/mysql-migration.json)
- 生产 Web 构建的 Chrome 测试覆盖单次接收与重复、已读持久化、暂停期间跳过且继续后保持，以及连接撤权后的来源隐藏。Playwright 1 项通过。[浏览器结果](verify-results/sandbox-event-reminders-chrome-2026-11-24/browser.log)
