# 助手运行观测自测

启用 `assistant.enabled` 后，后台执行器每次处理会产生一行 `event=assistant_model_attempt`，包含 `run_id`、公开模型 ID、执行结果、`duration_ms` 和 `first_delta_ms`。从客户端运行快照或 SSE 取 `runId` 即可定位后端的队列、启动、执行和终态日志。缺少文本增量时 `first_delta_ms=-1`。并发取消或租约过期导致执行器失去写权限时，执行器记录 `LEASE_LOST`，持久化运行的终态仍以快照为准。

采样器默认每 30 秒从数据库读取聚合计数，输出 `event=assistant_ops_sample`。每条聚合查询执行上限为五秒，采样线程独立于运行调度线程。样本包括队列深度、最长排队时长、运行数、逾期租约数、活跃预留单位、最近结算单位、账本不匹配数、完成数及模型失败数。近期窗口按运行创建时间取最近十分钟。模型失败数使用已持久化的 `PROVIDER_UNAVAILABLE` 与 `RATE_LIMITED`，结算单位使用产品内部用量口径。

告警日志格式为 `event=assistant_ops_alert rule=<规则> state=firing`。第一次违反规则时记录 WARN，恢复时记录 INFO 和 `state=recovered`。同一服务实例在持续违反同一规则期间只记录一次。

| 规则 | 触发条件 |
| --- | --- |
| `queue_backlog` | 等待数达到 25，或最早排队达到 30 秒 |
| `overdue_lease` | 存在无有效租约时间的运行 |
| `ledger_mismatch` | 活跃运行的预留缺失或已结算，或近期终态运行的结算缺失或超过预留 |
| `provider_failure_ratio` | 近期模型失败至少 5 次，且占近期完成和模型失败总数的 25% 或以上 |
| `queue_poll` | 执行器读取队列失败 |
| `sample_unavailable` | 聚合采样失败 |

观测日志只写服务器生成的运行 ID、固定模型名称、固定原因或结果和数值。会话内容、供应商响应、用户标识、令牌及支付信息留在各自受限的数据路径。

## 复跑与证据

在[模型网关启动配置](assistant-model-gateway.md)上追加 `--assistant.observability.interval-millis=1000` 可加快本机观测。排队告警的默认阈值可用 `assistant.observability.queue-depth` 和 `assistant.observability.queue-delay-millis` 覆盖。

```powershell
node qa/assistant-run-smoke.mjs
Push-Location services/api
.\mvnw.cmd -B -pl :continew-assistant -am test
Pop-Location
```

2026 年 11 月 22 日，按 Java 17 目标编译助手模块并通过 4 项 JUnit 测试，覆盖连续告警去重、恢复、重新触发、故障样本与运行日志内容边界。在隔离 PostgreSQL 16 的只读事务执行源码中的两条聚合查询，查询正常返回，近期终态窗口含 2 条完成运行和 124 单位结算，账本不匹配为 0。

后续部署联调应配置受限日志采集，并在预发环境验证值班告警送达。上线阈值还需按 M0 压测、供应商延迟与业务用量预算确定。 [OpenSpec 验证任务](../openspec/changes/build-cross-platform-ai-assistant/tasks.md)

打包后端的聊天运行自测随后确认了消费者 `runId`、`assistant_model_attempt`、终态及聚合日志可以关联。整组运行结束时采样报告零待处理运行、零活跃预留、零账本不一致。 [聊天运行与账本自测](assistant-run.md)
