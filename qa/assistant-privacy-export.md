# 个人数据导出自测

在[消费者后端](assistant-account.md)中启用助手接口。登录后请求 `GET /api/assistant/v1/privacy/export`，携带消费者的 `Authorization` 和所选工作空间的 `X-Workspace-Id`。省略工作空间请求头时使用个人工作空间。接口以 UTF-8 JSON 附件返回，文件名为 `assistant-data.json`，响应禁止缓存。

| 导出字段 | 内容 |
| --- | --- |
| `schemaVersion`、`exportedAt`、`workspaceId` | 格式版本、快照时间和工作空间 |
| `account` | 账号标识、用户名、偏好及创建时间 |
| `projects` | 仍可读取的本人项目、说明及时间 |
| `conversations` | 仍可读取的本人会话，含已归档会话 |
| `messages` | 消息、父节点、内容与时间 |
| `runs` | 运行内容、状态、模型、上下文边界及时间 |
| `projectResources` | 本人项目资料的标识、所属项目、原始 UTF-8 文本和创建时间 |
| `analyses` | 有权访问的资料所派生的数值报告、图表数据、运行摘要及原始 `artifactCsv` |
| `memorySettings` | 已保存的个人或项目记忆设置。个人设置含历史引用开关和仍有效的自定义指令 |
| `memoryEntries` | 本人手动保存且仍保留的个人及项目记忆、内容和创建时间 |
| `attachments` | 本人项目中已批准的 PNG 文件类型、大小、尺寸及创建时间 |
| `customAssistants` | 本人自定义助手的当前版本标识、名称、状态与项目归属 |
| `customAssistantVersions` | 本人保留的各版本指令、已选工具、回滚来源与仍可访问的资料标识 |
| `reminders` | 本人提醒的起始本地时间、时区、重复规则、静默时段和当前状态 |
| `reminderOccurrences` | 本人提醒保留的执行记录、实际投递或过期时间与已读时间 |
| `privateArtifacts` | 本人私有文稿与当前版本、格式、项目及来源回复标识 |
| `privateArtifactVersions` | 本人留存的文本、工作表、演示稿、代码稿或网页草稿版本，以及历史标题、版本号和回滚来源 |
| `nextCursor` | 下一份分段的游标，最后一份为 `null` |

每个分段的所有数据集合合计最多 64 条，编码体积最多 8 MiB。客户端以原账号和工作空间传入 `?cursor=<nextCursor>` 继续。每份分段重新校验会话和成员资格，在可重复读事务中生成。新增集合附在原有分页顺序后，先前签发的游标仍可使用。跨分段可见性随新的授权状态与数据变化更新。出现超预算历史记录时返回 413，已成功下载的分段仍为完整 JSON。

导出仅选取可携带字段。密码与令牌摘要、设备令牌、运行租约、请求指纹、供应商原始响应、内部处置审计及支付处理元数据留在各自的数据存储中。已删除会话及其消息和运行、已删除资料及其分析报告均排除。正在生成分段时若独立日志撤回其中的对象，服务返回 503，客户端可以用同一游标重试。资料和分析入口的功能开关关闭后，独立日志可用且授权有效的既有记录仍可携带。

关闭记忆后，本人仍可在个人数据导出中取回保留的手动记忆。关闭引用与清除指令立即影响导出设置，已删除或替换的记忆不再出现。附件集合提供已批准的元数据，图片文件可通过原项目的短期下载授权单独取得。隔离、拒绝或撤销的附件，以及存储键、内部版本与授权令牌不进入导出。 [附件的授权下载](assistant-png-attachments.md)

自定义助手的保留版本按原始指令携带。版本中的项目资料引用只包含当前仍可读取的标识，正文由 `projectResources` 提供。提醒使用本人规则和实际保留的执行记录，暂停状态按独立日志确定。已撤回的助手及其版本、已取消的提醒及其记录、分享链接和令牌均排除。 [自定义助手](assistant-custom-assistants.md) · [应用内提醒](assistant-reminders.md)

私有文稿和版本沿用原工作空间、所有者、项目和来源会话权限。文本版本原样携带 UTF-8 文字，代码稿版本携带 `code` 的原始源码和语言标识。JSON 解码后保留 CRLF、缩进和尾部空格。工作表版本携带 `sheet` 结构及原有单元格类型，演示稿版本携带 `presentation` 及页面顺序，网页草稿版本携带 `website` 中的原始文字及区块。独立删除日志同时保护文稿及其来源会话。协作发布和他人授权阅读记录不进入本人文稿导出。 [私有文稿的版本与单独下载](assistant-private-artifacts.md) · [私有工作表](assistant-spreadsheet.md) · [私有演示稿](assistant-presentation.md) · [私有代码稿](assistant-code-draft.md) · [私有静态网页](assistant-webpage.md)

## 复跑

使用隔离 PostgreSQL、Redis、测试注册和本地合成模型启动后端。脚本只连接回环地址，使用现建的模拟账号。 [模型网关自测](assistant-model-gateway.md)

```powershell
node qa/assistant-privacy-export-smoke.mjs http://127.0.0.1:18090
```

