# 合成商品目录验收

合成目录向已登录用户展示预先批准的样例商品，可查询、分页并选择两到四项比较。价格依据已保存的最小币种单位、精度和币种生成，观察时间与同一数据行的商家来源对应。来源入口会复核当前观测标识。商品下架、最近价格过期或来源不符合允许地址时，旧价格和链接不再提供。

测试实例以 `assistant.commerce.synthetic-catalogue.enabled=true` 显式启用，并配置精确的保留样例商家主机。模块以开发或测试配置运行，从已批准的目录数据读取，来源 URL 仅作为观测记录。测试请求全部发往回环应用，样例商家 URL 只核对格式及标识。

## 本地复测

在独立的已迁移 PostgreSQL 数据库载入 [初始观测](fixtures/synthetic-catalogue-initial.pg.sql)，启动回环实例后运行：

```powershell
node qa/assistant-synthetic-catalogue-smoke.mjs http://127.0.0.1:18141 enabled <新证据目录>
```

出现 `catalogue-ready.json` 后，通过同一独立数据库追加 [调价和下架观测](fixtures/synthetic-catalogue-revise.pg.sql)，保存其数据库审计结果，并写入 `catalogue-updated.json`。脚本继续验证调价、下架、返回的来源标识、历史价格缺失和比较结果。独立关闭开关后的复测使用：

```powershell
node qa/assistant-synthetic-catalogue-smoke.mjs http://127.0.0.1:18142 disabled
```

## 实测结果

- PostgreSQL 16 精确包验证身份隔离、全角字符与文字通配符查询、稳定分页、人民币与日元报价、来源时点、已过期和不可验证来源的隐藏及独立关闭开关。调价和下架追加两条记录，数据库共保留八条观测和原来两种价格；旧来源标识返回 `409`，对比仅显示新报价或已下架状态。[HTTP 结果](verify-results/synthetic-catalogue-1795507474824/observations/summary.json) · [PostgreSQL 记录](verify-results/synthetic-catalogue-1795507474824/observations/postgresql-audit.json) · [关闭结果](verify-results/synthetic-catalogue-1795507474824/disabled.json)
- MySQL 8.4 新隔离模式应用两条变更，验证相同观测时间拒绝、价格约束与来源商品外键，并核对下架后的当前视图以及保留的原报价。[MySQL 结果](verify-results/synthetic-catalogue-1795507474824/mysql-migration.json)
- Chrome 生产构建验证按选择顺序比较不同币种的精确价格、来源先核对再显示、样例 URL 的安全属性及全角搜索。Playwright 1 项通过。[浏览器结果](verify-results/synthetic-catalogue-chrome-2026-11-24/browser.log)
