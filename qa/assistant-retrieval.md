# 来源检索验收

开启 `--assistant.retrieval.enabled=true` 后，Web 侧栏可以检索部署者收录的资料。输入经 Unicode 规范化，检索最多读取 1,024 条已审核来源的索引，输出最多 6 条引用。查询内容在内存中处理。结果保存供同一账号和工作空间重新读取，包含来源标题、链接、取得时间和逐条引用关系。

来源可用时显示其证据摘录和所支持的说明。重新读取时核对原来源的版本、有效期与可用状态。部分失效时仍显示有依据的说明。全部失效或没有匹配时显示无可用来源，保留能辨认失效状态的来源元数据。注销账号后清除其结果及引用。

## 自测

对专用 PostgreSQL 测试库执行 [合成来源 SQL](assistant-retrieval-fixture.sql)，启动回环服务，启用检索和合成注册。下面的基本用例核对匹配、无来源和跨账号拒绝，关闭能力用例使用另一套回环服务。

```powershell
node qa/assistant-retrieval-smoke.mjs http://127.0.0.1:18094
node qa/assistant-retrieval-smoke.mjs http://127.0.0.1:18095 --disabled
```

过期、撤回与注销验收额外接受证据目录并使用绑定的[独立删除日志](assistant-erasure.md)。只在合成测试库中按脚本标记改变测试来源。`expire-ready.json` 后使甲过期并写 `one-expired.json`。`partial-checked.json` 后删除乙并写 `all-unavailable.json`。读取 `check-erasure.json` 以确认已注销账号的结果和引用行均已清除。

2026 年 11 月 24 日，在打包版 Java 服务和实际 PostgreSQL 上通过匹配、链接与主张对应、过期、部分失效、全部失效、工作空间和账号权限、注销物理清理和功能关闭测试。Web 生产版 Chrome 通过引用显示、重新核对及无结果验收。PostgreSQL 迁移 `1 → 68 → 68`，MySQL 核对来源删除后的空引用和结果级联删除。

当前来源由部署者审核与收录。实际联网搜索服务的账号授权、目标区域、来源质量和访问失败回退仍需在选定供应商环境联调。 [外部条件](m0-live-readiness.md)
