# 对话阅读锁验收

已登录的用户可以明确锁定当前工作空间中的自有对话。普通历史列表和标题、正文搜索隐藏这条记录，独立的锁定目录仅显示对话 ID。直接读取、消息历史、运行输出、事件流、衍生本地产物和个人数据导出会执行同一阅读策略。报告审核保留案件与审阅记录，锁定期间隐藏原文预览和证据摘要。加锁会终止未完成的相关运行和本地导出，并永久撤回该对话曾发布的分享链接和关联项目发布。密码验证成功后恢复私有阅读。需要重新明确发布时，服务生成新的链接。

开启 `assistant.conversation-read-lock.enabled` 允许新增对话锁。已有锁的执行由当前状态和独立删除日志决定。单独关闭新增功能后，已锁内容仍不可读，仍可使用锁定目录并输入当前密码恢复。解锁会验证当前会话和工作空间权限，并限制密码尝试。接口返回 `Cache-Control: no-store`。

加锁控制服务端的后续读取。先前由有权接收者创建的独立会话副本、已经下载的文件和已送达的事件不属于原对话的后续读取。当前独立项目文件没有与对话绑定，继续使用该文件本身的权限。

在项目协作、对话分享、私有产物、产物版本发布、本地导出、模拟模型、消费者注册和独立删除日志均已配置的回环测试实例运行。

```powershell
node qa/assistant-conversation-read-lock-smoke.mjs http://127.0.0.1:18133 restore <新证据目录> http://127.0.0.1:18134
```

测试驱动根据 `membership-ready.json` 添加现有合成账号的测试工作空间成员关系，写入 `membership-added.json`。脚本打开实际事件流并在收到一段内容后生成 `snapshot-ready.json`。驱动立即备份 PostgreSQL，然后写入 `snapshot-done.json`。完成锁定和旧读取拒绝后生成 `revoke-ready.json`。先以原生 SQL 检查旧备份中的有效授权和运行，再以原独立日志启动目标实例，重放结束后写入 `database-switched.json`。

脚本验证早期备份的私有正文、两个已知分享地址、关联产物和旧事件流均无法绕过锁。之后以当前密码恢复私有阅读，重新创建需要的分享。收到 `flag-off-ready.json` 后，使用同一目标数据库和日志关闭新增锁开关并重启，写入 `flag-off-started.json`。脚本继续验证旧锁和密码恢复入口，并写出 `summary.json`。标记文件只包含合成对象 ID 与结果。

## 实测结果

- PostgreSQL 16 和 Redis 的回环测试使用 126 条 Liquibase 变更的完整应用包。备份时合成运行仍进行中，两条已知分享和一个产物发布仍有效。重放同一独立日志后，旧运行已取消且只结算一次，分享均撤回，旧产物发布已移除，私有产物及独立未锁对话仍保留。运行中的事件流在加锁后结束，旧 SSE 续传以 `423` 和 `no-store` 拒绝。[恢复前状态](verify-results/conversation-read-lock-1795501400564/restore/pre-replay-db.json) · [恢复后状态](verify-results/conversation-read-lock-1795501400564/restore/post-replay-db.json)
- 同一目标关闭新增锁功能并重启后，已有锁继续拒绝读取，当前密码可以从独立目录恢复私有阅读。此前撤回的链接和发布继续拒绝访问，已经授权生成的独立接收副本保留。HTTP 全程测试通过。[HTTP 验收结果](verify-results/conversation-read-lock-1795501400564/restore/summary.json)
- MySQL 8.4 隔离实例验证默认开放、加锁和解锁状态的持久化字段，以及缺少有效修订标记时的数据库约束。原先的合成目录记录全部保留。[MySQL 迁移结果](verify-results/conversation-read-lock-1795501400564/mysql-migration.json)
- 生产构建的 Web 客户端在 Chrome 的两个独立浏览器会话验证加锁清理已打开正文、历史和搜索隐藏、错误密码保留当前登录、正确密码恢复阅读。Playwright 1 项通过。[浏览器结果](verify-results/conversation-read-lock-chrome-2026-11-24/browser.log)
Android API 36 平板模拟器验证了生成中锁定、返回前台二次核对、冷启动不恢复旧正文与密码恢复。应用移除已锁定对话的本机续接标记。关闭新加锁开关后，原生客户端仍可用当前密码恢复已有锁。移动 TypeScript 和两端 Hermes 打包通过。 [Android 阅读锁验收](../clients/mobile/README.md#加锁对话)
