# 本地依赖和验收

这套环境提供 PostgreSQL、Redis 和 SeaweedFS S3。服务端口只绑定到回环地址。PostgreSQL 的业务数据库为 `ai_assistant`，用户为 `assistant`。迁移测试使用独立普通用户 `assistant_qa` 与专用临时数据库。

## 启动

从项目根目录执行。Node 用于生成本地密码，Docker Compose 用于启动服务。已有的 `infra/local/.env` 会继续使用。

```powershell
node infra/local/init-env.mjs
docker compose --env-file infra/local/.env -f infra/local/compose.yaml up -d --wait
```

若 Docker 安装在 WSL，给 Docker 命令加上 `wsl.exe --exec`。默认使用 PostgreSQL 16.16、Redis 7.2.17 和 SeaweedFS 4.53。可通过 `ASSISTANT_POSTGRES_IMAGE`、`ASSISTANT_REDIS_IMAGE` 或 `ASSISTANT_S3_IMAGE` 使用同版本的本地或镜像仓库副本。 [PostgreSQL 镜像](https://hub.docker.com/_/postgres) · [Redis 镜像](https://hub.docker.com/_/redis) · [SeaweedFS 4.53](https://github.com/seaweedfs/seaweedfs/releases/tag/4.53)

| 服务 | 本地地址 | 应用参数 |
| --- | --- | --- |
| PostgreSQL | `127.0.0.1:25432` | `DB_NAME=ai_assistant`，`DB_USER=assistant`，`DB_PWD` 取 `ASSISTANT_DB_PASSWORD`；完整 URL 可用 `ASSISTANT_DB_JDBC_URL=jdbc:postgresql://127.0.0.1:25432/ai_assistant?stringtype=unspecified` 覆盖 |
| Redis | `127.0.0.1:26379` | `REDIS_HOST=127.0.0.1`，`REDIS_PORT=26379`，`REDIS_PWD` 取 `ASSISTANT_REDIS_PASSWORD` |
| S3 | `http://127.0.0.1:28333` | 区域 `us-east-1`，桶 `assistant-local`，使用路径式地址和本地 S3 凭据 |

后端启用 `dev,postgres` 配置启动后，Liquibase 在业务数据库应用 PostgreSQL 迁移。原生 S3 客户端可在 `infra/local/.env` 中读取 `ASSISTANT_S3_ACCESS_KEY` 和 `ASSISTANT_S3_SECRET_KEY`，用于访问本地桶。数据库和对象数据保存在项目专用的 Docker 卷中。

`infra/local/.env` 供 Compose 读取，Java 进程不会自动读取该文件。启动 Java 前需注入上表的数据库、Redis 连接变量。后端默认监听 `18090`，可用 `SERVER_PORT` 覆盖；改变端口后同步设置 Web 的 `ASSISTANT_API_ORIGIN` 和移动端的 `EXPO_PUBLIC_ASSISTANT_API_ORIGIN`。本地 Web 为 `http://127.0.0.1:3000`，后端的 `ASSISTANT_WEB_ORIGIN` 与桌面的 `ASSISTANT_DESKTOP_WEB_ORIGIN` 使用该地址。

首次初始化前，可在 `.env` 中设置 `DB_NAME` 更换库名，并在 Java 环境中设置相同值。已设置的 `ASSISTANT_DB_JDBC_URL` 优先于 `DB_NAME`、`DB_HOST`、`DB_PORT`，旧 URL 需要同时更新。修改库名不会重命名已有数据库，已有 PostgreSQL 数据卷也不会重跑初始化 SQL；如要继续使用旧库 `assistant`，两端显式设置 `DB_NAME=assistant`。如需使用新库，应先创建由 `assistant` 用户持有的 `ai_assistant` 库，再按需迁移原数据。

## 自测

先按[后端入口](../../README.md)构建 ContiNew Admin，从项目根目录运行。已有堆栈可省略 `-Start`。通过 WSL 使用 Docker 时添加 `-Wsl`。

```powershell
pwsh -File infra/local/verify.ps1 -Start
```

验证包括带密码的 Redis 读写、空库迁移、增量升级、重复执行不新增迁移记录、S3 上传和下载内容一致，以及匿名请求被拒绝。对象验证使用[合成资料](fixtures/reference.txt)，并在结束时清理自测对象。临时数据库由脚本创建和清理，业务数据库与 Docker 卷可用于后续联调。

停止服务可运行 `docker compose --env-file infra/local/.env -f infra/local/compose.yaml down`。

## 验证记录

2026 年 11 月 22 日，Docker Compose 配置校验通过。镜像下载超时期间，使用独立的本地 PostgreSQL 16.15、Redis 7.0.15 和 rclone 1.76.0 的 S3 服务作接口验收。业务数据库拒绝 QA 用户访问，迁移探针得到 `1 → 11 → 11` 个变更集。Redis 验证了带密码的读写，S3 验证了签名上传、下载内容一致和匿名访问拒绝。SeaweedFS 容器启动仍待镜像可用后复测。 [rclone S3 服务](https://rclone.org/commands/rclone_serve_s3/)

加入消费者账号表后，在独立 PostgreSQL 数据库复测，变更集记录为 `1 → 17 → 17`。会话和消息表随后从 17 个变更集增量升级到 21 个，并通过会话和历史 HTTP 自测。 [会话目录和历史验证](../../qa/assistant-conversation.md)
