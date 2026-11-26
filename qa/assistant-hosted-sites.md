# 站点公开托管验收

个人工作空间的项目所有者可以审核一个已保存的静态网页版本。审核界面显示固定沙箱预览，并绑定精确字节的 SHA-256。确认后，指定托管主机为匿名访问者提供同一份 HTML。现有项目成员分享沿用原来的独立授权。

新草案与私有版本保存后，公开站点继续提供原先确认的版本。更新和回退由所有者明确选择版本、确认预览并提交当前发布代际。两次变更使用同一基线时，只有当前请求能够生效。撤回退役精确代际和地址，项目私有版本保留。备份恢复后使用同一独立日志。数据库回到更新之前时，已退役的旧发布代际保持不可访问。

公网配置需要专用 HTTPS 域名，入口只转发 `/assistant-sites/`，保留目标主机且关闭缓存。该域名不接收产品会话 Cookie，也不转发产品 API。仅在回环测试可启用 `http://localhost`，环境通过 `assistant.artifacts.hosting.enabled` 和 `assistant.artifacts.hosting.origin` 启用。服务返回 `Cache-Control: no-store, no-transform`、`Referrer-Policy: no-referrer` 和拒绝脚本及嵌套的 CSP，固定模板将作者文字按字面转义。已加载的浏览器页面或用户主动保存的副本由访问者持有。 [HTTP 缓存](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2.5) · [CSP 沙箱](https://www.w3.org/TR/CSP/#directive-sandbox) · [回环域名](https://www.rfc-editor.org/rfc/rfc6761.html#section-6.3)

## 本地自测

在两个独立回环 PostgreSQL 实例上启用私有产物、网页与托管，并绑定同一份测试删除日志。只在合成账号中创建和公开测试内容。

```powershell
node qa/assistant-hosted-site-smoke.mjs http://127.0.0.1:18143 enabled
node qa/assistant-hosted-site-smoke.mjs http://127.0.0.1:18143 restore $evidenceDirectory http://127.0.0.1:18144
node qa/assistant-hosted-site-smoke.mjs http://127.0.0.1:18144 disabled
```

收到 `backup-ready` 后备份并创建 `backup-done`。收到 `restore-ready` 后关闭源实例，在独立空库恢复快照，带相同日志启动后创建 `restore-done`。关闭用例保留私有网页与发布表，单独关闭托管。Chrome 用例需要 `ASSISTANT_WEB_TEST_HOSTED_SITE=true` 和生产构建。

## 实测

2026 年 11 月 24 日，实际 HTTP 验证外部账号不能预览、写入或撤回他人的网页，首次发布和跨版本更新需明确确认与匹配摘要，旧基线的更新或撤回返回 409。匿名访问的 HTML 和私有预览逐字节相符。错误主机拒绝访问，`HEAD` 无响应内容，过时的条件请求无法取到缓存正文。更新及明确回退后，同一地址返回当次确认版本。 [HTTP 结果](verify-results/hosted-site-2026-11-24/api-fixed.log)

PostgreSQL 16 从含 150 个变更集的基线增量至 156，实际旧快照恢复为 156 个既有变更集、0 个新增。撤回的地址继续拒绝，项目私有版本和同库未撤回站点保持可读。MySQL 8.4 的命名管道实例验证了作用域、精确版本外键、摘要长度、级联删除和日志类别。 [恢复结果](verify-results/hosted-site-2026-11-24/restore/summary.json) · [迁移计数](verify-results/hosted-site-2026-11-24/restore/liquibase.log) · [MySQL](verify-results/hosted-site-2026-11-24/mysql-proof.log)

生产 Web 的 Chrome 用例通过确认前零发布、匿名上下文正文和无第三方请求、同一地址更新与回退、撤回后重新加载的 404 页面。关闭托管重新启动后，已保留的未撤回地址也显示不可用，私有草案仍可预览。 [Chrome](verify-results/hosted-site-2026-11-24/browser-fixed.log) · [开关关闭](verify-results/hosted-site-2026-11-24/disabled.log) · [既有地址关闭](verify-results/hosted-site-2026-11-24/disabled-existing.log)
