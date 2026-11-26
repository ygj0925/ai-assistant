# 私有图片产物验收

项目所有者可以从同一项目中已经经过隔离扫描和 PNG 验证的附件创建图片产物。每个产物最多保留 32 个不可变版本，计入工作空间 64 项私有产物配额。每个版本选择一张附件并保存标题和 160 个 UTF-16 代码单元以内的替代文本。保存和回滚均检查当前版本标识。回滚会追加新版本，原先的版本和图片仍按当前权限访问。

每个版本通过数据库外键锁定附件所属的账号、工作空间和项目。图片对象继续由附件服务保存一份。版本下载以经过认证的 POST 申请 60 秒内一次有效的授权，随后在同一设备会话中使用 `X-Attachment-Grant` 取回经批准的 PNG。原附件授权、其他版本授权及其他设备会话均无法在该路径兑换。响应设置固定 `image.png` 文件名、精确内容长度、`Cache-Control: no-store` 和 `X-Content-Type-Options: nosniff`。账号数据导出仅含当前有效的图片引用和描述。

撤回附件后，关联版本从详情、历史和账号导出中移除，既有下载授权同步失效。目录最多保留该项目所有者可见的修复项，显示固定名称、零大小和用于同步的版本标识。所有者仍可选择另一个已批准附件、恢复仍有效的历史版本，或删除产物。删除产物会删去版本引用并保留其原始项目附件。独立日志约束旧数据库恢复后的访问。[附件扫描和撤回](assistant-png-attachments.md)

## 本地复跑

使用隔离 PostgreSQL、Redis、已绑定的独立日志及仅回环可访问的 ClamAV 和私有 S3，启用 `assistant.artifacts.enabled`、`assistant.artifacts.images.enabled` 和现有附件功能。上传和账号只使用合成测试数据。

```powershell
node qa/assistant-image-artifacts-smoke.mjs http://127.0.0.1:18139 --object-root $privateTestBucketPath
```

添加 `--toggle $evidenceDirectory` 可在创建 `image-ready.json` 后重新启动同一服务。关闭 `assistant.artifacts.images.enabled` 后创建 `disabled-ready`。脚本确认创建、保存和恢复停止，已有资料继续读取、下载和删除。

添加 `--replay $evidenceDirectory http://127.0.0.1:18140` 可验证恢复。等待 `backup-ready.json`，备份验收数据库并创建 `backup-done`。等待 `deletion-ready`，停止源验收服务，将备份恢复到独立空库，再使用同一绑定日志和测试桶启动恢复服务。恢复服务就绪后创建 `restore-done`。脚本验证旧版本与旧授权无法访问，另一张批准的图片仍能通过私有授权完整下载。

## 已验证

2026 年 11 月 24 日，独立 MySQL 8.4 命名管道实例执行三个增量变更集。事务内验证精确版本绑定、跨项目和伪造版本外键拒绝、原有授权用途默认值、删除产物后清理引用、原附件保留以及原有检索目录的三条记录。

同日使用打包的 Java 服务、PostgreSQL、Redis、ClamAV 和私有 rclone S3 通过正常、恢复和关闭编辑三轮 HTTP 验收。两份独立 PNG 分别通过实际扫描，五个版本仅引用这两份对象。下载的 70 字节与批准文件逐字节一致。跨项目、跨账号、跨会话、跨版本和重复兑换均被拒绝。撤回后对象实际删除，旧目录只显示可修复项，数据导出保留另一张仍获授权的历史图片。真正恢复到撤回前的 PostgreSQL 备份后，Liquibase 识别全部 129 个已有变更集，新增执行 0 个。同一独立日志继续阻断旧附件和授权，另一张图片仍可下载并用于恢复。关闭编辑后创建、修订和恢复返回 403，问题处理所需的读取、下载及删除仍通过。

发布构建的 Windows Chrome 用例通过从已批准附件建立版本、字节一致下载、撤回后收起私有元数据与阻断旧版本下载，以及使用另一份批准附件修复。服务测试还验证了旧版原附件授权与新版产物授权的摘要隔离，以及数据导出过程中收到源附件撤回时拒绝整页。[Chrome 测试日志](verify-results/image-assets-chrome-2026-11-24/browser.log)

## 项目内审核发布

所有者可审核并显式确认发布一条精确的图片版本。已接受邀请的项目成员按当前角色访问审核后的标题、描述、长度和尺寸。查看者可以读取评论，编辑者可以添加评论。保护下载授权同时绑定发布版本、当前成员授权和设备会话。同一设备撤权并重新加入项目后，需要申请当前角色下的新授权。每次读取都会检查该版本对应的原附件批准状态。

启用 `assistant.project-collaboration.enabled`、`assistant.project-artifact-publications.enabled`、`assistant.project-artifact-comments.enabled` 及默认关闭的 `assistant.project-image-publications.enabled`，准备隔离测试桶和扫描服务。先在回环验收环境内运行：

```powershell
node qa/assistant-image-artifacts-smoke.mjs http://127.0.0.1:18139 --object-root $privateTestBucketPath --publication $evidenceDirectory
```

读到 `membership-ready.json` 后，仅为其中合成验收账号添加目标测试工作空间成员关系，然后创建 `membership-added.json`。脚本随后通过真实邀请、接受和撤回 API 验证项目角色。

添加 `--publication-restore http://127.0.0.1:18140` 重复执行事前备份、源服务撤回、独立空库恢复和同一日志重放。备份与恢复的标记为 `backup-ready.json`、`backup-done`、`deletion-ready` 和 `restore-done`。

添加 `--publication-toggle` 验证灰度开关。收到 `publication-disable-ready.json` 后关闭图片发布并重启，健康后创建 `publication-disabled.json`。收到 `publication-enable-ready.json` 后恢复开关，健康后创建 `publication-enabled.json`。角色在功能关闭时无法查看图片、申请下载或加载图片评论，所有者仍可撤回既有发布。原始私有附件和已发布 Markdown 继续各按其原有授权访问。

2026 年 11 月 24 日通过生产 Chrome、实际 PostgreSQL 备份恢复和图片发布停用复测。Chrome 验证以旧版本预览并审核发布，项目成员收到有限元数据和逐字节对应的 70 字节 PNG，撤权后自动收起预览，重新下载返回 404。HTTP 验证相同附件的不同发布版本、私有原附件授权和私有产物授权各自隔离，同一会话重新接受邀请后旧授权仍失效。真实恢复识别原有 133 个变更集并执行 0 个新增变更集，分别撤回的发布和源附件继续被阻断，仍获批准的另一张图片和原 Markdown 正常下载。发布开关关闭并复开后，期间被撤回的版本保持失效。[Chrome 测试日志](verify-results/image-publications-chrome-2026-11-24/browser.log)
