# 本地候选规格追踪

2026 年 11 月 24 日复核。青屿助手 0.1.0 的 Web 生产构建、Java 打包后端、Windows x64 本地宿主与 Pixel Tablet API 36 调试应用构成本次验收范围。服务测试使用隔离账号、选定工作空间和明确开启的能力，PostgreSQL 及 MySQL 证据按功能保存。iOS Hermes 已导出，运行证据来自各行注明的设备。 [本地候选与运行手册](../docs/release/本地候选版本与运行手册.md) · [合并检查](verify-results/2026-11-24T09-51-46-832Z-39484/summary.json)

场景状态对应本次验收环境。合成通过覆盖可重复的本地供应商或事件夹具。首发市场、商业套餐、签名包、真机组合、运营阈值、生产灰度及判定责任仍按正式候选补齐。原公开功能目录的 26 个条目由既有追踪表对应到下列八项规范。 [功能条目与阶段](m0-capability-trace.md) · [目标设备与渠道](m0-live-readiness.md)

## 账号和聊天

[对应 OpenSpec 规范](../openspec/changes/build-cross-platform-ai-assistant/specs/assistant-chat-and-account/spec.md)

| 规格场景 | 状态 | 验收证据 |
| --- | --- | --- |
| 切换账号与撤销设备 | 本地通过 | 登录、切换及旧设备访问拒绝。[证据](assistant-account.md) |
| 两端并发编辑 | 本地通过 | 双会话编辑不同分支，保留胜出的当前版本。[证据](assistant-run.md) |
| 发送成功后响应丢失 | 本地通过 | 同键恢复原运行、异请求拒绝。[证据](assistant-run.md) |
| 暂停期间的运行已完成 | 本地通过 | SSE 重放、裁剪后的权威快照与唯一终态。[证据](assistant-run.md) |
| 停止与自然完成并发 | 本地通过 | 取消与完成竞态、单次结算。[证据](assistant-run.md) |
| 回调重复且到达顺序不同 | 合成通过 | 独立订阅沙箱的重复、退款和乱序回放。[证据](assistant-billing-sandbox.md) |
| 模型所在区域故障 | 部分覆盖 | 本地限流、故障注入与回退，正式区域供应组合待确认。[证据](assistant-resilience.md) |
| 在退役模型的旧会话中继续 | 本地通过 | 退役映射、上下文预算与可用性提示。[证据](assistant-model-gateway.md) |

## 跨端交付

[对应 OpenSpec 规范](../openspec/changes/build-cross-platform-ai-assistant/specs/assistant-platform-delivery/spec.md)

| 规格场景 | 状态 | 验收证据 |
| --- | --- | --- |
| 换设备继续聊天 | 部分覆盖 | Chrome 与 Android 的本地重连，iPhone 和鸿蒙联合流程待真机。[证据](assistant-web-platform.md) |
| 签名包升级 | 待渠道验收 | Windows x64 本地包冒烟与 Android 调试安装已测，签名升级待渠道。[证据](m0-live-readiness.md) |
| 不支持屏幕共享 | 部分覆盖 | 浏览器捕获失败、关闭来源及回到文件输入，实时会话待供应环境。[证据](assistant-png-attachments.md) |
| 真机或地区验证失败 | 待渠道验收 | 同时核对首发地区、支持版本、签名包和供应能力。[证据](m0-live-readiness.md) |

## 多模态和工具

[对应 OpenSpec 规范](../openspec/changes/build-cross-platform-ai-assistant/specs/assistant-multimodal-tools/spec.md)

