# 共享回复举报与撤回复测

消费者从公开链接或同工作空间分享读取回复后，可以使用当前登录会话举报指定的助手消息。后台运营需具备目标工作空间处置授权及 `assistant:report:withdraw` 权限才可撤回该分享。撤回限制指定的发布，源会话和其他发布按各自权限继续读取。[举报接口与运营授权](assistant-moderation.md)

## 已验证

2026 年 11 月 24 日，生产构建的 Web 在真实 Chrome 中从指定共享回复提交举报，提交前后分享仍可正常读取。[浏览器记录](verify-results/shared-moderation-2026-11-24/browser.log)

同日使用 PostgreSQL 16 的独立数据库与删除日志验证了公开分享和同空间分享举报。四次并发提交产生一张回执，运营详情显示正确来源和原文指纹，读取权限与处置权限分别授权。实际 ContiNew 运营身份并发撤回只提交一条处置审计。恢复到撤回前的备份后，两条指定分享仍返回 404，对照分享及源会话照常可读，旧案件显示目标不可用。初始启动执行 175 项变更集，恢复启动执行 0 项。[端到端记录](verify-results/shared-moderation-2026-11-24/replay.log) · [PostgreSQL 变更集](verify-results/shared-moderation-2026-11-24/postgresql.log)

MySQL 8.4 隔离命名管道验证了追加迁移。已有回复举报与审计保留，新的分享撤回终态可持久化，缺失来源账号或越界的回复索引被约束拒绝。[MySQL 迁移证据](verify-results/shared-moderation-2026-11-24/mysql.log)

在追加设备会话加锁的候选包上，PostgreSQL 确认已通过初始认证的举报请求等待举报设备的会话行。事务移除该会话后，请求返回 401，库内对应举报数为 0。相同用户重新登录后首次提交同一目标获得 201。[数据库并发证据](verify-results/shared-moderation-2026-11-24/session-race-db.log) · [HTTP 验证](verify-results/shared-moderation-2026-11-24/session-race-http.log)

## 复跑

恢复场景运行 `assistant-shared-moderation-smoke.mjs`，传入原库和还原库的两个回环 API 地址及新的检查点目录。环境变量 `ASSISTANT_TEST_SHARED_MODERATOR_TOKEN` 使用专用合成 ContiNew 账号的有效会话。脚本在同目录请求测试工作空间的只读与处置授权，等待较早备份和通过同一独立日志的恢复。

设备撤销场景并行运行 `assistant-moderation-session-race-smoke.mjs` 和 `assistant-moderation-session-race-pg.sh`，共享同一个空检查点目录。前者接受测试 API 回环地址和检查点目录。后者使用 `PGHOST`、`PGPORT`、`PGUSER` 和 `PGDATABASE`，连接具备查看阻塞关系和删除合成账号会话权限的 PostgreSQL 16 测试库。库名使用 `assistant_…moderation_lock_…`，目录使用本地可访问路径。两者分别通过数据库与 HTTP 验证同一次撤销竞态。