需要核验资料与分析时，使用独立回环测试服务，开启注册、资料、分析及[独立删除日志](assistant-erasure.md)，再运行同一脚本的扩展用例。扩展用例生成 58 条有效资料，覆盖共享分页、中文和 emoji、CSV 原始数据、跨账号隔离、资料与衍生报告撤回。后台会话分支导出继续使用原有的 Markdown 附件和摘要校验，可独立复跑。 [后台任务验收](assistant-jobs.md)

```powershell
node qa/assistant-privacy-export-smoke.mjs http://127.0.0.1:18195 --project-data
```

同时启用手动记忆和 PNG 扫描时，使用 `--private-data` 验证停用后的保留记忆、个人和项目作用域、已清除的指令、被删除或替换的记忆及已批准的附件元数据。

```powershell
node qa/assistant-privacy-export-smoke.mjs http://127.0.0.1:18112 --private-data
```

开启 `assistant.custom-assistants.enabled=true` 与 `assistant.reminders.enabled=true` 后，`--m3-data` 复跑本人助手的三个版本、撤回资料引用、跨账号隔离及本地实际投递并已读的提醒记录。该模式会等待下一分钟的提醒，由本地任务执行，无需外部推送。

```powershell
node qa/assistant-privacy-export-smoke.mjs http://127.0.0.1:18124 --m3-data
```

开启 `assistant.artifacts.enabled=true` 后，`--artifact-data` 运行文稿可携带用例。两组各 28 版的合成文稿迫使历史版本跨越共享分页边界。用例检查回滚、精确字符、来源删除、直接删除及另一账号的权限隔离。

同时开启 `assistant.project-collaboration.enabled=true` 和 `assistant.project-artifact-publications.enabled=true` 时，`--artifact-publication` 创建一项真实的隔离项目发布，并确认发布标识在所有数据分段中均不存在，作者版本仍可导出。

```powershell
node qa/assistant-privacy-export-smoke.mjs http://127.0.0.1:18132 --artifact-publication
```

按 Java 17 目标编译助手模块，5 项 JUnit 测试通过，覆盖空数据、分页游标、跨账号游标、读事务内会话无效、历史记录超预算。打包后端在隔离 PostgreSQL 和 Redis 的 HTTP 复测通过。两份完整 JSON 包含 67 个未删除会话、两条消息和一次完成的运行，中文与 emoji 保留，跨页无重复。测试确认了下载响应头、跨账号游标和工作空间拒绝、注销后令牌失效，以及被删会话、消息和运行均未进入导出。测试结束后已清理模拟会话的在线访问并注销模拟账号会话。

2026 年 11 月 24 日，打包后端在隔离 PostgreSQL 和 Redis 通过扩展 HTTP 回归。三份 JSON 包含 67 个会话、两条消息、一次运行、58 条项目资料和一个分析报告。下载与源资料、报告和 CSV 逐字段一致，删除的资料及其报告均未出现。复测覆盖另一个账号自己的资料仍可导出、跨账号与工作空间拒绝、游标续接、每页条数和字节上限。扩展后的 7 项导出单元测试和 8 项独立日志测试通过，覆盖旧游标继续、新字段序列化和检测到撤回后拒绝发送整个分段。

同日启用手动记忆与真实 PNG 扫描的回归通过。原三页内还包含两项记忆设置、三条有效手动记忆、一项已批准的附件元数据。普通记忆列表在停用后为空，导出仍可取回本人保留的手动条目。已清除的自定义指令、删除或替换的旧条目、拒绝或撤销的附件均未出现。另一个账号可导出自己的记忆和附件记录。单元测试覆盖读取分段期间设置版本或撤回日志变化时停止响应。

同日开启自定义助手和应用内提醒后，隔离 PostgreSQL 完成 104 个变更集，重启确认零项需重跑。打包后端通过原两页导出及 `--m3-data` 三页回归。扩展结果含一个自定义助手的三个历史版本、两项提醒和一项实际投递并已读的记录。已撤回资料的引用从历史版本中移除，原指令和回滚来源保持可携带。另一账号仅能读取自身数据。两个合成账号注销后原令牌请求导出均返回 401。10 项导出单元测试通过，其中包含旧游标的兼容及导出时状态水位变化的拒绝测试。

同日启用私有文稿和项目发布的打包后端通过 12 项导出单元测试以及 PostgreSQL 的 112 项迁移，重复启动执行零项变更。`--artifact-publication` 真实 HTTP 回归在四份完整 JSON 中核对了四篇文稿和 60 个版本，历史版本跨页无遗漏。中文、emoji、CRLF 和尾部空格按字节一致，两个账号均可携带本人记录。实际创建的发布标识、直接删除的文稿、已删除来源回复对应的文稿均从导出排除。重启后的原两页导出用例通过。MySQL 8.4.11 命名管道测试库也预编译并执行了两条新增的分页查询。

个人数据下载与账号注销采用各自的权限检查。账号注销要求重新验证当前密码，启用了独立删除日志的环境可以在恢复后重放。生产备份保留周期与供应商副本另行验证。 [账号注销与恢复重放](assistant-erasure.md) · [OpenSpec 任务](../openspec/changes/build-cross-platform-ai-assistant/tasks.md)

