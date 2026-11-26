# 文本模型网关自测

本地运行采用 `local-echo`。显式启用后，模型以固定前缀和最近一条用户消息生成回复，每段最多八个 Unicode 码点。测试可延迟片段投递，用于复现断流、接续和取消。启用合成模型需要 `dev` 或 `test` 配置集，包含 `prod` 时启动会拒绝该设置。

在[账号后端启动命令](assistant-account.md)上追加 `--assistant.models.mock-enabled=true`。测试断流需要延迟时，可再传入 `--assistant.models.mock-delay-millis=100`。

有消费者会话的客户端调用 `GET /api/assistant/v1/models`，携带 `Authorization` 和所选工作空间 `X-Workspace-Id`。本地模型 ID 为 `local-echo`，版本为 `synthetic-v1`，当前支持 `standard` 档位。模型均关闭时返回空列表。启动运行可传入其中的模型 ID，也可省略以使用部署默认路由。运行记录保存配置时的模型版本。

```powershell
node qa/assistant-run-smoke.mjs
Push-Location packages/contracts
npm.cmd test
Pop-Location
```

在 2026 年 11 月 22 日运行共享合约和 SDK 测试，共 9 项通过，覆盖模型目录响应、令牌和工作空间请求头。使用现有构建依赖按 Java 17 目标编译助手模块，并通过 8 项 JUnit 测试。模型网关测试使用合成配置与 SSE 样例，检查配置约束、Unicode 边界、数据解码、中途断流、供应商错误脱敏和响应大小上限。

## 北京文本供应商接入

| 路由 ID | 启用项 | 服务端密钥变量 |
| --- | --- | --- |
| `dashscope` | `assistant.models.dashscope.enabled=true` | `DASHSCOPE_API_KEY` |
| `ark` | `assistant.models.ark.enabled=true` | `ARK_API_KEY` |

两条路由均需要 `assistant.models.region=cn-beijing`。为各自配置 `assistant.models.<路由 ID>.id` 和 `assistant.models.<路由 ID>.version`，使用已获准的文本模型或推理接入点 ID 及对应版本。首选具备供应商固定版本标识的接入点。百炼可填写 `assistant.models.dashscope.workspace-id` 使用北京工作空间域名。部署可用 `assistant.models.default` 指定一条已启用路由。请求使用固定官方 HTTPS 域名，限制连接与生成时长、输入文本大小、输出 token 和流响应字节数。供应商返回 429 时，运行错误使用 `RATE_LIMITED`。 [百炼兼容接口](https://help.aliyun.com/en/model-studio/compatibility-of-openai-with-dashscope) · [百炼流式响应](https://help.aliyun.com/en/model-studio/stream) · [方舟数据面和鉴权](https://docs.volcengine.com/docs/ark/base-url-and-authentication?lang=zh)

真实供应商的模型版本、数据处理地区和采购权限仍需使用获准账号核对。首字延迟与质量实测、多推理档位及按任务自动路由留在任务 2.8。 [外部联调准备](m0-live-readiness.md)

## 版本与上下文兼容

每次运行记录所使用的模型 ID 和版本。生成内容写入消息历史后，消息的 `generation` 对象保留相同版本信息。较旧的消息仍可读取，未记录的元数据可省略。旧模型只能通过配置的 `assistant.models.retired.<旧ID>=<当前ID>` 显式切换到可用模型，新运行返回 `fallbackFromModelId`。已排队运行按原模型版本校验。

当前每次生成最多使用同一分支最近 32 条消息和 32,768 个 Unicode 码点，优先保留最近的连续上下文。较早的消息可能此次未纳入，运行和消息历史会透出 `context.trimmed`、已用长度和限额，历史正文仍可读取。这是产品输入预算，供应商的计量与最大 token 数由各自路由定义。

在本地启动命令追加 `--assistant.models.retired.retired-echo=local-echo`，然后在项目根目录运行 `node qa/assistant-model-context-smoke.mjs`。用例验证未知模型拒绝写入、长中文和 emoji 消息、上下文裁剪、回退及历史中的实际版本记录。

2026 年 11 月 22 日，在长期测试库升级数据结构后，打包后端通过该用例。显式退役路由返回了原请求 ID 和当前模型版本，32,768 码点的预算实际保留了四条消息及 25,000 个码点。后端 11 项模型测试通过。
