# 明确选择的历史引用验收

用户可在自己的个人工作空间中打开历史引用设置，再为普通对话中的单次发送选择另一条尚未放入项目的自有对话里的一个已完成助手回复。服务最多将该回复开头的 256 个 Unicode 码点交给回环测试所启用的本地模拟模型。目标对话的上下文预算同时预留这段文本及一条输入位置。页面通过独立授权接口显示实际使用的来源。回执只含当前有权读取的来源 ID。

普通发送继续遵循所选分支的原有上下文。项目、工作空间成员共享、定制助手、临时对话及远程模型不参与此路径。关闭历史引用、锁定当前来源或将相关会话移入项目会撤回已有来源绑定的后续访问，未发布的结果会取消。重新打开设置、解锁或将会话移回个人目录后，需要重新明确选择。已经送达的生成内容及独立授权副本保留。模拟模型的输出不包含选择的历史正文，已交付答案不包含来源标题或 ID。

使用专用回环测试实例和合成内容。正向实例启用消费者注册、本地模拟模型、个人记忆、对话阅读锁及历史引用，并绑定独立隐私日志。普通测试设置 `assistant.models.mock-delay-millis=15`。恢复测试使用 `90`，给数据库快照留出时间。关闭模式保留相同的测试依赖，单独关闭 `assistant.history-references.enabled`。

```powershell
node qa/assistant-explicit-history-smoke.mjs http://127.0.0.1:18133 enabled
node qa/assistant-explicit-history-smoke.mjs http://127.0.0.1:18133 disabled
node qa/assistant-explicit-history-smoke.mjs http://127.0.0.1:18133 restore <新证据目录> http://127.0.0.1:18134
```

恢复测试在检测到 `snapshot-ready.json` 时立即备份指定的合成 PostgreSQL 数据库。写入 `snapshot-done.json` 后，脚本执行往返移动和关闭历史引用。待出现 `revoke-ready.json`，先停止源端，再将备份恢复到空目标数据库并保留同一独立日志启动。日志重放完成后写入 `database-switched.json`，脚本在目标实例验证旧来源回执、恢复出的在途执行和新的明确选择。

## 实测结果

- PostgreSQL 16 和 Redis 的精确应用包通过 132 条 Liquibase 变更，其中 3 条属于历史引用。HTTP 验证单次明确选择、256 码点限额、来源回执隔离、自有项目与外部账户拒绝、旧回复删除、关闭后重新打开仍拒绝在途引用，以及取消时零输出片段。[开启结果](verify-results/explicit-history-1795503292998/enabled.json) · [独立关闭结果](verify-results/explicit-history-1795503292998/disabled.json)
- 恢复前数据库保有一条仍在生成的引用和有效开关。使用同一独立日志恢复后，旧执行取消且结算一次，来源往返移动使旧回执继续不可用，已交付内容可以继续读取，新的明确选择可以生成。[快照状态](verify-results/explicit-history-1795503292998/restore/before-replay.json) · [重放后数据库](verify-results/explicit-history-1795503292998/restore/after-replay.json) · [恢复 HTTP 验收](verify-results/explicit-history-1795503292998/restore/summary.json)
- MySQL 8.4 迁移保留原有合成检索目录，实测同作用域来源绑定、跨账号外键、自引用和无效授权代数约束，以及删除后只保留已使用标记。[MySQL 结果](verify-results/explicit-history-1795503292998/mysql-migration.json)
- Chrome 生产构建验证单次选择来源、发送及授权回执，并验证来源加锁后撤回回执。Playwright 1 项通过。[浏览器结果](verify-results/explicit-history-chrome-2026-11-24/browser.log)
