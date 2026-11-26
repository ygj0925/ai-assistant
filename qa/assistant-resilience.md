# 聊天负载及恢复演练

演练使用专用回环 API、独立 PostgreSQL 数据库和 Redis 逻辑库。启用消费者注册、`local-echo`、默认 SSE 事件保留量及约 60 毫秒的模拟片段间隔。将观测采样间隔设为 1 秒、排队告警深度设为 2 可在小规模本机演练中看到告警。使用项目已构建的共享 SDK 和后端。 [后端启动方式](assistant-account.md) · [模型配置](assistant-model-gateway.md) · [观测配置](assistant-observability.md)

## 负载对照

`load` 为一名合成账号创建若干对话，分波同时提交，期间并发读取会话搜索和消息历史，结束后校验 SSE 文本、唯一终态、历史回复与账本一致。每次执行只对第一条运行主动断开一次 SSE，保留游标后续读。每轮最多 8 个对话，最多执行 5 轮。

```powershell
node qa/assistant-resilience-smoke.mjs --scenario load --api-url http://127.0.0.1:18082 --concurrency 1 --waves 2
node qa/assistant-resilience-smoke.mjs --scenario load --api-url http://127.0.0.1:18082 --concurrency 4 --waves 2
```

脚本在 `qa/verify-results/resilience-*/summary.json` 写入样本数、错误率和成功样本的 p50、p95、最大耗时，并记录队列快照、SSE 游标及账本对账。首段延迟从客户端开始提交到收到第一条文本增量，包含排队、模拟生成与 SSE 传输。`startedMs` 是客户端收到运行开始事件的时间。服务端的聚合日志提供独立的队列视角。报告保留运行 ID 用于关联日志，合成对话留在测试库供核对。

### 2026 年 11 月 22 日本机观测

Windows、PostgreSQL 16、独立 Redis 逻辑库。后端使用单个生成槽和约 60 毫秒的合成模型片段间隔。

| 观测 | 单并发 × 2 波 | 四并发 × 2 波 |
| --- | ---: | ---: |
| 完成并通过检查的运行 | 2 | 8 |
| 预期外错误 | 0 | 0 |
| 提交 p95 | 35.2 ms | 68.3 ms |
| 会话搜索 p95 | 17.7 ms | 15.1 ms |
| 消息历史 p95 | 19.9 ms | 17.8 ms |
| 运行开始事件 p95 | 201.4 ms | 2,620.2 ms |
| 首段文本 p95 | 319.3 ms | 2,745.6 ms |
| 终态到达 p95 | 954.4 ms | 3,360.5 ms |
| 观测到的最大等待数 | 1 | 4 |
| 结算码点 / 末态预留 | 140 / 0 | 560 / 0 |

重启后再次执行四并发两波，8 条运行再次通过。服务日志中，`queue_backlog` 在 `13:54:28` 和 `13:54:31` 两次触发，并在 `13:54:29` 和 `13:54:33` 各自恢复。时间为该测试机本地时间，阈值为本次演练设置的 2 条等待运行。

样本较少，p95 接近最大值。按同一配置复跑时，可先把提交 p95 超过 150 毫秒、历史接口 p95 超过 50 毫秒、四并发首段 p95 超过 4 秒或终态 p95 超过 6 秒视为复查信号。排队放大会直接影响首段。实际生产并发、供应商耗时、错误率预算、恢复时间和恢复点目标仍需用 M0 的真实负载与故障数据确认。 [M0 阈值任务](../openspec/changes/build-cross-platform-ai-assistant/tasks.md)

## 服务重启和限流

在专用实例上执行 `restart`。运行到 `restart-ready` 后，服务操作者只重启对应测试实例，继续使用原数据库和 Redis 逻辑库。脚本等待 API 先从回环端口消失，再恢复监听，通过快照和 SSE 检查三条运行。当前租约为 120 秒，正在生成的运行在租约过期后进入 `failed / PROVIDER_UNAVAILABLE`。等待队列中的运行应继续完成，重启前已完成的回复应保持原样。最后以原幂等键重试并核对历史与额度。

```powershell
node qa/assistant-resilience-smoke.mjs --scenario restart --api-url http://127.0.0.1:18082
```

2026 年 11 月 22 日，预先监听 `restart-ready` 后完成进程中断。客户端观测到端口拒绝连接，再恢复 HTTP 200，间隔约 13.62 秒。HTTP 恢复后 31.2 毫秒观测到原排队运行已完成。原活动运行在信号后约 121.61 秒进入失败终态，SSE 从重启前游标 `2` 接续，保留 104 个已提交的输出码点。重启前的完成回复保持一致。三条运行可用原幂等键找回，历史无重复提示或回复，最终结算 133 码点且预留归零。上述时长为当前回环轮询观测。

供应商传输层用一个进程内的回环 HTTP 服务返回 429。启动探针只需当前后端打包依赖。它断言传输返回 `RATE_LIMITED`、只调用一次、没有文本增量。

```powershell
$throttleOutcome = Join-Path (Get-Location) 'qa/verify-results/provider-throttle'
New-Item -ItemType Directory -Path $throttleOutcome -Force | Out-Null
$assistantPackageLib = Join-Path (Get-Location) 'services/api/continew-server/target/app/lib/*'
javac --release 17 -cp $assistantPackageLib -d $throttleOutcome qa/AssistantProviderThrottleProbe.java
if ($LASTEXITCODE -eq 0) {
    java -cp ($throttleOutcome + [IO.Path]::PathSeparator + $assistantPackageLib) top.continew.admin.assistant.model.AssistantProviderThrottleProbe
}
```

2026 年 11 月 22 日，当前打包版的供应商传输探针通过。部署环境仍需复核真实供应商的 429 与持续限流行为、值班告警送达、按租户灰度关闭、备份恢复和兼容版本回滚。 [发布验收任务](../openspec/changes/build-cross-platform-ai-assistant/tasks.md)
