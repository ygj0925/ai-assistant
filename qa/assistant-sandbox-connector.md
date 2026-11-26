# 本地连接器审批与未知结果验收

消费者先明确授权模拟连接器，再选择固定动作及回执场景。服务器显示不可变的审批修订号，收到对应修订的明确确认后才允许后台调度。动作仅在独立、绑定身份的本地文件中记录一个合成回执，回执包含操作标识和时间。应用按工作空间成员代数、授权代数和动作 ID 复核权限，限制未决动作数量。

后台调度先持久记录派发保护。回执在传回前丢失时，界面保留待核实状态。用户可再次查询原操作的独立记录，确证后得到同一个最终回执。尚未派发的动作可以撤销。撤回授权或退出工作空间会阻止相关旧动作，重新加入需要新的授权。已派发动作的状态仍按原工作空间代数校验。

运行时仅在回环的开发或测试环境显式启用 `assistant.sandbox-connector.enabled`。环境分别提供预置隐私日志和模拟回执文件及绑定 ID。本地模拟与实际外部服务的 OAuth、事件签名和查证权限分别验收。

```powershell
node qa/assistant-sandbox-connector-smoke.mjs http://127.0.0.1:18141 enabled
node qa/assistant-sandbox-connector-smoke.mjs http://127.0.0.1:18141 workspace <新证据目录>
node qa/assistant-sandbox-connector-smoke.mjs http://127.0.0.1:18141 restore <新证据目录> http://127.0.0.1:18142
node qa/assistant-sandbox-connector-smoke.mjs http://127.0.0.1:18142 disabled
```

恢复测试根据 `snapshot-ready.json` 备份合成 PostgreSQL 数据库，然后让脚本完成派发、撤回授权和取消。目标用旧数据库、原隐私日志与同一独立回执文件启动。驱动记录重放前后的数据库及合成回执数量，脚本向恢复实例查证。工作空间测试驱动仅为合成账号安排新的成员代数，退出、授权、审批和查证均走真实应用接口。

## 实测结果

- PostgreSQL 16 和 Redis 的精确应用包应用了 136 条 Liquibase 变更，其中 3 条为本地模拟连接器。真实 HTTP 验证精确确认、跨账号隔离、待核实后只聚合出一个结果、撤权和幂等、工作空间退出与重新加入、未决预算、账号擦除、分页及关闭开关。[启用结果](verify-results/sandbox-connector-1795504971068/enabled.json) · [工作空间验证](verify-results/sandbox-connector-1795504971068/workspace/summary.json) · [关闭结果](verify-results/sandbox-connector-1795504971068/disabled.json)
- 旧备份恢复前动作均未获批，恢复后失去回执的动作处于待核实，授权、取消与阻断继续生效。备份后才创建的动作在恢复库中无记录，以同一幂等键请求也会被拒绝。独立回执文件在再次查证前后计数相同，两个实际派发的合成动作分别只写一次，阻断、取消与退出后的旧授权均为零。[数据库前态](verify-results/sandbox-connector-1795504971068/restore/before-replay.json) · [日志重放](verify-results/sandbox-connector-1795504971068/restore/after-replay.json) · [恢复 HTTP](verify-results/sandbox-connector-1795504971068/restore/summary.json) · [独立回执计数](verify-results/sandbox-connector-1795504971068/restore/ledger-after-reconcile.json)
- MySQL 8.4 新隔离模式验证了工作空间成员代数、跨作用域外键、状态所需的派发与回执、三类持久日志标记及级联擦除。[MySQL 验收](verify-results/sandbox-connector-1795504971068/mysql-migration.json)
- 生产 Web 构建的 Chrome 验收验证单独授权、创建和审批，关闭界面后重新打开仍显示待核实，主动查询取得原回执，撤回后阻止待审批动作。Playwright 1 项通过。[浏览器结果](verify-results/sandbox-connector-chrome-2026-11-24/browser.log)