| 规格场景 | 状态 | 验收证据 |
| --- | --- | --- |
| 部分来源失效 | 合成通过 | 已审核本地来源的具体失效与剩余可用引用。[证据](assistant-retrieval.md) |
| 上传无效文件并编辑合法图像 | 部分覆盖 | 扫描和格式拦截、本地裁剪旋转、资产版本与源图撤回已测，正式图像生成供应环境待验收。[扫描](assistant-png-attachments.md) · [本地编辑](assistant-local-image-edit.md) |
| 通话中撤销麦克风 | 待实时服务 | 本机朗读和音频输入已有独立复测，持续双向语音待实时端。[证据](assistant-local-read-aloud.md) |
| 听写后修正再发送 | 部分覆盖 | Android API 36 隔离模拟器经麦克风断网识别合成普通话，停止后可修改草稿，发送需明确操作。其他端与正式发布模型待验收。 [Android 听写](../clients/mobile/README.md#普通话离线听写调试构建) |
| 非授权会话请求下载产物 | 本地通过 | 固定 CSV 分析产物跨任务和跨账号访问拒绝。[证据](assistant-csv-analysis.md) |

## 项目和隐私

[对应 OpenSpec 规范](../openspec/changes/build-cross-platform-ai-assistant/specs/assistant-projects-and-privacy/spec.md)

| 规格场景 | 状态 | 验收证据 |
| --- | --- | --- |
| 撤回项目成员访问 | 本地通过 | 项目成员、角色变更与旧链接拒绝。[证据](assistant-project-collaboration.md) |
| 临时会话下的记忆与历史查找 | 本地通过 | 临时会话和持久数据隔离。[证据](assistant-temporary-chat.md) |
| 查看并停止使用项目记忆 | 本地通过 | 来源凭证、范围变更与当前权限。[证据](assistant-project-memory-sources.md) |
| 删除后恢复旧备份 | 本地通过 | 独立日志重放删除、会话和对象权限。[证据](assistant-erasure.md) |
| 个人快照撤销 | 本地通过 | 个人分享撤回与备份恢复后的旧链接。[证据](assistant-sharing.md) |
| 组织外用户打开受限链接 | 本地通过 | 受众范围、工作空间与附件授权。[证据](assistant-sharing.md) |

## 研究和自动化

[对应 OpenSpec 规范](../openspec/changes/build-cross-platform-ai-assistant/specs/assistant-research-and-automation/spec.md)

| 规格场景 | 状态 | 验收证据 |
| --- | --- | --- |
| 研究中退出客户端与重启 Worker | 本地通过 | 持久研究计划、Worker 接续与报告访问。[证据](assistant-local-research.md) |
| 运行期间补充要求 | 本地通过 | 同一任务在 Android 接续、旧审批失效及报告准确性。[证据](assistant-local-research.md) |
| 重复事件与时钟变化 | 合成通过 | 本地日历与独立连接器账本、夏令时和去重。[证据](assistant-sandbox-event-reminders.md) |
| 接收并套用计划任务 | 本地通过 | 显式复制、配额和时区后按接收方授权运行。[证据](assistant-reminder-templates.md) |
| 审批前插件权限撤销 | 合成通过 | 本地沙箱授权变化、旧审批拒绝。[证据](assistant-sandbox-connector.md) |
| 外部工具响应未知 | 合成通过 | 独立账本保存效果，丢失响应后重新查证。[证据](assistant-m3-resilience.md) |

## 协作产物

[对应 OpenSpec 规范](../openspec/changes/build-cross-platform-ai-assistant/specs/assistant-collaborative-artifacts/spec.md)

| 规格场景 | 状态 | 验收证据 |
| --- | --- | --- |
| 并发编辑与访问撤销 | 本地通过 | 版本竞态、评论和 Android 撤权。[证据](assistant-project-shared-drafts.md) |
| 设备无法呈现交互测验 | 本地通过 | 文本回退仍能完成答题与反馈。[证据](assistant-learning.md) |
| 从私有预览到撤回 | 回环测试通过 | 同一匿名地址发布、更新、回退和撤回，旧库重放。[证据](assistant-hosted-sites.md) |

## 组织治理

[对应 OpenSpec 规范](../openspec/changes/build-cross-platform-ai-assistant/specs/assistant-workspace-governance/spec.md)

| 规格场景 | 状态 | 验收证据 |
| --- | --- | --- |
| 目录停用成员 | 部分覆盖 | 实际 Keycloak 签发的本地目录凭据通过停用、重试、角色隔离、SSO 访问撤回与旧库审计。目标企业目录和正式登录渠道待联合验收。 [成员与座席](assistant-organizations.md) · [SCIM 验收](assistant-organization-directory.md) · [组织 SSO](assistant-organization-sso.md) |
| 企业禁用插件 | 合成通过 | 组织策略限制新核准调用和事件凭据，旧库继续拒绝。[证据](assistant-organization-policies.md) |
| 用量回放与告警 | 部分覆盖 | 脱敏观测、组织日度汇总、升级前后结算单位一致。生产量级阈值待验收。[告警](assistant-observability.md) · [账本汇总](assistant-organizations.md#组织用量汇总) |
| 跨租户或跨入口访问 | 本地通过 | 真实 ContiNew 运营会话和消费者授权隔离。[证据](assistant-organizations.md) |
| 举报分享内容 | 本地通过 | 实际浏览器举报指定共享回复，授权运营撤回后旧链接及恢复库均拒绝访问。四次并发举报去重，设备撤权竞态未写入。[端到端与恢复](assistant-shared-report-moderation.md) |

## 扩展功能

[对应 OpenSpec 规范](../openspec/changes/build-cross-platform-ai-assistant/specs/assistant-advanced-domains/spec.md)

| 规格场景 | 状态 | 验收证据 |
| --- | --- | --- |
| 用户取消设备配对 | 本地通过 | Windows 与 Android 同账号配对、精确审批、改稿撤回、解绑与真实撤销竞态。[证据](assistant-desktop-companion.md) |
| 静默和关闭主动建议 | 本地通过 | Chrome、Android 两种角色和旧库恢复后的持续关闭。[证据](assistant-local-proactive.md) |
| 确认后收不到商家结果 | 待商家验收 | 正式商家沙箱、订单查证和资金动作仍待环境。[证据](m0-live-readiness.md) |
| 账号不满足专项资格 | 部分覆盖 | 合成账号已核验资格、地区限制、监护授权与恢复后撤回。真实年龄核验、健康和财务需目标市场审批及服务提供方。[监护](assistant-guardian-eligibility.md) · [外部条件](m0-live-readiness.md) |

