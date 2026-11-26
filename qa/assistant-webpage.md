# 私有静态网页草稿

在启用私有产物和独立删除日志的消费者后端设置 `assistant.artifacts.webpages.enabled=true`。能力探测返回 `private_webpages`。在本人项目下创建 `format: "webpage"` 的产物，提交 `website: {heading, introduction, sections: [{title, paragraphs}]}`。编辑时提交该结构和当前 `baseVersionId`。 [私有产物](assistant-private-artifacts.md)

- 主标题为 1 至 80 个 UTF-16 单元，导语最多 320 个。正文有 1 至 6 个区块，每个区块的标题为 1 至 60 个单元，含 1 至 4 段每段最多 400 个单元的文字。导语可留空，标题和正文必须含有效文字。标准化版本上限 32 KiB。
- 新保存和回滚均追加不可变版本。本人版本详情与个人数据导出保留原有结构和文字。关闭编辑后，原草稿仍可读取、预览、下载、导出及删除。 [个人数据导出](assistant-privacy-export.md)
- 预览和下载均重新校验账号、工作空间、项目与来源。预览为 `GET /artifacts/{artifactId}/versions/{versionId}/preview`，下载沿用对应的 `/download` 并以 `artifact-<版本号>.html` 返回。两者均以 UTF-8 渲染同一 HTML，响应禁止缓存并启用 MIME 校验。
- HTML 来自固定模板。标签样式与网址样式的用户文字在页面中按字面显示。HTTP 策略启用沙箱并锁定外部加载，仅允许匹配 SHA-256 的固定内联样式。下载文件自身携带资源限制策略。 [W3C 内容安全策略](https://www.w3.org/TR/CSP3/)

在已完成的本人回复上可生成结构化网页，并继承来源会话及其项目权限。封存的某个版本可由项目所有者单独确认分享，功能开关和权限规则见分享验收。 [项目内网页版本分享](assistant-webpage-publication.md)

## 自测

使用开启测试注册、私有产物、网页编辑、项目发布和独立删除日志的隔离后端。执行前安装项目现有 Web 测试依赖，并确保本机 Chrome 可用。脚本只访问回环端口，从实际保护响应载入 Chrome，并检查解析结果、样式、请求计数和权限。

```powershell
node qa/assistant-webpage-smoke.mjs http://127.0.0.1:18135
```

传入 `--switch <隔离证据目录>` 后，脚本会等待编辑开关实测。证据目录出现 `webpage-editing-switch-ready` 后，在同一数据库、Redis 和独立日志下关闭网页编辑并重启原测试包。启动成功后创建 `webpage-editing-disabled` 标记。

MySQL 8.4.11 命名管道隔离库通过增量验证。首次上线项目网页格式时，项目网页保留中文和 emoji 字节，代码和回复派生 Markdown 仍有效。后续迁移验证网页的新回复关联、其他所有者的非法关联拒绝、发布引用级联以及旧代码格式约束。原三条检索目录记录保留，测试事务已回滚。

2026 年 11 月 24 日，完整 Maven 验证通过 103 项助手测试。隔离 PostgreSQL 从 120 个变更集增量应用三个，合计 123 个，同库重启执行零个。HTTP 验证三版历史、跨账号和跨工作空间拒绝、无缓存响应及独立删除。预览与下载为相同的 1,468 字节 UTF-8，独立重算的样式哈希与响应一致。Chrome 解析只产生导航请求，标签与网址样式文字按字面呈现，固定样式实际生效。

生产 Web 在不透明来源的沙箱预览中通过样式、字面内容和零资源请求检查，实际下载 HTML，并由旧版本创建独立副本。关闭网页编辑的 HTTP 回归中，创建、修改和回滚返回 403，原版本仍可读取、预览、下载、携带和删除。删除后预览及下载返回 404。 [浏览器验收日志](verify-results/webpage-production-2026-11-24/browser.log)

## 从完成回复生成

已完成的助理回复可生成静态网页草案。用户选择该回复并填写文稿标题。服务按 UTF-16 边界分段，拒绝超过模板容量的正文，保留来源对话和消息标识。网页内容及下载仍受来源权限约束，删除原对话会使已生成的网页、原预览、下载和幂等重试失效。项目内直接编写的网页可以从历史版本复制为独立草案。回复派生稿保留来源关联，可以编辑并追加版本。

Chrome 联测验证从模拟模型已完成的回复生成、静态 HTML 预览、相同请求重试、旧键冲突，以及删除来源后拒绝读取和下载。协作者只获得明确获准发布的版本。 [Chrome 浏览器结果](verify-results/webpage-sharing-chrome-2026-11-24/browser.log) · [工作空间内发布](assistant-webpage-publication.md)
