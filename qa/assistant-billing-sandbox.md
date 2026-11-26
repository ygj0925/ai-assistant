# 本地订阅与对账演练

订阅测试提供一个 `local-test` 商户，支持创建测试订单、跨设备恢复状态、读取有效权益，以及处理有签名和版本号的商户通知。测试商户只在 `dev` 或 `test` 配置中启用，且需要显式设置 `assistant.billing.sandbox-enabled=true` 和一次性签名密钥。权益用于验证状态同步，本地聊天继续按可见输出码点记账。

| 操作 | 路由 |
| --- | --- |
| 创建或恢复测试订单 | `POST /api/assistant/v1/billing/sandbox/checkout`，携带消费者会话和 `Idempotency-Key` |
| 查看已知订单 | `GET /api/assistant/v1/billing/sandbox/orders/{orderId}`，携带消费者会话 |
| 查询有效权益 | `GET /api/assistant/v1/billing/sandbox/entitlement`，携带消费者会话 |
| 核对商户通知 | `POST /api/assistant/v1/billing/sandbox/notifications`，携带商户 HMAC |

通知签名使用 HMAC-SHA256，输入为毫秒时间戳的 ASCII 表示、一个句点和原始请求字节。接受的签名时间与接收时间相差最多五分钟，请求最大 4 KiB。业务发生时间可更早。服务端以商户版本决定生效顺序，签名输入的摘要用于识别重发或冲突。相同订单的退款终态持续有效，新交易使用新订单。查询与恢复均校验账号及工作空间。

## 隔离运行

跟随[消费者后端准备](assistant-account.md)配置独立数据库及 Redis。启动后端和执行探针的进程都需使用同一个随机 32 字节十六进制密钥环境变量 `ASSISTANT_BILLING_SANDBOX_SECRET`。启动参数追加 `--assistant.billing.sandbox-enabled=true`，示例端口为 18081。

```powershell
node qa/assistant-billing-smoke.mjs http://127.0.0.1:18081
```

探针使用两个临时账号和一个额外设备，验证恢复、同时开户去重、错误签名、过期签名、过大通知、重复和乱序、晚到退款、自然到期与权限边界。实际商店付款、平台回调验签和渠道对账仍待对应沙箱联调。

2026 年 11 月 22 日，隔离 PostgreSQL 上的首次完整回环通过。并行创建和通知重试最终留下两个订单与六条唯一通知，其中四条生效、两条按版本或退款状态忽略。MySQL 8.4.11 迁移验证保留了旧订单并建立权益查询索引。
