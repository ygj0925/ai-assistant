# 组织模型和连接器策略

显式配置的组织工作区可按公开模型 ID 限制可用模型，并关闭本地连接器的新增操作。当前组织所有者在设置中审阅变更后保存。组织管理员可以管理已有授权范围内的成员，策略编辑仍需所有者权限。个人工作区继续使用部署模型目录与默认模型。

`assistant.organization-policies.enabled` 默认为 `false`，控制组织所有者的策略设置入口与读写 API。已保存的策略继续在模型和连接器的执行路径生效。启用设置需要已配置的组织工作区、当前成员关系、实际所有者会话和可用的独立撤销日志。

- 所有者读取 `GET /api/assistant/v1/organizations/current/policy`。初始模型列表为 `null`（采用部署目录），确认保存 `[]` 会拒绝所有模型。显式列表最多 16 个公开模型 ID。
- 所有者用 `PUT /api/assistant/v1/organizations/current/policy` 提交 `baseRevision`、`allowedModelIds`、`sandboxConnectorAllowed` 和 `confirm: true`。旧版本返回 `409 ORGANIZATION_POLICY_CHANGED`。审计保留 `policy_changed` 与操作人摘要，遵循已有组织审计清理流程。
- 模型目录、请求指定模型、已下线模型的实际回退路由、工作进程每次调用和写入回复阶段检查同一策略。拒绝新运行时不记录提示词、不预留额度。策略收紧后，已开始的模型调用可能正在传输，新的回复片段和最终消息写入按工作区策略锁停止。运行返回 `ORGANIZATION_POLICY_DENIED` 的失败状态。
- 本地模拟连接器在授权、创建、批准和真正记录模拟效果时检查策略。策略版本更新后，旧版本的未执行审批无法继续，所有者或原成员仍可处理已开始操作的历史记录。事件提醒只接收当前策略版本下同一授权的真实完成凭据。
- 每次替换策略先在独立撤销日志退役旧版本。恢复数据库备份后，若只找到已退役的版本或已退役的初始默认设置，组织暂停使用模型和连接器，直至所有者确认当前设置。个人工作区保持可用。

## 本地验证

`qa/assistant-organization-policy-smoke.mjs` 使用独立回环地址、真实 ContiNew 已授权操作员和一次性合成账户。运行时配置本地 `local-echo`，增加可控延时，登记 `assistant.models.retired.qa-retired=local-echo`，开启既有沙盒连接器及其事件提醒，绑定独立日志和模拟凭据账本。使用 `ASSISTANT_TEST_ORG_OPERATOR_TOKEN` 传入操作员临时会话，并在验证脚本退出后登出。验证证据中不写入会话、验证码或口令。

- 普通模式验证所有者边界、审批前后版本、额度和提示词隔离、流中撤回、旧模拟凭据以及个人工作区正常使用。
- `restore` 模式在第一次明确配置前备份，保留同一独立日志恢复到新数据库，再验证旧默认策略关闭、所有者可重新确认以及旧审批保持无效。
- `toggle` 模式保存禁止策略后，以同一数据库和日志重启并关闭编辑开关，确认已有策略仍生效。

## 2026-11-24 验证记录

- PostgreSQL 16 独立实例全量应用 156 个 Liquibase 变更。第一次保存策略前归档时，数据库有一条组织记录、零条策略记录。恢复后的实例保留同一独立日志和模拟账本，已运行 156 个变更，本次重启应用零项。真实 HTTP 回归通过。[恢复测试](verify-results/organization-policy-2026-11-24/replay.log)
- 在相同恢复数据库上关闭编辑开关后，组织所有者入口关闭，保存的模型和连接器拒绝策略继续生效。个人工作区完成已下线模型的本机回退。[开关测试](verify-results/organization-policy-2026-11-24/toggle.log)
- 生产 Web 构建用 Chrome 验证所有者与普通成员入口、所有者无法离开组织、并发修改冲突及刷新、显式空列表后成员目录不可用，以及审计显示。[浏览器测试](verify-results/organization-policy-2026-11-24/browser.log)
- 在新打包版复跑时，空模型列表同时禁用组织内普通和临时对话。直接请求组织内临时生成返回 `403 ORGANIZATION_POLICY_DENIED`。同一账号在个人工作空间可以使用本地临时对话。[临时对话策略复测](verify-results/organization-policy-2026-11-24/browser-temporary.log)
- MySQL 8.4 禁用网络的命名管道数据库应用配对迁移，验证既有目录和运行记录不变、组织删除级联、策略审计、独立日志事件类型、非法外键和版本拒绝。[原生迁移测试](verify-results/organization-policy-2026-11-24/mysql.log)

此范围的本地账本只记录合成连接器效果。生产 SaaS 连接器、供应商区域和保留配置、组织配额与真实容量验证仍需环境、合同和授权。
