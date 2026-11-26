# 私有工作表与 XLSX 导出

在启用私有产物和独立删除日志的消费者后端设置 `assistant.artifacts.spreadsheets.enabled=true`。能力探测返回 `private_spreadsheets`。在本人项目下创建 `format: "sheet"` 的产物，提交 `sheet: {name, rows}`。编辑提交同一结构及当前 `baseVersionId`。列表沿用产物元数据，历史版本和个人数据导出携带有类型的 `sheet`。 [私有产物](assistant-private-artifacts.md) · [个人数据导出](assistant-privacy-export.md)

- 一份工作簿含一张命名工作表。数据是 1 至 64 行、1 至 16 列的矩形网格。单元格支持字符串、数字、布尔值和 `null` 空白，支持全空网格。
- 工作表名称为 1 至 31 个 UTF-16 单元，单元格文本上限为 1,024 个 UTF-16 单元。数字最多 15 位有效数字，绝对值在 `1e-100` 至 `1e100` 之间，允许零。服务在解析请求时使用精确十进制校验。每个版本的标准化 UTF-8 网格最多 32 KiB。
- 保存追加不可变版本，回滚产生新版本。该格式继续使用原项目和工作空间所有者校验、保留数量、独立删除日志和恢复规则。关闭工作表编辑后，仍可读取、下载、导出与删除已保留的工作表。
- 下载响应为固定名 `artifact-<版本号>.xlsx` 的 Office Open XML 附件。Apache POI 由应用现有 BOM 固定为 5.5.1。每个单元格按指定类型生成，`=` 或 `@` 开头的文字仍为字符串。 [Apache POI 工作簿指南](https://poi.apache.org/components/spreadsheet/quick-guide.html)

## 自测

使用启用工作表和项目发布的隔离后端、独立删除日志及 Python 3。脚本使用 Python 标准库核对 HTTP 下载中的 OOXML ZIP、工作表、共享字符串和单元格类型。

```powershell
node qa/assistant-spreadsheet-smoke.mjs http://127.0.0.1:18135 --wsl-python
```

若 Windows 已安装可由 `py -3` 启动的原生 Python，省略 `--wsl-python`。Ubuntu 等使用 `python3` 的环境也省略该参数。

开关自测以 `--switch <隔离证据目录>` 运行。看到 `sheet-editing-switch-ready` 后，停止该测试实例，关闭工作表编辑开关，以同一个数据库、Redis 和独立日志启动同一包，然后在证据目录创建 `sheet-editing-disabled`。脚本继续核验新增、修改和回滚拒绝，旧工作表仍可读取、下载、携带和撤回。

MySQL 8.4.11 命名管道隔离库通过增量约束校验。同一测试事务能保存项目工作表和既有会话来源 Markdown，给工作表伪造回复来源触发 3819。原三条检索目录记录保留，测试事务回滚后无文稿测试数据。

2026 年 11 月 24 日，完整 Maven 验证运行 92 项助手测试并通过，含 Apache POI 实际读回和 13 项个人数据导出测试。隔离 PostgreSQL 新库应用 115 项迁移，两次重启均执行零项变更。实际 HTTP 下载产生 3,474 字节的 XLSX，独立用 Python 3.12 标准库读取 ZIP 和 XML，验证单页名称、文字、数字、布尔值与空白及公式样式字符串的单元格类型。旧 Markdown 创建和编辑保留中文、emoji 和 CRLF。 [生产构建 Chrome 用例](../clients/web/tests/spreadsheets-live.spec.ts)

Chrome 也验证了编辑类型、拒绝超出有效位数、版本回滚与实际 XLSX 下载。HTTP 自测在同一个数据库、Redis 和独立日志上将编辑开关从 `true` 改为 `false`，新增、修改和回滚均返回 403。已有工作表仍可按原类型读取和导出，XLSX 下载通过独立读回，删除后下载返回 404，账号注销后令牌返回 401。
