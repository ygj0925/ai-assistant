# 已发布文稿的项目内评论

所有者和当前编辑者可以在明确发布的某个文稿版本下写评论。查看者可读。编辑者只能删除自己写的评论，所有者可删除该项目发布下的任一评论。退出或撤销项目角色后，旧会话无法再读写。已经提交的评论随该发布保留，删除评论、撤回发布、删除源产物或注销评论作者时，相关评论将被清除。

评论保留原始 UTF-8 文本，最多 4 KiB，每个发布最多 64 条。创建请求带 UUID 重试键。原键和原文重试会返回同一条评论，改写正文会收到 409。删除评论后，原键也不能再次用于创建该评论。评论响应包含当前用户自己的署名状态和删除按钮权限。

开启 `assistant.project-artifact-comments.enabled` 需要先配置项目协作、私有产物、已选版本发布、消费者注册及独立删除日志。测试使用独立回环 API 和合成文本。评论与特定发布绑定，评论接口不提供私有产物的其他版本与来源对话。

| 模式 | 命令 | 验证 |
| --- | --- | --- |
| 恢复 | `node qa/assistant-project-artifact-comments-smoke.mjs <源回环 API> restore <新证据目录> <目标回环 API>` | 作者和角色、并发幂等、正文边界及额度、发布撤回、删除和备份还原。 |
| 关闭 | `node qa/assistant-project-artifact-comments-smoke.mjs <目标回环 API> disabled <新证据目录>` | 关闭评论入口后，版本发布和读取仍可用，直接调用评论拒绝访问。 |

恢复用例依次使用 `membership-ready.json`、`membership-added.json`、`snapshot-ready.json`、`snapshot-done.json`、`revoke-ready.json` 和 `database-switched.json` 协调。独立源数据库应先加入两个现有合成账号，再用 PostgreSQL 原生工具备份，完成撤销后还原空目标库，并以同一独立日志启动目标 API。脚本使用旧会话验证权限重放，最后生成 `summary.json`。标记不包含账号凭据或评论正文。

此功能为明确发布版本提供评论。共同编辑、跨端版本编辑以及冲突合并仍由相应功能独立验证。

2026-11-24，修复文稿请求解析后的构建通过 Maven 全量验证、此变更涉及的 3 项隐私日志回归和 PostgreSQL 的 115 个 Liquibase 变更集，其中评论新增 2 个。真实 HTTP 验证了 4 KiB 正文、64 条配额、同键并发确认、角色及撤回。对旧库的原生 SQL 检查确认，当时评论、发布和编辑者授权均存在。使用原独立日志重放后，撤销的编辑者授权、已删除评论和撤回发布的数据均失效，未改动的评论保留。旧会话、旧地址及已删除评论的重试键仍被拒绝。后续注销编辑者会移除该账号写入的其余评论。 [恢复前 SQL](verify-results/artifact-comments-1795495691420/restore/pre-replay-db.json) · [恢复后 SQL](verify-results/artifact-comments-1795495691420/restore/post-replay-db.json) · [HTTP 验收](verify-results/artifact-comments-1795495691420/restore/summary.json)

生产 Web 用两个独立 Chrome 会话确认发布和评论操作，并验证撤销对已打开会话的影响。独立 MySQL 8.4 通过 4 KiB 约束、非法发布引用及撤回级联。关闭评论后发布能力仍可用。 [Chrome 用例](../clients/web/tests/artifacts-live.spec.ts) · [MySQL DDL](verify-results/artifact-comments-1795495691420/mysql-migration.json) · [关闭能力](verify-results/artifact-comments-1795495691420/disabled/summary.json)
