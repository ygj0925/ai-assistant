# 本地组织、成员和座席验收

在独立开关开启时，经授权的 ContiNew 运营会话可使用 `POST /system/assistant/organizations` 建立组织，指定已有的消费账号作为所有者。运营会话须持有 `assistant:organization:provision` 权限，并属于有效的后台租户。请求需要 `Idempotency-Key`、组织名称、所有者账号、1–128 个本地座席和显式确认。重试匹配的请求返回原组织。

组织使用独立工作空间。消费者以当前设备令牌和 `X-Workspace-Id` 选择组织。所有成员可读取自己的角色以及使用座席数。所有者可配置管理员和普通成员。管理员可纳入或移除普通成员。成员配置和事务内审计由当前角色和选定组织保护。

移除操作核对当前成员代际并在独立日志中退休该代际。重新纳入获得新代际。角色变更使用单独的授权代际，保留基础组织成员关系和私有文件。恢复过去的数据库后，已退休的管理员授权降为普通成员。所有者可发起账号删除，组织管理会在指定所有者缺失时暂停。审计最多保留最近 200 条及 90 天内记录，账号删除时移除其审计身份字段。

## 本地复跑

使用仅监听回环的独立 PostgreSQL 和 Redis，启用并绑定独立删除日志。设置 `assistant.organizations.enabled=true`、`assistant.organizations.provision-enabled=true` 和 `assistant.workspace-departure.enabled=true`。在合成测试环境中通过 ContiNew 实际登录取得受权管理会话，通过进程环境注入 `ASSISTANT_TEST_ORG_OPERATOR_TOKEN`。验证完注销后台管理会话。

```powershell
node qa/assistant-organization-smoke.mjs http://127.0.0.1:18139
```

添加 `--replay $evidenceDirectory http://127.0.0.1:18140` 验收恢复。在 `backup-ready` 后备份验收库并创建 `backup-done`。收到 `cutover-ready` 后停止源服务，将备份恢复到独立空库，再用相同的独立日志启动恢复服务并创建 `restore-done`。

企业目录集成、正式账单与用量汇总由其对应开关和测试环境分别验收。

## 验收结果

2026 年 11 月 24 日，使用真实 ContiNew RSA 及验证码登录，在打包后端验证后台会话和消费者令牌各自的接口。没有组织配置权限的后台普通角色能正常登录，配置组织返回 403。由后台配置的两个组织互相隔离。个人工作空间隐藏组织能力，当前有效组织成员可查看组织摘要。

最后一个座席同时收到两次提交，结果分别为 201 和 409。审计记录成功的配置、纳入、改角及移除操作。管理员降为成员后仍可读取该组织内自己的项目，管理查询被拒绝。旧代际无法移除重新纳入的成员。通过实际动作验证 200 条保留上限，91 天前的合成记录从读取和周期清理中移除，账号删除后的身份字段被清空。

通过真实 PostgreSQL 事前备份和恢复后，Liquibase 识别 147 个原有变更集，执行 0 个新增变更集。相同独立日志继续限制旧的管理员权限，退休的成员代际不可访问，另一组织中历史审计的已删身份仍为空。MySQL 8.4.11 的隔离命名管道验证座席、角色代际、审计来源约束和新日志类别。[MySQL 记录](verify-results/organization-audio-mysql-2026-11-24/native.log)

Windows Chrome 生产构建通过实际工作空间选择、纳入管理员、查询审计、降级后保留私有项目和撤权后的界面更新。[Chrome 结果](verify-results/organization-chrome-2026-11-24/browser.log)

## 组织用量汇总

当前组织所有者和管理员可以按 UTC 查询最近 7 天或 30 天。服务按运行的提交日期归集提交数、完成数、结算单位和未释放预留。查询仅访问选定组织的运行与唯一结算行。返回日级汇总，不返回用户标识、消息或提示词。账号降级后用量入口随组织角色刷新消失，接口拒绝新请求。

同日真实请求在个人空间和组织各完成一次运行。组织报告仅计一次组织运行，同一幂等请求重试不增加笔数。Chrome 验证七日表格、降级后的接口拒绝和界面更新。PostgreSQL 从 157 个应用变更集升级至 163，新增报告索引，原有 13 个运行和结算行及 1,686 个结算单位对比一致。MySQL 8.4 验证同一索引和原生分桶查询。正式组织账单、计价和企业目录继续按对应环境验收。 [Chrome](verify-results/organization-usage-2026-11-24/browser.log) · [升级前](verify-results/organization-usage-2026-11-24/postgres-before.json) · [升级后](verify-results/organization-usage-2026-11-24/postgres-after.json) · [MySQL](verify-results/organization-usage-2026-11-24/mysql.log)
