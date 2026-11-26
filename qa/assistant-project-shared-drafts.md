# 共享 Markdown 草稿和版本恢复

所有者可以在同工作空间项目中明确新建共享草稿。当前编辑者可以写入新版本或恢复以前的版本，查看者可以阅读和下载。每次写入携带用户读取到的基准版本。若两位编辑者使用同一基准并发提交，先写入的一人生成新版本，另一人得到 409，并可读取已提交的新版本后再编辑。恢复以前的版本会生成新的不可变版本并保留选择的来源版本号。

草稿每项目最多 32 份，每份至多 32 个版本，每版 Markdown 最多 32 KiB。已提交的版本历史对仍有权限的项目成员开放，版本记录标明当前用户是否是作者。退出或撤销项目角色后，原会话不能继续读取、下载、编辑或恢复。原始私有产物及其附件保持各自权限。

共享草稿在创建前明确显示保留规则。任意贡献者注销账号时，服务清除含该贡献者版本的整份草稿及历史，因为后续版本与恢复版本可能保留已删除账号的文本。所有者也可删除整份草稿。还原先前备份时，独立删除日志再次应用账号注销、草稿删除和角色撤销。未受影响的草稿仍可访问。

在独立回环 API 上开启 `assistant.project-shared-drafts.enabled`、项目协作、消费者注册及绑定的删除日志。验收使用合成账号和文本。

| 模式 | 命令 | 验证 |
| --- | --- | --- |
| 恢复 | `node qa/assistant-project-shared-drafts-smoke.mjs http://127.0.0.1:18133 restore <新证据目录> http://127.0.0.1:18134` | 两编辑者提交冲突、已接受文本、版本历史、恢复、精确 UTF-8 下载、角色撤销、配额、贡献者注销和旧备份。 |
| 关闭 | `node qa/assistant-project-shared-drafts-smoke.mjs http://127.0.0.1:18134 disabled <新证据目录>` | 基本项目协作仍可用，草稿入口和直接调用关闭。 |

使用 `membership-ready.json`、`membership-added.json`、`snapshot-ready.json`、`snapshot-done.json`、`revoke-ready.json` 和 `database-switched.json` 协调测试。测试驱动先在独立源数据库添加三个现有合成账号。撤销前以 PostgreSQL 原生工具备份。完成撤销与注销后，将早期备份还原到空的目标数据库，核对其中的旧版本和旧角色，然后以原独立日志启动目标 API。确认重放结束后使用原会话验证并写出 `summary.json`。过渡文件只保存合成对象 ID 和结果。

此阶段采用显式共享 Markdown 草稿和基准版本并发检查。客户端离线编辑、自动合并和其他格式的多人共编对应不同的验收。

2026-11-24，PostgreSQL 独立环境通过 119 个 Liquibase 变更集，其中草稿新增 3 个。原始快照含已接受的编辑者角色、待删除草稿、含五版的受影响草稿和其中复制了贡献者文字的后续版本。用原独立日志重放后，旧角色已撤销，受影响的五版与指定删除草稿均被移除。未受影响的对照草稿能用原查看会话读取下载。重新授权、重新创建同名草稿仍无法使用旧草稿地址。MySQL 8.4 验证项目范围、唯一版本序号、版本上限和贡献者删除级联。 [恢复前 SQL](verify-results/shared-drafts-1795497684864/restore/pre-replay-db.json) · [恢复后 SQL](verify-results/shared-drafts-1795497684864/restore/post-replay-db.json) · [HTTP 验收](verify-results/shared-drafts-1795497684864/restore/summary.json) · [MySQL DDL](verify-results/shared-drafts-1795497684864/mysql-migration.json)

生产 Web 在两套 Chrome 会话验证显式共享、并发冲突后保留未保存编辑、查看最新版本并重新提交、原始 Markdown 下载、恢复为新版本以及旧权限撤销。Maven 全量验证及四项协作隐私日志回归通过。 [浏览器用例](../clients/web/tests/shared-drafts-live.spec.ts) · [浏览器记录](verify-results/web-shared-drafts-2026-11-24/browser.log)

单独关闭共享草稿开关后，基础项目协作仍可用，草稿能力隐藏，直接调用返回 403。 [关闭开关验收](verify-results/shared-drafts-1795497684864/disabled/summary.json)

Android Pixel Tablet API 36 在同构建的独立后端通过两种角色的原生登录、真实工作空间切换、接受邀请、读取同一文稿的两个 UTF-8 版本以及只读回退。编辑者可看到使用桌面网页编辑的入口说明。撤回查看授权后，已打开的历史正文在实测 6.8 秒清除。回到前台时若复核失败则清除内容，恢复权限连接后重新读取同一版本。TypeScript 和两端 Hermes 导出通过。iOS/iPadOS 真机验收仍归平台交付。 [移动端验收](../clients/mobile/README.md#共享文稿)
