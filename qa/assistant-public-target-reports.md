# 公开网页和提醒模板举报

| 操作 | 请求 | 服务端范围 |
| --- | --- | --- |
| 读取举报目标 | `GET /api/assistant/v1/hosted-sites/{siteId}/report-target` | 当前消费者登录，返回公开地址和当前发布版本 |
| 举报网页 | `POST /api/assistant/v1/reports`，类型 `hosted_site` | 必须匹配确认过的公开地址及发布版本 |
| 举报提醒模板 | `POST /api/assistant/v1/reports`，类型 `reminder_share` | 必须提交有效分享令牌及当前查看者的预览版本 |
| 撤回举报目标 | `POST /system/assistant/moderation/workspaces/{workspaceId}/reports/{reportId}/decision` | ContiNew 账号具备处置和撤回权限，且源工作空间授予处置权 |

公开站点成功响应的 `X-Assistant-Publication-Revision` 来自实际服务的 HTML 版本。已登录的举报者可通过站点 ID 取得规范公开链接和版本。源页面替换后，旧举报继续指向旧版本。

提醒模板的举报版本与查看账号及当前工作空间绑定。撤回只作用于该邀请。已复制的提醒及发布者原始日程各自维持现有权限。网页撤回只作用于该公开发布版本，私有草稿及版本仍由原权限控制。

两种举报的运营详情仅提供当前可用状态、时间、摘要散列及处置审计。站点正文、提醒内容和明文邀请令牌不进入举报记录。

## 自测

`runPublicTargetReports` 使用明确绑定的回环源服务。调用方提供实际 ContiNew 本机测试会话，并将授权限定到脚本创建的合成网页和提醒发布者工作空间。敏感会话及邀请令牌只在进程内存保留。

启用恢复模式时，调用方额外提供隔离恢复服务和空的证据目录。脚本在两条举报仍可处置时写入 `backup-ready`，调用方完成 PostgreSQL 备份后写入 `backup-done`。脚本核对撤回、私有源和对照目标，再写入 `restore-ready`。用原删除日志启动较早快照后，调用方写入 `restore-done`，脚本重新验证两条入口和对照目标。

生产 Web 构建在本机 Chrome 通过两条真实接口用例。站点地址校验阻止外部域名被用作举报目标，分享模板从当前查看者的预览提交。 [Chrome 自测记录](verify-results/public-target-moderation-chrome-2026-11-24/browser.log)

PostgreSQL 真实服务应用 175 个变更集。两个举报各产生一条已授权的撤回审计，重复处置返回同一结果。旧网页举报无法撤回新版发布。较早快照包含两条未关闭举报、两个在用站点和两份有效邀请。绑定原删除日志恢复后，两条已撤回入口继续返回 `404`，各有一条未撤回对照保持可用，原私有网页和日程也可读取。 [HTTP 与恢复日志](verify-results/public-target-report-67424f00/http-and-replay.log) · [恢复前数据库计数](verify-results/public-target-report-67424f00/pre-journal-restore.log) · [重放后数据库计数](verify-results/public-target-report-67424f00/post-journal-restore.log)

关闭站点和提醒模板后，剩余站点对照失去公开与举报预览入口，提醒模板举报返回 `403 CAPABILITY_UNAVAILABLE`，对应能力标志均关闭。 [关闭测试日志](verify-results/public-target-report-67424f00/source-flags-off.log)
