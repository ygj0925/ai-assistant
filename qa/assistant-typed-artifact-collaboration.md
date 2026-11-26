# 完成回复与类型化产物的协作验收

所有者可以从自己的已完成回复创建工作簿、演示文稿、代码稿和图片产物。提交选择的回复、显式确认和经审阅的类型化内容。请求指定的项目须与回复所在项目一致。选择图片时同时要求该项目中已批准的 PNG。未归入项目的回复也支持私有工作簿、演示和代码稿。

项目所有者可以在审核后发布精确历史版本。接受邀请的成员按当前角色阅读和下载，编辑角色可以添加评论。工作簿、演示文稿和代码稿分别导出为 XLSX、PPTX 和带安全后缀的纯文本，图片通过当前授权下载批准的 PNG。类型化响应只携带经批准的业务字段。保存后续私有版本，仍可继续查看已审核的历史版本。

当原回复移出项目时，独立日志使已确认的项目发布失效。移回后，所有者仍可读取自己的文件，可重新关联回复并审批新版本。锁定回复或删除源对话也会阻断读取。恢复旧数据库时重复应用同一日志。

## 本地复跑

准备仅回环可访问的 PostgreSQL、Redis、ClamAV 和私有 S3，使用绑定的独立删除日志。启用私有产物和所需编辑配置、项目协作、评论、原有精确版本发布以及本地合成回复模型。下列默认关闭的开关分别控制新回复来源和各类型发布：

- `assistant.artifacts.reply-typed-enabled`
- `assistant.project-spreadsheet-publications.enabled`
- `assistant.project-slide-publications.enabled`
- `assistant.project-code-publications.enabled`
- `assistant.project-image-publications.enabled`

```powershell
node qa/assistant-webpage-publication-smoke.mjs http://127.0.0.1:18139 $evidenceDirectory --typed
```

在合成隔离库中，从 `membership-ready.json` 读取账号、工作空间和成员标识，添加测试工作空间成员后创建 `membership-added.json`。接下来的项目邀请、确认、发布、移动和撤权由应用完成。工作簿及演示包用 Python 独立读取 XML。

添加 `--typed-restore http://127.0.0.1:18140` 可使用旧库备份验收。收到 `backup-ready.json` 后备份并创建 `backup-done.json`。收到 `cutover-ready.json` 后停止源测试服务，恢复到隔离空库。使用相同日志和测试桶启动新服务并创建 `restore-done.json`。

添加 `--typed-switch` 可验收独立开关。在 `typed-<format>-disable-ready.json` 出现后单独关闭对应发布能力并启动同一服务，健康后创建 `typed-<format>-disabled.json`。按脚本依次验收 `sheet`、`slides` 和 `code`，工作簿阶段同时关闭从已完成回复新建。收到 `typed-publications-enable-ready.json` 后恢复全部开关并创建 `typed-publications-enabled.json`。

## 验收结果

2026 年 11 月 24 日，实际 HTTP 验证四类回复产物的私有归属、审核旧版本、精确下载、同项目与角色检查。独立解析器核对工作簿实际数字、布尔值和文字单元格以及演示内容。代码稿保留 CRLF，PNG 与扫描批准文件逐字节一致。项目往返移动后旧发布不可访问，所有者仍可访问私有产物并重新绑定审批。

真实 PostgreSQL 恢复识别全部 137 个原有变更集，执行 0 个新增变更集。移动、锁定和删除来源后，旧版数据恢复仍拒绝相关发布，无关工作簿继续正常下载。独立 MySQL 8.4.11 命名管道迁移验证四种来源外键和范围。无项目图片、短来源标识和无来源的标识均被 CHECK 拒绝，输错消息的对话范围由外键拦截。

生产 Windows Chrome 验证审核用的私有代码内容、从回复创建、工作簿和演示下载和预览、项目移动撤回及私有版本保留。[Chrome 结果](verify-results/typed-artifact-chrome-2026-11-24/browser.log)

在同一恢复库依次关闭工作簿、演示、代码发布能力时，分别验证该格式的项目内下载和评论关闭，其余格式仍可下载，已保存私有内容正常读取。暂时关闭从回复创建后，项目内直接编辑继续可用。恢复开关后，关闭期间撤回的工作簿仍不可访问。附加测试拒绝用原始用户消息关联产物，保留历史网页、Markdown、审阅和撤权行为。
