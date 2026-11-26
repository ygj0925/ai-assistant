## Why

用户需要一个能在手机、浏览器和桌面接续同一对话与任务的独立 AI 助手。现有 Guard Find 聊天可作为流式交互参考，本次变更为新产品定义从多端基础聊天到研究、协作和自动化的完整实施与验收路径。

## What Changes

- M0 确认地区、供应商、真机、签名、商店渠道、质量基线与预算，验证独立 ContiNew Admin 后端的启动、PostgreSQL 迁移和管理/用户端身份隔离，冻结版本化功能矩阵。
- M1 先用 Web 和一个移动端跑通内部测试闭环，再交付全部目标端的登录、流式会话、跨端恢复、历史搜索、数据权利、模型版本兼容、内容举报和基础权益。
- M2 扩展搜索引用、文件和多模态、实时语音、项目、记忆来源及控制、可预览和撤销的分享、数据分析。
- M3 扩展可在运行中补充要求的深度研究、定时与事件任务及模板分享、定制助手、授权插件、协作产物、交互展示和网站。
- M4 分域交付组织治理、代码工作台、远程接续、主动助手、购物和敏感数据能力。根据地区授权、渠道、成本和验证结果逐项开放。
- 各阶段交付可复现的自测证据。使用自有品牌、界面和产品文案。功能等价以可观察的用户任务、质量题集和失败恢复验收。

## Capabilities

### New Capabilities

- `assistant-platform-delivery` — 多端分发、功能资格、无障碍、灰度和发布门槛。
- `assistant-chat-and-account` — 登录、会话、模型与流式运行、计量和订阅。
- `assistant-multimodal-tools` — 搜索引用、附件、图像、语音和隔离数据分析。
- `assistant-projects-and-privacy` — 项目、记忆、隐私设置、分享与数据权利。
- `assistant-research-and-automation` — 深度研究、后台任务、定时与事件触发、定制助手和插件。
- `assistant-collaborative-artifacts` — 页面、文档、表格、幻灯片、交互展示、学习和站点。
- `assistant-workspace-governance` — 企业身份、数据策略、审计、运营和组织计费。
- `assistant-advanced-domains` — 代码工作台、远程接续、主动助手、购物、钱包、健康及财务。

### Modified Capabilities

## Impact

- AI 助手使用独立工程，ContiNew Admin `v4.2.0` 后端位于工程内的 `services/api/`，拥有自己的 Git 历史和工作树。产品域新增独立模块和接口，复用上游认证和后台能力前先验证其边界。产品数据、账号和发布环境独立维护。 [ContiNew Admin v4.2.0](https://github.com/continew-org/continew-admin/releases/tag/v4.2.0)
- 引入版本化 API 和运行事件协议，以及区域化模型、检索、存储、推送和商店集成。鸿蒙路线和供应商组合由 M0 证据决定。
- 项目内的 OpenSpec 变更承载全部阶段。M1 是基础产品发布门槛，后续能力各有验收与分批开放条件。参见[总体规划书](../../../docs/总体规划书.md)和[功能对标与跨端矩阵](../../../docs/research/功能对标与跨端矩阵.md)。
