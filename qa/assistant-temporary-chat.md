# 临时对话保留策略与验收

临时对话面向本地开发和验收。它通过 `temporary_chat` 能力公布，默认关闭。测试实例需显式启用 `assistant.temporary-chat.enabled=true` 和现有的本地合成模型。网关将此入口固定路由至 `local-echo`。

每次发送处理当前提示，最多 512 个 Unicode 码点。服务拒绝不符合结构的请求，对请求体设置 8 KiB 上限，按来源限制请求速率和单实例并发。生成前后均核对账号与工作空间，响应禁止缓存。功能使用进程内存，普通历史、运行、用量账本、项目资料和记忆均不参与。Web 只在打开的临时窗口中保留最近一轮输入与回答，关闭、刷新或页面恢复时清除。

```powershell
node qa/assistant-temporary-chat-smoke.mjs http://127.0.0.1:18103 enabled
node qa/assistant-temporary-chat-smoke.mjs http://127.0.0.1:18104 disabled
```

2026 年 11 月 24 日，实际 PostgreSQL API 验证启用、禁用、游客拒绝、工作空间不匹配、重复 JSON 字段、额外字段、请求体上限及 Unicode 边界。正常返回需要 `no-store`，用户的普通会话、历史搜索、用量和导出均未出现临时内容。Chrome 对生产构建验证了界面长度上限、显示回复、关闭重开、返回焦点和刷新清除。普通聊天上下文的记忆引用、独立的主动解锁和生产模型的临时处理仍待完整验收。
