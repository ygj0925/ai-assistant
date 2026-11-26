# 对话分享与撤回验收

Web 可以分享当前已保存的消息分支，也可以只分享一条助手回复。发布者先选择受众并查看文本预览，再确认发布。快照保留预览时的标题与选定消息。后续重命名、继续聊天或创建分支不会修改已发布内容。

链接默认有效七天。知道链接的人可以读取已明确发布的个人未归类会话。会话移入私有项目时，已有的有效公开链接会永久撤回。项目会话和其他工作空间的会话使用成员受众，读取和复制时均检查当前成员资格。快照只包含文本，不包含附件、运行元数据或发布者账号。接收者登录后可在有权限的工作空间建立独立副本。撤回原链接会阻断后续读取和复制，接收者此前有权保存的副本仍由其自身管理。

访问凭据只在发布响应中返回一次。Web 使用 `/share#…`，读取与复制请求将凭据放在 POST 请求体中。公开页面和 API 响应均限制缓存或索引，后端只保存凭据摘要。管理页可查看过期和撤回状态。

会话所有者可以开启分享限制。开启后，公开和工作空间链接均撤回，新预览和发布请求被拒绝。所有者仍可阅读和继续自己的对话，并可查看链接撤回状态。接收者已经保存的独立副本仍按自身权限管理。解除限制后，所有者可重新预览并发出新链接。旧链接和限制前的预览继续失效。分享限制和撤回记录会随独立日志在恢复时重放。使用 PIN 或设备认证保护本人读取的会话锁属于后续验收范围。

## 启动测试服务

测试使用回环地址、独立 PostgreSQL/Redis 和确定性 `local-echo`。默认关闭分享。启用时需同时配置[独立删除日志](assistant-erasure.md)，以便恢复旧备份时重放分享撤回。日志的 UUID 和原文件需要在恢复时成对保留。

```text
--assistant.shares.enabled=true
--assistant.privacy.erasure-enabled=true
--assistant.privacy.journal-path=<测试日志的绝对路径>
--assistant.privacy.journal-id=<日志首行中的 UUID>
```

关闭发布能力时可使用当前版本关闭 `assistant.shares.enabled`，并保留已绑定的删除日志。恢复或回退时使用能够识别日志中 `SHARE`、`SHARE_LOCK` 和 `SHARE_UNLOCK` 记录的后端版本。

## 自测入口

```powershell
node qa/assistant-sharing-smoke.mjs http://127.0.0.1:18093
node qa/assistant-sharing-smoke.mjs http://127.0.0.1:18092 disabled
```

成员和过期用例额外接受 `workspace` 与证据目录。脚本写出 `membership-ready.json` 时，在专用数据库为合成接收方加入指定工作空间并写入 `membership-added.json`。脚本验证读取、复制、分享限制和重新发布后写入 `membership-read.json`。移除该合成成员，再写入 `membership-removed.json`。当 `expiry-ready.json` 出现时，将对应合成分享的发布时间与到期时间移至过去，写入 `expiry-set.json`。

恢复用例额外接受 `restore` 与证据目录。脚本写出 `backup-ready.json` 时，备份测试数据库并写入 `backup-done.json`。脚本随后执行链接撤回、源会话删除、项目迁入和分享限制，并解除其中一条会话的分享限制。`restore-ready.json` 出现后，停止该测试服务，将备份恢复到另一个空库，然后确认原服务已经停止并写入 `database-switched.json`。用原端口和原删除日志启动后端。脚本检查旧链接撤回、两种分享限制状态、仍有效的控制链接及独立副本。

```powershell
node qa/assistant-sharing-smoke.mjs http://127.0.0.1:18093 workspace qa/verify-results/share-workspace
node qa/assistant-sharing-smoke.mjs http://127.0.0.1:18093 restore qa/verify-results/share-restore
```

运行 Web 生产版自测时指定测试后端和 `ASSISTANT_WEB_TEST_SHARE_FEATURES=true`。定向浏览器用例覆盖两个独立账号从发布、接收、复制到撤回的旅程。 [Web 自测入口](../clients/web/README.md#验证)

## 本地验证记录

- 打包 API 通过发布预览、旧预览冲突、其他分支隔离、并发重复复制、独立副本继续聊天、撤回、过期、删除源内容及注销发布者等用例。在未配置独立删除日志的新测试库中，即使打开分享开关，API 仍拒绝发布和管理分享。
- PostgreSQL 16.15 的空库升级和重复执行得到 `1 → 64 → 64` 个变更集。MySQL 8.4.11 在已有数据的独立库上执行增量，保留既有删除记录，并接受新分享、副本及 `SHARE` 撤回记录。
- 真实 Chrome 在 Web 生产构建中完成两账号发布、手机视口访问、继续为独立副本和撤回。模拟测试额外覆盖浏览器从缓存恢复页面时重新校验链接，避免直接显示旧快照。
- 工作空间受众通过实际数据库的合成入组和退组测试。Web 可在账号面板或分享页切换到已获授权的空间。2026 年 11 月 24 日，生产构建通过真实双账号测试。个人空间无法读取受限链接，切换到授权来源空间后可保存副本，切回个人空间时清除原空间的对话和草稿。退出组织后的备份恢复验收仍需实际组织生命周期支持。
- 使用 `pg_dump` 保存撤回前的测试库，再恢复到独立空库并挂载原删除日志。主动撤回、删除源会话和移入私有项目三条旧链接都返回 404。数据库恢复了移入操作之前的项目关联，日志仍阻断旧公开链接。原本有效的控制链接与接收者的独立副本可正常访问。测试应用日志中未发现完整分享凭据。
- 当时的 Maven `verify` 与共享 SDK 分别通过 38 项和 17 项测试。项目资料检索、附件隔离和退出工作空间随后完成独立联测。 [项目资料](assistant-project-resources.md) · [主动退出](assistant-workspace-departure.md)
- 2026 年 11 月 24 日，分享限制通过真实 API 的普通、工作空间与恢复三组自测。非所有者无法改变限制。开启后两个受众的旧链接都无法读取或复制，所有者可继续聊天、查看撤回状态，接收者可打开此前已保存的副本。解除限制后需重新预览方可发布。PostgreSQL 16.15 恢复到独立空库后，两种限制状态按日志顺序重放，旧链接仍返回 404。原库和恢复库各有 81 个变更集，其中两个用于分享限制。 [普通](verify-results/sharing-restriction-2026-11-24/normal.log) · [工作空间](verify-results/sharing-restriction-2026-11-24/workspace.log) · [恢复](verify-results/sharing-restriction-2026-11-24/restore/summary.json) · [数据库](verify-results/sharing-restriction-2026-11-24/database-audit.log)
- 在开启 ClamAV 和私有 S3 的服务上，对附有合成 PNG 的项目会话执行分享联测。所有者可下载扫描通过的图片，已入组接收者可读取单条回复的文字快照。发布预览和接收响应均返回 `includesAttachments=false`，附件标识未进入快照。接收者访问附件列表、明细和下载授权均得到 404。撤回分享后，接收者的原链接也返回 404。 [附件隔离结果](verify-results/project-share-attachment-boundary-2026-11-24/http.log)
