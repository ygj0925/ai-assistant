# 私有项目文本资料验收

项目所有者可以保存、搜索和删除项目内的文本资料。资料正文按 UTF-8 计量，最多 16,384 字节，名称最多 120 个 Unicode 码点。正文可保留换行和制表符，二进制控制字符会被拒绝。每个项目最多保存 64 条有效资料，删除一条后可以继续新增。

列表只返回标识、名称和创建时间。正文需要在当前工作空间内以项目所有者身份单独读取。搜索对名称与正文做 Unicode 规范化和大小写折叠，`%`、`_` 和 `!` 按文本匹配。资料删除与账号注销通过独立日志在旧数据库恢复后重放。

## 运行

使用独立 PostgreSQL 和 Redis 启动回环测试服务，打开消费者注册。开启资料能力需要 `--assistant.project-resources.enabled=true` 和[已绑定且可写的独立删除日志](assistant-erasure.md)。脚本只接受显式测试端口并拒绝常用的 18080。测试账号、文本和资料均由脚本合成。

MySQL 开发配置和 PostgreSQL 配置都使用直连 JDBC。运行私有资料服务时，应继续关闭会输出 SQL 绑定值的调试日志，避免记录正文或搜索词。

```powershell
node qa/assistant-project-resources-smoke.mjs http://127.0.0.1:18101 normal
node qa/assistant-project-resources-smoke.mjs http://127.0.0.1:18101 quota
node qa/assistant-project-resources-smoke.mjs http://127.0.0.1:18102 disabled
```

| 模式 | 验收范围 |
| --- | --- |
| `normal` | 中文与 emoji 字节往返，最大长度与超限，二进制控制字符，访客与跨账号、项目、工作空间访问，分页和字面量检索，资料删除及账号注销 |
| `quota` | 两次并发争用最后一个名额，提交后保持 64 条，删除后释放名额 |
| `disabled` | 在关闭能力或未绑定删除日志的专用测试服务上，核对认证顺序及能力拒绝 |
| `restore` | 用删除前的数据库备份和最新独立日志恢复，校验已删除资料、已注销账号和正常对照资料 |

## 备份恢复联测

为 `restore` 分配空证据目录。从脚本启动到联测结束，为同一回环地址保留专用 JVM 和数据库。夹具驱动使用 PostgreSQL 客户端执行备份。数据库切换沿用[账号注销恢复](assistant-erasure.md)的配置与原独立日志。

```powershell
node qa/assistant-project-resources-smoke.mjs http://127.0.0.1:18101 restore qa/verify-results/project-resource-restore
```

| 标记 | 创建者 | 含义 |
| --- | --- | --- |
| `backup-ready.json` | 脚本 | 合成账号和资料已创建，可执行 `pg_dump`。文件仅包含资源标识，供恢复后核对数据 |
| `backup-done.json` | 夹具驱动 | 删除前的备份已写入，可以执行资料删除和账号注销 |
| `restore-ready.json` | 脚本 | 删除与注销的 HTTP 结果已核验，可以停止专用 JVM，并恢复到另一空库 |
| `database-switched.json` | 夹具驱动 | 删除前的备份已恢复到空库。用同一地址、原日志路径和原日志标识启动该库 |
| `summary.json` | 脚本 | 服务重启后的读取与撤回状态已核验 |

二进制附件、扫描、端侧上传和短期签名下载由文件任务另行验收。

2026 年 11 月 24 日，打包 API 通过能力关闭、Unicode、搜索、跨空间与跨项目访问拒绝、并发额度、删除及账号注销测试。Chrome 生产构建通过导入 UTF-8 文本、检索、逐字节下载验证和删除。使用真实 `pg_dump` 恢复删除前的数据库后，原资料仍不可读，数据库中的标题、原文和搜索字段已清空，注销账号的资料记录已物理删除，正常对照资料仍可访问。PostgreSQL 迁移到 72 个变更集并可重复运行，MySQL 增量保留既有数据并接受 `RESOURCE` 撤回记录。

## 2026 年 11 月 24 日验证记录

专用 PostgreSQL、Redis 和独立删除日志上，`normal` 与 `quota` 均通过。测试覆盖中文与 emoji 的 16 KiB 边界，跨账号、项目、工作空间和检索游标的越权拒绝，删除与注销，以及并发争用最后一个名额。另一套专用服务的 `disabled` 用例通过。
