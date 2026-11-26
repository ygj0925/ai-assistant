# 组织目录 SCIM 停用

组织所有者可将一个现有普通成员的确切入组代际绑定到目录标识。目录服务随后可按标准 SCIM 用户资源查询并停用该代际。停用使用独立权限日志撤回该组织成员的权限和相关授权，保留个人空间、组织管理员及已结算账本。现阶段提供绑定、精确查询与停用，企业身份登录、完整目录同步及组织账单分别验收。

## 接口和权限

- 所有者在选定试点组织调用 `POST /api/assistant/v1/organizations/current/directory-bindings`，提交 `{accountId,membershipRevision,externalId,confirm:true}`。`externalId` 是小写 UUID。返回 `id`、`directoryId`、`externalId` 和 `membershipRevision`。对同一有效绑定重试时返回同一份回执。管理员与其他工作空间无法绑定，已绑定的普通成员不能直接升级为管理员。
- 目录客户端使用签名的服务专用访问凭据调用 `GET /scim/v2/{directoryId}/Users/{id}`，或在同一集合使用 `filter=externalId eq "<uuid>"` 查询。响应使用 `application/scim+json`，提供标准用户资源、当前 `active` 和 ETag。目录侧的 `userName` 沿用不透明的外部 UUID，隐藏本地账号 ID 和名称。
- 目录记录需要与当前签名发行机构的指纹匹配。迁移前未固定发行机构的旧记录由原组织所有者确认同一绑定后继续使用。已经固定到不同发行机构的记录需要新的目录和明确评审。 [发行机构隔离](assistant-organization-sso.md#自测)
- `PATCH /scim/v2/{directoryId}/Users/{id}` 接受一个 PatchOp，其中唯一操作为 `replace active=false`。可用 `If-Match` 约束观察代际。再次调用已停用绑定不会重复处置，较早绑定也不能停用更新的入组代际。具备后台、消费端或另一目录入口的令牌不能替代目录服务令牌。
- 组织审计新增 `directory_deactivated`。归属组织、机器目录与受影响账号按原有审计保留规则记录。停用权限由原有的独立 `WORKSPACE_LEAVE` 日志维持，恢复副本中的旧绑定会显示停用。权限日志根据确切入组代际重放，数据库备份只保留当时已写入的普通运营审计行。

应用启动默认关闭目录入口。本地在隔离工作空间配置 `assistant.organization-directory.enabled=true`、`directory-id` 与 `workspace-id`，并为该前缀设置 `issuer`、`audience`、`client-id`、`service-subject`、`key-id` 和 `public-key`。`public-key` 是 Base64 编码的 RSA X.509 SubjectPublicKeyInfo。后端只验固定公钥、算法和短期签名凭据。目录改配和 Keycloak 演练只在合成账号及隔离测试库中执行。[SCIM 协议](https://www.rfc-editor.org/rfc/rfc7644.html) · [SCIM 用户架构](https://www.rfc-editor.org/rfc/rfc7643.html) · [Keycloak 服务凭据](https://www.keycloak.org/securing-apps/oidc-layers#_client-credentials)

## 自测

Keycloak 26.8.2 的隔离官方镜像通过真实 `client_credentials` 签发 120 秒的 RS256 凭据。测试固定发现文档里的发行机构、签名公钥、独立客户端与服务主体，凭据包含唯一目录受众及 `assistant.scim`。MySQL 8.4 命名管道运行两项追加迁移，保全五种已有审计类型，并验证工作空间外键、机器操作者和时间约束。[Keycloak 26.8.2](https://www.keycloak.org/2026/11/keycloak-2682-released) · [签发证据](verify-results/organization-directory-2026-11-24/idp.log) · [MySQL 迁移结果](verify-results/organization-directory-2026-11-24/mysql.log)

2026 年 11 月 24 日，生产 Web 在 Chrome 验证了所有者从当前普通成员选择确切入组代际，预览并主动确认绑定。预览阶段没有写入，确认后返回 201。[浏览器验收](verify-results/organization-directory-2026-11-24/browser.log)

同日，完整打包服务在 PostgreSQL 16 验证标准 SCIM 用户查询、客户端及受众检查、签名错误、错误角色、跨工作空间、批量和重新启用拒绝。调整停用时的锁顺序后，同一绑定的两个并行停用均获得 200 和 `active:false`，审计只记录一次。和所有者普通移除并行执行时也只有一次实际处置。旧绑定不能撤回重新加入的新代际。测试通过持有精确绑定行使实际账号删除等待提交，在此期间 SCIM 查询已返回 404。账号删除提交后，原绑定和审计中的账号标识都无法读取。[并发数据库记录](verify-results/organization-directory-2026-11-24/account-hold.log)

恢复停用前的备份后，旧组织权限继续拒绝，个人会话、最后一个管理员及已结算用量照常可读。关闭目录能力后，旧组织撤回状态持续生效。PostgreSQL 从基线 175 项追加两项变更集，修正版本、旧库还原和关闭功能后的重启均重复执行 0 项。[端到端恢复](verify-results/organization-directory-2026-11-24/replay.log) · [PostgreSQL 迁移记录](verify-results/organization-directory-2026-11-24/postgresql.log)

组合回归脚本 `assistant-scim-directory-smoke.mjs` 由本机测试驱动传入原库和恢复库的两个回环 API 地址与空检查点目录。测试驱动通过 `assistantScimFixture` 提供预置的合成所有者及管理员、目录 ID、真实试点后台令牌和每次读取本地 Keycloak 服务凭据的函数。脚本等待撤回前备份、还原以及同配置关闭目录后的不同运行阶段。凭据留在隔离测试驱动进程中。

并行运行 `assistant-scim-directory-account-hold-pg.sh` 并共享检查点目录，使用 `PGHOST`、`PGPORT`、`PGUSER` 和 `PGDATABASE` 连接隔离合成数据库。数据库名应匹配 `assistant_...scim_<数字>`，用户应有观察连接阻塞关系及暂时锁定测试行的权限。数据库脚本仅锁定本次测试明确提供的绑定行。
