# 组织单点登录的本地只读试点

组织所有者先确认普通成员的当前入组代际和目录用户标识。成员用现有青屿账号及当前密码发起关联，然后在固定 Keycloak 入口证明同一个目录身份。关联后从试点登录可读取该组织摘要和本人未归档的会话目录与元数据。普通密码入口继续处理个人空间和其他组织。试点保持默认关闭。[组织目录停用](assistant-organization-directory.md)

## 入口与授权

- 认证使用 S256 PKCE、一次性状态和 nonce。后端固定发行机构、公钥、授权端点、令牌端点、客户标识和回调地址。回调同时确认发行机构与发起浏览器。流程保留五分钟并绑定运行进程，每次完成前原子消耗。旧回调在重启后需要重新发起。[OpenID Connect Core](https://openid.net/specs/openid-connect-core-1_0.html#CodeFlowAuth) · [OAuth 安全最佳实践](https://www.rfc-editor.org/rfc/rfc9700.html) · [PKCE](https://www.rfc-editor.org/rfc/rfc7636.html)
- 目录绑定和成员同意均保存所审查发行机构的 SHA-256 指纹。归属依据固定发行机构的已验证 `sub` 与明确的绑定。已有目录绑定缺少指纹时，需要所有者重新确认同一绑定。固定到其他发行机构的记录保持隔离。
- 浏览器回调交给同源服务，服务端代为交换授权码。试点凭据由独立 HttpOnly Cookie 保存。后端专用会话有效期十分钟，凭据以摘要存储。每次读取重新核查成员代际、关联状态、发行机构与注销。普通消费者与 ContiNew 后台分别使用自己的认证入口。
- 个人当前密码可撤回自己的关联。注销撤回一条专用会话，解除关联撤回其所有专用会话。目录停用与账号删除撤回相应访问。明确解除关联会推进独立权限日志代际，并使此前发起的关联回调失效。登录只能使用发起时已有的有效关联。
- 关闭试点后，发起和读取受到阻断。已签发会话仍可注销，当前参与者仍可用本地密码解除关联。两项操作要求固定工作空间和独立权限日志可用。恢复或重新启用继续应用已记录的撤回。

## 本地配置

为已配目录的隔离组织启用 `assistant.organization-sso.enabled`。部署配置固定 `issuer`、`authorization-endpoint`、`token-endpoint`、`redirect-uri`、`client-id`、`client-secret`、`key-id` 与 `public-key`。公钥是指定 JWKS 对应的 RSA X.509 SubjectPublicKeyInfo，按 Base64 编码。回调固定为同源 `/organization-sso/callback`。本地回环 HTTP 需要显式 `allow-loopback-http`，其它环境使用 HTTPS。该试点按单进程部署验证。公钥轮换、正式企业目录供应商、原生端 SSO 和组织计费仍需各自验收。

Web 使用 `ASSISTANT_API_ORIGIN` 连接后端，用 `ASSISTANT_WEB_SSO_ORIGIN` 固定浏览器入口。 `ASSISTANT_WEB_SSO_ISSUER` 与 `ASSISTANT_WEB_SSO_AUTHORIZATION_URL` 对应后端的签发方和授权端点。提供方客户端密钥只配置在后端。回调随后跳转至干净的应用地址，入口和页面设置禁止缓存和来源头传递的策略。

## 自测

本地官方镜像 Keycloak 26.8.2 提供真实浏览器登录表单及签名令牌，核对精确回调、授权码与 PKCE。MySQL 8.4 命名管道验证四项追加迁移及权限日志种类，覆盖旧目录行保留、范围外键、会话时限和级联删除。[Keycloak 版本](https://www.keycloak.org/2026/11/keycloak-2682-released) · [签名与 PKCE](verify-results/organization-sso-2026-11-24/idp-browser-code.log) · [MySQL 验证](verify-results/organization-sso-2026-11-24/mysql.log)

2026 年 11 月 24 日，生产 Web 在真实 Chrome 与本地 Keycloak 中通过普通密码登录、成员主动关联、单点登录、组织内会话读取、独立注销及解除关联。验证本地密码会话没有被单点会话覆盖，其他成员及个人空间的会话目录未显示。[浏览器验收](verify-results/organization-sso-2026-11-24/browser-final.log)

隔离 PostgreSQL 中模拟已有目录记录固定到另一发行机构，实际签名目录凭据无法查询、筛选或停用该记录，当前所有者也不能覆盖已有的不同指纹。旧无指纹记录只在同一所有者重新确认后恢复原标识下的目录操作。原有成员关系仍有效。[发行机构隔离](verify-results/organization-sso-2026-11-24/issuer-boundary.log)

PostgreSQL 从基线 177 项追加 OCR 与单点登录的 5 项变更集。撤回前的独立备份保有一条同意和两条试点会话。恢复后，新进程拒绝旧回调和会话，普通密码用户仍可读当前组织及之前的个人和第二工作空间数据。再次提供当前密码和身份提供方证明可以建立新关联。[迁移和重复执行](verify-results/organization-sso-2026-11-24/postgresql.log) · [恢复前凭据计数](verify-results/organization-sso-2026-11-24/restore-baseline.log)

同进程验证了先发起的两个真实 Keycloak 回调在解除关联与重新关联后被拒绝。注销单个会话时另一独立会话仍有效。关闭试点期间，原凭据和当前密码仍可执行注销与解除关联。重新启用后，两种撤回继续生效。新会话随后也因 SCIM 停用而被拒绝，个人和第二工作空间的密码访问照常。整个组合回归退出码为 0。[端到端回归](verify-results/organization-sso-2026-11-24/replay.log)

`assistant-organization-sso-smoke.mjs` 接收原库、还原库的两个隔离回环 API 地址及空检查点目录。测试驱动提供合成组织、已确认绑定、授权码和机器凭据回调。脚本分阶段等待旧库备份、还原、关闭与重新启用。合成用户凭据保存在独立本机测试驱动。
