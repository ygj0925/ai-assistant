# 私有代码稿

在启用私有产物和独立删除日志的消费者后端设置 `assistant.artifacts.code.enabled=true`。能力探测返回 `private_code_drafts`。在本人项目下用 `format: "code"` 和 `code: {language, source}` 创建草稿。修改时提交该结构及当前 `baseVersionId`。 [私有产物](assistant-private-artifacts.md)

| 语言标识 | 附件后缀 |
| --- | --- |
| `plaintext` | `.txt` |
| `javascript` | `.js.txt` |
| `typescript` | `.ts.txt` |
| `python` | `.py.txt` |
| `java` | `.java.txt` |
| `sql` | `.sql.txt` |
| `json` | `.json.txt` |
| `css` | `.css.txt` |

语言标识用于展示和固定下载名称。源码经保存后仍可按原始 UTF-8 字节下载，保留换行、缩进、尾部空格和空源码。源码和包含语言字段、转义开销的标准化版本各有 32 KiB 上限，含较多转义字符时会更早达到版本上限。返回的 `size` 对应标准化版本字节数。

创建和保存追加不可变版本，回滚产生新版本。版本详情和个人数据导出按版本携带 `code`。下载从所选历史版本读取源码和语言，以固定 `artifact-<版本号>` 加对应后缀作为 UTF-8 文本附件，响应禁止缓存并启用 MIME 校验。编辑关闭后，已有代码稿可以继续读取、下载、导出及删除。 [个人数据导出](assistant-privacy-export.md)

## 自测

使用开启私有产物、代码稿、项目发布和独立删除日志的隔离后端。脚本在回环端口注册合成账号，逐字节验证中文、emoji、CRLF、缩进和尾部空格，另检查语言后缀、跨账号、版本冲突、回滚、发布限制和删除。

```powershell
node qa/assistant-code-draft-smoke.mjs http://127.0.0.1:18135
```

传入 `--switch <隔离证据目录>` 还可验证停用后的保留权限。证据目录出现 `code-editing-switch-ready` 后，在同一数据库、Redis 与删除日志上重启原测试包并关闭编辑，再写入 `code-editing-disabled` 标记。脚本继续检查编辑拒绝和现有版本的权限。

MySQL 8.4.11 命名管道隔离库通过增量约束测试。回滚事务中验证源码中文、emoji 和 CRLF 字节一致，且原有会话来源 Markdown 与演示稿仍可写入。代码稿设置来源回复触发约束拒绝。检索目录三条记录保留，事务回滚后无文稿测试数据。

2026 年 11 月 24 日，完整 Maven 验证通过 99 项助手测试。隔离 PostgreSQL 从 119 项增量应用一个变更集，重启后合计 120 项且无需重跑。HTTP 自测逐字节核对 67 字节的中文、emoji、CRLF、缩进与尾部空格，验证三版历史、历史版本各自的固定扩展名、本人可携带及跨账号拒绝。代码稿关闭后，创建、编辑和回滚均返回 403，已保留版本仍可读取、下载、导出和删除。删除后下载返回 404，注销后旧令牌返回 401。

生产构建的 Chrome 自测验收了切换语言、保留 CRLF、文字原样显示、回滚和实际文件下载。 [Chrome 验收日志](verify-results/web-code-artifacts-2026-11-24/browser.log)
