# 项目记忆来源验收

在获准的本地模拟模型生成完成时，服务只记录本次实际选取的项目记忆标识和授权代数。每条回复最多保留三项，同一事务写入回复与来源回执。可读取的来源从当前项目记忆读取最多 120 个 Unicode 码点。个人记忆、其他项目、远程模型和未完成回复沿用各自的权限。回执不保存原文。

来源查看需要对话及工作空间的现行权限。删除或修改记忆、关闭后再次开启、迁移后移回、或阅读锁重新打开时，旧回执对应的条目只显示不可用。删除单项时，其他仍获准的来源可继续查看。已经送达的回复按其本身的授权保留。移走正生成的对话会使尚未交付的旧项目上下文失效。Chrome 和 Android 在已打开来源视图时定期核对权限，失去权限后清除记录。

## 复跑

在回环测试 API 开启账号注册、合成本地模型、个人及项目记忆、记忆生成上下文、阅读锁与独立撤权日志。开启 `assistant.memory.source-receipts-enabled`；恢复演练使用 `assistant.models.mock-delay-millis=90`。

```powershell
node qa/assistant-project-memory-sources-smoke.mjs http://127.0.0.1:18133 normal
node qa/assistant-project-memory-sources-smoke.mjs http://127.0.0.1:18133 restore $evidenceDirectory http://127.0.0.1:18134
node qa/assistant-project-memory-sources-smoke.mjs http://127.0.0.1:18134 disabled
```

恢复模式在 `backup-ready.json` 后备份测试 PostgreSQL，再创建 `backup-done.json`。见到 `restore-ready.json` 后，停止源实例，将快照恢复进独立空库。沿用同一绑定日志启动恢复服务并创建 `restore-done.json`。关闭模式保持普通合成生成及记忆配置可用，并关闭来源回执开关。

## 已验证

2026 年 11 月 24 日，从撤权前备份恢复 PostgreSQL。真实读取验证只保留确实使用且当前获准的条目，撤销的源标识不在响应中，迁移后移回、重新同意和解锁都未恢复旧回执。执行中的项目迁移清除了尚未交付的回复。恢复服务识别 133 个变更集，新增执行 0 个，数据库记录的撤回引用置空。关闭模式保持普通生成可用。 [恢复 HTTP](verify-results/project-memory-sources-2026-11-24/restore/summary.json) · [数据库](verify-results/project-memory-sources-2026-11-24/restore/postgresql-proof.json) · [关闭模式](verify-results/project-memory-sources-2026-11-24/disabled.log)

Chrome 生产构建验证两个相互隔离的项目、双账号拒绝、合法条目展示与单条撤权。Android API 36 从 132 个变更集升级到 133 个，在同一撤权日志下保留已撤销的历史引用，并通过原生项目记忆查看、撤回后的正文清除和已送达回复保留。 [Chrome](verify-results/project-memory-sources-2026-11-24/browser.log) · [Android](../clients/mobile/.expo/explicit-history-2026-11-24/android-results.json)

同日 MySQL 8.4.11 隔离命名管道应用新增表及索引。跨项目所有者、跨运行所有者、非法来源位置和代数均由实际约束拦截，删除运行会级联清除来源引用，原审核目录保持 3 项。 [MySQL](verify-results/project-memory-mysql-2026-11-24/native.log)
