# 项目内网页版本分享

在启用项目协作、产物分享和独立删除日志的后端设置 `assistant.project-webpage-publications.enabled=true`。能力探测返回 `project_webpage_publications`，与私有网页编辑开关独立。项目所有者在 `/collaboration/projects/{projectId}/artifact-publications` 提交 `{artifactId, versionId, confirm:true}`，分享已确认的一个版本。草稿后续的修改及回滚不会替换这个版本。 [私有网页](assistant-webpage.md) · [项目产物分享](assistant-project-artifact-publication.md)

同项目的有效成员可以读取详情中的 `website` 内容和调用对应的 `/preview` 或 `/download`。预览及下载采用同一固定 HTML、用户文字转义、无缓存和沙箱策略。评论沿用现有项目角色规则。参与者离开项目或其授权被撤回时，预览、下载及评论随之失效。

从本人已完成回复生成的网页绑定来源会话。分享后若限制该会话的分享，旧发布失效。解除限制后可由所有者重新确认该版本，形成独立的新发布。擦除来源会话同时撤回该网页及相关发布。关闭项目网页分享会隐藏发布及评论，重新启用可继续读取原有效版本。所有者仍可按原发布标识撤回。

## 自测

隔离测试启用项目协作、私有网页、项目产物分享、项目网页分享、`assistant.project-artifact-comments.enabled=true`、合成模型和独立删除日志。脚本只连接回环，使用现建账号。证据目录出现 `membership-ready.json` 后，测试驱动校验合成账号，为该工作空间增加两条测试成员记录，再写入 `membership-added.json`。项目邀请和接受由普通 API 完成。

```powershell
node qa/assistant-webpage-publication-smoke.mjs http://127.0.0.1:18135 <隔离证据目录> --switch
```

使用 `--switch` 时，`webpage-publication-disable-ready.json` 和 `webpage-publication-enable-ready.json` 分别请求关闭和恢复分享。驱动使用相同的测试数据库、Redis 和独立日志重启同一包，并分别写入 `webpage-publication-disabled.json` 与 `webpage-publication-enabled.json`。

MySQL 8.4.11 命名管道隔离库验证了回复来源网页增量和现有发布外键。事务接受同所有者的网页及精确版本发布，网页删除级联移除发布。跨账号来源返还 1452，设置回复来源的代码稿保持 3819，原三条检索目录记录保留。测试事务已回滚。

2026 年 11 月 24 日，完整 Maven 验证通过 104 项助手测试。隔离 PostgreSQL 从 123 项增量应用三个变更集，合计 126 项。关闭并恢复网页分享的两次重启均执行零项变更。实际 HTTP 验证已分享版本固定、标签样式文字按字面呈现、项目预览与私有预览字节一致、编辑者评论及查看者权限规则、旧 Markdown 兼容与注销清理。

关闭开关后，网页详情、预览、下载和评论按同一权限边界隐藏，项目普通文本仍可分享。恢复开关后，未撤回的网页及其评论重新可读，已由所有者撤回的版本保持失效。实际生成的来源网页在收紧来源会话权限后撤回，解除限制后原发布仍失效，只有重新确认的新发布可读。来源会话删除后，原网页和发布均无法读取。浏览器生产构建验证私有预览和复制、从回复生成及来源删除、查看者预览和下载及撤回。 [浏览器验收日志](verify-results/webpage-sharing-chrome-2026-11-24/browser.log)
