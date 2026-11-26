# 组织本地模型月度额度

组织指定所有者可读取和确认本地合成模型的月度额度。界面和 API 使用统一的 UTC 自然月，单位为生成答复的 Unicode 码点。额度留空字段须明确提交 JSON `null`，表示无额外的组织上限。零表示拒绝所有新预留。有上限时，单次运行继续使用账户已有的 8,192 单位预留。多个成员共享同一组织额度。取消释放剩余预留，已产生的答复或部分答复按接受的码点结算到发起运行所在的月份。

管理接口为 `GET /api/assistant/v1/organizations/current/model-budget` 和 `PUT /api/assistant/v1/organizations/current/model-budget`。更新必须提供刚查看的 `baseRevision`、明确的 `monthlyLimitUnits` 与 `confirm: true`。服务记录 `model_budget_changed` 审计动作。无权成员无法查看或修改额度。重复提交既有运行沿用原幂等结果，超额请求事务回滚且不产生消息、用量或新水位。

在 `dev` 或 `test` 使用独立的 `assistant.organization-model-budget.enabled` 打开管理入口。配置 `assistant.organization-model-budget.guard-id` 和 `assistant.organization-model-budget.guard-path`。预先建立专用 UTF-8 文件并以 LF 写入首行 `assistant-org-model-budget-v1 <UUID>`，将该文件保存在数据库独立的持久位置。单进程独占写入文件，内容仅包含工作空间 UUID、额度版本、预留水位和校验链。当前数据库账本与独立水位匹配时才允许继续进入已配置组织的模型路径。关闭管理入口后，既有额度和独立水位继续约束运行。

服务使用已有组织锁和 READ COMMITTED 隔离，按当前月查询同一事务中的运行结算账本。有上限时只允许内置合成模型处理受计量的运行。无持久用量账本的临时会话在有限额度下关闭。旧数据库即使保留同一个额度版本，只要缺少后来接受的预留，新的请求和旧的待运行任务都会因水位不匹配被禁止生成。恢复时保留最新独立文件，恢复匹配的账本数据库。缺文件、文件不健康或落盘后数据库提交丢失时，组织路径返回 `ORGANIZATION_BUDGET_RECOVERY_REQUIRED`。

## 复测

```sh
node qa/assistant-organization-model-budget-smoke.mjs http://127.0.0.1:18154 default <新证据目录>
node qa/assistant-organization-model-budget-smoke.mjs http://127.0.0.1:18152 restore <新证据目录> http://127.0.0.1:18153 http://127.0.0.1:18154
```

恢复测试从进程环境读取回环环境的实际平台测试权限。使用独立 PostgreSQL、Redis、隐私日志和预算文件。收到 `snapshot-ready.json` 后保存数据库备份并创建 `snapshot-done.json`。收到 `source-done.json` 后使用同一个最新预算文件启动旧库，再创建 `restore-done.json`。收到 `older-confirmed.json` 后以当前账本重启并创建 `valid-done.json`。管理开关关闭和缺预算文件分别使用 `flagoff-done.json`、`missing-done.json` 标记。

已验证未配置预算文件的个人路径、严格 JSON、零额度、跨成员并发、重复请求、取消释放、实际码点结算和月份边界。[默认关闭](verify-results/organization-model-budget-1795517817047/default-off/summary.json) · [并发与结算](verify-results/organization-model-budget-1795517817047/restore/source-done.json) · [真实待运行备份](verify-results/organization-model-budget-1795517817047/restore/postgres-before.json)

独立 MySQL 8.4 使用两条 READ COMMITTED 真实连接复核同一组织锁。第二个事务在等待组织锁前可见 0 单位，获得锁后读取到先提交的 8,192 单位，第二笔预留未入账。上一月份和其他工作空间的数据不计入该窗口。 [MySQL 结果](verify-results/organization-model-budget-1795517817047/mysql/summary.json)

生产构建 Chrome 通过所有者管理、普通成员隐藏、明确零额度确认、拒绝过期版本、拒绝未计量的临时对话及明确解除额度。源 API 的两个独立成员只抢到一个剩余预留，同一请求键复用保持单次预留，取消释放后另一个成员成功运行并结算 14 个码点。 [Chrome 结果](verify-results/organization-model-budget-chrome-2026-11-24/browser.log)

PostgreSQL 使用 172 个变更集。旧库既有额度版本与当前库一致，独立预留水位已经更晚。旧库的组织读取、再次预留和临时生成均返回 503。旧库中一个真正排队的运行进入失败状态，输出和新增结算为零。独立的个人临时路径仍可用。 [新旧水位比较](verify-results/organization-model-budget-1795517817047/restore/postgres-older.json) · [旧队列验收](verify-results/organization-model-budget-1795517817047/restore/postgres-older-after.json)

使用对应的当前数据库重启后恢复原额度和 14 个已结算码点。管理入口关闭时，两个成员仍只能取得一个剩余预留。配置指向缺失的水位文件时，组织读取和生成失败，个人生成保持可用。 [匹配账本重启](verify-results/organization-model-budget-1795517817047/restore/valid-confirmed.json) · [管理开关关闭](verify-results/organization-model-budget-1795517817047/restore/flagoff-confirmed.json) · [完整 API 结果](verify-results/organization-model-budget-1795517817047/restore/summary.json)

本次验收限于本地模型码点额度。正式供应商计量、资金结算、多实例账本、驻留和生产保留策略仍待验收。
