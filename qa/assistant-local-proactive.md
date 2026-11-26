# 本地主动助手验收

用户显式开启当前工作空间的主动建议，选择提醒检查或近期计划角色，设置站内通知、静默模式、IANA 时区与可选静默窗口。调度只核对当前仍有效的本人日历提醒。近期计划使用具体的下一日历槽位，提醒检查使用具体的未读送达记录。建议仅公开类别、时间和所属日历范围，提醒正文由原有日历权限控制。

同一成员代数、角色和当地日期最多发出一次。静默或进入静默窗口时不生成建议，恢复条件后重新核对当前许可。关闭会撤销旧代数，主动忽略会撤销指定建议。恢复旧备份时，独立日志保留关闭、忽略和已经发出标记。应用使用回环开发或测试配置，显式启用 `assistant.proactive.local.enabled` 及日历提醒，并绑定独立隐私日志。

```powershell
node qa/assistant-local-proactive-smoke.mjs http://127.0.0.1:18141 enabled
node qa/assistant-local-proactive-smoke.mjs http://127.0.0.1:18141 workspace <新证据目录>
node qa/assistant-local-proactive-smoke.mjs http://127.0.0.1:18141 restore <新证据目录> http://127.0.0.1:18142
node qa/assistant-local-proactive-smoke.mjs http://127.0.0.1:18142 disabled
```

工作空间用例由隔离测试驱动为合成账号添加成员关系，退出、读取及重新同意均走当前应用接口。恢复用例使用两个已发出建议和一个尚未发出的合成账户建立 PostgreSQL 快照，随后分别关闭、忽略或发出后关闭。以同一个日志启动复原库，验证待显示内容、重新开启与同日去重。

## 实测结果

- 修正后的精确应用包使用 PostgreSQL 16 和 Redis，包含 150 条 Liquibase 变更。真实 HTTP 验证默认为关闭、两种角色、静默通知与静默窗口、同日忽略及新的当地日期、来源暂停和已读失效、普通日历实际送达，以及关闭开关后仍能使用普通日历。[启用结果](verify-results/local-proactive-1795509247502/enabled.json) · [关闭结果](verify-results/local-proactive-1795509247502/disabled.json)
- 最早的提醒检查执行暴露了 PostgreSQL 对无槽位记录的映射问题。修正后用相同驱动核对有值和空值，再用实际送达的未读记录重跑两种角色。[驱动校验](verify-results/local-proactive-1795509247502/nullable-slot-jdbc.json)
- 独立旧备份恢复后，旧关闭和忽略保持有效。对于早于生成的备份，重新开启也无法再次发出当日已登记的同一建议。真实工作空间退出和不同成员代数的重新加入仍需各自明确启用。[快照状态](verify-results/local-proactive-1795509247502/restore/before-replay.json) · [重放状态](verify-results/local-proactive-1795509247502/restore/after-replay.json) · [恢复 HTTP](verify-results/local-proactive-1795509247502/restore/summary.json) · [工作空间验证](verify-results/local-proactive-1795509247502/workspace/summary.json)
- MySQL 8.4 隔离模式应用三条变更，验证静默调度约束、跨代数同日去重、角色来源约束、跨作用域外键和级联擦除。[MySQL 结果](verify-results/local-proactive-1795509247502/mysql-migration.json)
- Chrome 生产构建在修正后的后端上验证了默认关闭、明确开启及选择站内提示、进入现有提醒计划、忽略、静默和关闭，未在建议中暴露提醒标题与内部来源标识。[浏览器结果](verify-results/proactive-chrome-2026-11-24/browser-reviewer-package.log)
- Pixel Tablet API 36 验证两种角色、后台清除未保存设置、真实断网、冷启动后保持忽略、静默屏蔽实际未读提醒与关闭后保留原有日历。设备只发送五次明确确认的设置更新及一次忽略，日历写入为零。Android 与 iOS Hermes 导出通过，运行时用例覆盖 Android。 [移动端主动助手](../clients/mobile/README.md#主动助手) · [Android 结果](../clients/mobile/.expo/proactive-2026-11-24/android-results.json)

## 逐账户调度故障复测

调度隔离的三项定向单元测试覆盖坏候选与正常候选同批、过时代数拒绝退避及日志等待重放时停止继续处理。精确验证包 `policy-hosting-screen` 在回环 `18147` 和独立 PostgreSQL 数据库完成故障复测。数据库证实前序账号一次实际更新失败并退避，故障账号零建议，同批正常账号恰好一次建议。正常账号通过 HTTP 读到该建议。[HTTP 结果](verify-results/local-proactive-scheduler-isolation-1795511726264/summary.json) · [PostgreSQL 结果](verify-results/local-proactive-scheduler-isolation-1795511726264/postgres-witness.json)

复测使用全新的 `assistant_proactive_fault_qa_<十六进制>` 数据库和两个合成账号。运行 `node qa/assistant-proactive-scheduler-isolation-smoke.mjs <回环地址> <新证据目录>`，从 `fixture-ready.json` 读取账号及空间 ID，以 `bad_account`、`bad_workspace`、`healthy_account` 和 `healthy_workspace` 参数应用[限定故障注入夹具](fixtures/proactive-scheduler-fault.pg.sql)，再写入 `fault-armed.json`。用[只读数据库检查](fixtures/proactive-scheduler-fault-proof.pg.sql)复核结果。
