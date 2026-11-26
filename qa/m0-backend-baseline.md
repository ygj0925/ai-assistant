# ContiNew 后端基线

后端位于项目内的 `services/api`，持有独立 Git 元数据。起始标签为 `v4.2.0`，提交为 `6c6724e4444268b81e27442abb93252d3bfc2bd6`，本地分支是 `codex/ai-assistant-backend`。产品要求由项目根目录的 OpenSpec 记录。 [ContiNew 上游仓库](https://github.com/continew-org/continew-admin.git)

## 本地检出与构建

```powershell
# 从项目根目录执行。已有后端工作树时，直接运行构建部分。
git clone -c core.autocrlf=false -c core.eol=lf --branch v4.2.0 https://github.com/continew-org/continew-admin.git services/api
git -C services/api switch -c codex/ai-assistant-backend
Push-Location services/api
.\mvnw.cmd -B verify
Pop-Location
```

Windows 实测使用 JDK 21.0.10 与仓库的 Maven Wrapper 3.9.16。上游编译目标与依赖字节码基线为 Java 17，ContiNew Starter 为 2.17.0。原始 Git 设置把部分文件检出为 CRLF，统一为标签中的 LF 后，逐文件核对 Git Blob 哈希及暂存区。2026 年 11 月 22 日，完整 Maven `verify` 退出码为 0，Surefire 报告合计 12 个用例、0 失败、0 错误、0 跳过。上游在此版本的 Surefire 配置中排除了依赖数据库及 Redis 的完整应用上下文测试，因此迁移、真实启动与登录单独验证。

## 模块边界

| 模块 | 用途 |
| --- | --- |
| `continew-server` | 启动、运行配置、Liquibase 及部署入口 |
| `continew-system` | 借用后台账号、RBAC、文件管理和审计 |
| `continew-common` | 借用统一错误、验证、权限、数据访问和基础设施 |
| `continew-plugin-tenant` | 候选的租户上下文基础，消费者会话仍校验用户和工作空间成员关系 |
| AI 产品模块 | 客户身份与令牌用途、项目、会话及运行、模型路由、权益、用量计费及后台任务 |

升级时先追踪上游正式标签及所需修复，再回归登录、迁移、权限、模型和 SSE。上游开发分支另有 [RSA 延迟初始化修复](https://github.com/continew-org/continew-admin/commit/64c0dc28c300a858f0f2f0f55dfca1766c8ee2ee)，是否需要在当前版本适配以真实启动及登录用例为准。

## PostgreSQL 启动与认证验证

启用 `dev,postgres` 配置，使用 `ASSISTANT_DB_JDBC_URL`、`DB_USER`、`DB_PWD`、`REDIS_PORT` 和 `REDIS_PWD` 连接隔离环境。试验使用 PostgreSQL 16.15、Redis 7.0.15 和仅绑定回环地址的 HTTP 服务。PostgreSQL 数据库由独立非超级用户持有。PostgreSQL 配置使用单独的 Liquibase 主文件，沿用同一标签的 PostgreSQL SQL。

在新增 PostgreSQL 配置后，后端及其 Maven 依赖模块的 `verify` 退出码为 0。空库实际执行 11 个 Liquibase changeset，应用成功启动。用空库种子的测试账号完成 CAPTCHA 和 RSA 登录，能读取当前账号资料。使用刷新 Cookie 正常登出后，旧访问令牌和匿名请求均被拒绝，返回 HTTP 401。本次未复现 RSA 初始化故障，后续升级仍保留这条回归用例。

使用独立的 Redis 7 实例和数据库连接，日志确认登录请求在默认租户 `0` 下执行。没有使用 Guard Find 的共享缓存。

[迁移探针](ContiNewMigrationProbe.java) 使用打包产物中的 JDBC 与 Liquibase，连接一套专用空库。已验证先运行一个 changeset，再升级至 11 个，最后重跑仍为 11 个，内置测试管理员只有一条。

将 `QA_POSTGRES_URL`、`DB_USER` 和 `DB_PWD` 配置为专用空库连接后，可在项目根目录复跑。

```powershell
Push-Location services/api/continew-server/target/app
java --class-path 'config;lib/*' '../../../../../qa/ContiNewMigrationProbe.java'
Pop-Location
```
