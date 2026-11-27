# 内容举报与运营处置自测

消费者通过 `POST /api/assistant/v1/reports` 提交举报。理由取 `safety`、`privacy`、`spam` 或 `other`。当前有效会话和目标原有阅读权限共同决定能否举报。首次提交返回 201，重复提交返回 200 和原回执。对同一发布更换理由或引用另一条回复返回 409。

| 类型 | 确切目标 |
| --- | --- |
| `assistant_reply` | 本人可读会话中的回复 ID `targetId` |
| `shared_reply` | JSON 中的 `shareToken` 与分享预览 `messages` 中从 0 开始的 `replyIndex`。目标须为助手回复 |
| `reminder_share` | JSON 中的 `shareToken` 与当前接收方预览的 `revision` |
| `hosted_site` | 公共站点地址 ID `targetId` 与当前展示发布代际 `revision` |

不可访问或已撤回的目标返回 404。工作空间分享要求举报人处于同一选定工作空间。站点和提醒举报绑定当时显示的版本或预览。

举报表保留源作用域、对象标识、创建时间与 SHA-256 证据指纹。分享令牌和正文仅用于当前请求校验。有效的回复可向源工作空间的授权运营身份提供最多 1,024 个 Unicode 码点的预览，站点和提醒只展示证据指纹。消费者回执包含举报 ID、类型、不透明目标 ID、理由、状态与创建时间。删除会话后，最小举报与处置审计仍可供已授权的运营用户读取。

## 运营接口与授权

后台使用 ContiNew 管理登录和 RBAC，按登录令牌中的用户与租户，在 `assistant_moderation_grant` 查询对应工作空间授权。通过后台的菜单与角色配置建立权限点，按目标工作空间给经批准的运营身份配置授权记录。初始迁移不授予工作空间访问。

| 操作 | 路径 | 条件 |
| --- | --- | --- |
| 查询待处理列表 | `GET /system/assistant/moderation/workspaces/{workspaceId}/reports` | `assistant:report:review` 和对应工作空间授权 |
| 查看详情与审计 | `GET /system/assistant/moderation/workspaces/{workspaceId}/reports/{reportId}` | 同上 |
| 写入处置 | `POST /system/assistant/moderation/workspaces/{workspaceId}/reports/{reportId}/decision` | `assistant:report:decide` 和工作空间授权的 `can_decide=true` |
| 撤回确切发布 | 同一处置接口提交 `{"decision":"withdraw"}` | 另需 `assistant:report:withdraw`，并核对举报中对应的发布类型及代际 |

支持驳回、升级以及撤回可撤回的已发布对象。撤回沿用原有分享、提醒或托管的独立隐私日志。案件目标在处置前已不可见时，状态收敛到 `target_unavailable`。处置事务同时保存运营用户、租户、请求决策、最终状态和时间。重复相同决策返回原结果，第二种决策返回 409。恢复更早备份后，已撤回对象继续受独立日志阻断，后续处置按当前目标是否可见记录。

## 本地复跑

按照[模型网关自测](assistant-model-gateway.md)开启隔离回环后端、测试注册与本地模型。使用专门的模拟账号运行脚本。

```powershell
node qa/assistant-moderation-smoke.mjs http://127.0.0.1:18090
```

默认模式创建两个消费者测试账号，检查未登录、跨账号、跨工作空间、重复举报以及会话删除后的行为。为模拟运营端权限边界，可传入 `ASSISTANT_TEST_MODERATOR_TOKEN`。完整端到端复跑还需 `ASSISTANT_TEST_REPORT_OWNER_TOKEN` 对应模拟消费者账号的工作空间已有同一管理身份和租户的授权，且允许处置。测试用 workspace 授权可在隔离库中按当前操作者与模拟工作空间填入以下 SQL 的参数，使用参数化客户端执行。

```sql
INSERT INTO assistant_moderation_grant (admin_tenant_id, admin_user_id, workspace_id, can_decide)
VALUES (?, ?, ?, TRUE);
```

## 已验证

2026 年 11 月 22 日，按 Java 17 目标编译助手后端，8 项 JUnit 测试通过。测试覆盖工作空间过滤、运营授权来源、签名入口拒绝、举报和处置幂等，以及撤回后的证据边界。在隔离 PostgreSQL 16 的回滚事务中执行迁移与合成场景，验证重复举报与重复审计受到唯一约束，模拟软删除后案件与审计均为 `target_unavailable`。

打包后端的回环自测使用 PostgreSQL 16、隔离 Redis 和测试库内置 ContiNew 管理员。真实后台登录通过 RSA 密码加密与验证码。双向令牌互访、跨账号和工作空间访问均被拒绝。并发重复举报返回同一回执。授权管理员可查看待处理列表和有效预览。消费者软删除会话后，预览消失，处置状态为 `target_unavailable`。数据库确认同一举报只有一条已提交审计，记录了实际管理员和其登录租户。

同一管理员在临时授权前与撤销后均被拒绝。只读授权允许查看、拒绝处置。注销后旧管理令牌访问运营接口返回 401。测试结束时已撤销临时工作空间授权并注销测试会话。

追加回归使用 175 项 PostgreSQL 变更、MySQL 8.4 独立命名管道、实际 ContiNew 运营授权与生产构建的 Chrome。公开和同工作空间共享回复、公开站点及提醒模板分别验证了确切撤回和旧库重放。最终包通过设备会话撤销竞态，同一会话被删除后旧提交返回 401 且未写入，重新登录可以提交。 [共享回复与会话并发](assistant-shared-report-moderation.md) · [公开产物及提醒](assistant-public-target-reports.md)
