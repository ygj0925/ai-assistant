# 本地合成模型的记忆上下文

在隔离的回环环境启动打包后端，启用 `assistant.models.mock-enabled`、`assistant.memory.enabled`、`assistant.memory.context-enabled` 和独立删除日志，设置 `assistant.models.mock-delay-millis=15`。运行 `node qa/assistant-personalized-run-smoke.mjs http://127.0.0.1:18105 enabled`。关闭 `assistant.memory.context-enabled` 后重启，运行相同脚本的 `disabled` 模式，验证默认模型对有记忆的账号仍使用原有回复路径。

当前范围按领取运行时的账号、工作空间和会话归属确定。未归入项目的会话可使用自定义指令与个人记忆，项目会话可使用本项目已启用的记忆。系统保留原有对话分支，剩余容量内最多选择 3 份完整材料、合计 2,000 个 Unicode 码点。历史引用设置独立保存。临时对话和远程模型保留既有路径。

合成模型的固定类别计数帮助核对实际输入。在合成环境可用「格式：项目符号」验证指令产生效果。服务端发现撤权、项目移动或成员关系变化时会取消尚未发布的个性化回复。发布前需再次验证所用权限、版本与条目状态，集中写入回复和实际上下文长度。现有上下文 `turns` 表示对话分支消息数量，`used` 包括实际使用的额外材料长度。运行和事件存储中没有原始个性化材料、条目列表或内容摘要。

自动化覆盖指令开关、持久撤权、项目隔离、排队中的移动、发布前关闭、原有分支和预算。明确选择的历史回复和项目记忆来源已另行验证。正式供应商使用私有上下文须通过供应商及地区资格核验。 [历史回复](assistant-explicit-history.md) · [项目记忆来源](assistant-project-memory-sources.md)

要实测工作空间撤权，可在启用的隔离 API 上执行 `node qa/assistant-personalized-run-smoke.mjs http://127.0.0.1:18105 membership <空证据目录>`。验证驱动等待 `remove-member.json` 中的合成账号、工作空间和运行 ID，删除该成员关系并创建 `member-removed.json`。脚本确认读取被拒绝后写出 `member-denied.json`。驱动检查运行已经取消且正文为空，然后恢复测试成员关系并创建 `member-rejoined.json`。脚本最后检查用量释放、无回复历史并写出 `summary.json`。

2026-11-24，在两个使用 PostgreSQL 和 Redis 的独立回环环境通过启用、关闭和成员撤权验收。撤权测试在成员关系恢复前观察到运行从 `running` 变为 `cancelled`，两个阶段的回复均为空。6 项上下文选择测试和 3 项 Worker 测试通过。
