# AI 助手接口契约

[OpenAPI 3.1 契约](openapi.yaml)定义 M1 消费者接口。路径前缀为 `/api/assistant/v1`。账号、权限和工作空间归属由服务端判断，`X-Workspace-Id` 只表示请求目标。成功响应直接返回约定的 JSON，`204` 无响应体。错误响应使用 `{code,message}`，客户端以 `code` 区分处理方式。

| HTTP | 应用码 | 客户端处理 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | 更正输入 |
| 401 | `UNAUTHENTICATED` | 清除对应会话，提示登录 |
| 401 | `INVALID_CURRENT_PASSWORD` | 保留会话，重新输入当前密码 |
| 403 | `FORBIDDEN`、`CAPABILITY_UNAVAILABLE` | 显示权限或功能限制 |
| 404 | `NOT_FOUND` | 刷新相关资源 |
| 409 | `CONFLICT` | 提示冲突，重新读取当前状态 |
| 410 | `CURSOR_EXPIRED` | 读取运行快照 |
| 413 | `CAPABILITY_UNAVAILABLE` | 显示单条历史记录超出导出大小限制 |
| 429 | `RATE_LIMITED` | 按服务端频率限制重试 |
| 503 | `PROVIDER_UNAVAILABLE` | 显示暂不可用 |
| 500 | `INTERNAL_ERROR` | 提示失败，可附请求编号 |

会话和消息分页使用不透明 `cursor`，响应为 `{items,nextCursor}`，最后一页返回 `null`。客户端保存游标时需关联原查询。首次查询省略它。运行用 `Idempotency-Key` 防止请求重试重复创建，服务端按账号和操作约束。

## 使用 SDK

在本目录运行 `npm ci` 和 `npm test`。编译从 OpenAPI 生成 TypeScript 类型和 SDK。浏览器和桌面可直接使用默认 Fetch 与流读取器。移动端提供自身的 Fetch 适配，响应不支持 Web ReadableStream 时可传入 `readStream`，用原生流转接 UTF-8 文本。无法流式读取时，可查询运行快照。ArkTS 客户端可从 OpenAPI 生成模型，并使用平台 HTTP 与流接口接入。

```ts
const client = new AssistantClient({
  origin: 'http://127.0.0.1:18090',
  clearAccountData: () => clearAccountCacheAndLocalDrafts(),
});
await client.replaceSession(await client.login(credentials));
```

账号切换取消旧账号的请求。SDK 等待应用清理旧缓存、草稿和安全持久化副本，然后启用新凭据。清理回调可以是异步函数。注销接口成功后 SDK 会清空当前会话并等待清理。

`getUsage()` 返回当前账号的额度、已预留用量、已结算用量和可用额度，以 Unicode 输出码点计量。计数达到或超出 JavaScript 的安全整数上限时，以十进制字符串返回。

`getExportPage()` 解析当前账号和工作空间的首份 JSON 导出附件。传入 `getExportPage(nextCursor)` 可获取下一份，游标为 `null` 时已到最后一份。每次调用只获取一份完整文档，每份导出均重新验证会话和工作空间权限。 [导出字段与自测](../../qa/assistant-privacy-export.md)

`account-erasure` 可用时，消费者可以用当前密码和明确的 `DELETE` 确认调用 `eraseAccount()`。成功后所有设备会话失效，SDK 清除当前会话。输入错误保留会话，允许用户重试。

## 流式恢复

SSE 的 `id` 对应运行内连续递增的事件序号。客户端收到并应用事件后保存序号。连接在收到终态前关闭时，用 `Last-Event-ID` 从该序号续流。SDK 忽略重放的相同或旧序号，遇到缺口抛出 `StreamProtocolError`。遇到缺口或 `CURSOR_EXPIRED` 时读取 `getRunSnapshot`，用快照替换本地状态。若运行仍活跃，从 `lastSequence` 继续订阅。关闭订阅与显式 `cancelRun` 是独立操作。

请求和 SSE 帧示例见 [v1 请求](examples/v1.http)和[事件样例](examples/run-events.sse)。本契约定义接口与客户端行为，服务端各接口的实际进度以 OpenSpec 为准。
