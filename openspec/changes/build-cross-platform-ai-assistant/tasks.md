## 1. M0 对标和可行性

- [x] 1.1 将[功能目录](../../../docs/research/功能对标与跨端矩阵.md)逐项映射到[八项能力](proposal.md#new-capabilities)和阶段。记录日期、账号、地区、套餐、版本、权限、预期结果与失败行为，公开证据和实测状态分别记录。 [功能追踪](../../../qa/m0-capability-trace.md)
- [ ] 1.2 确认首发市场及发行渠道。建立地区、模型、搜索、语音、数据处理、适用审核和成本对照表，确认不可开放功能及原因。
- [ ] 1.3 对候选模型运行同一组合成题集，记录中文、多轮、视觉、语音、结构化输出、引用、限流、回退、延迟和单位成本。保留原始运行编号及可复现实验条件。
- [ ] 1.4 用 HarmonyOS NEXT 真机验证签名安装、中文输入、流式重连、文件选择、录音撤权、推送及支付测试环境。记录 RNOH 通过项、需桥接项及转 ArkTS/ArkUI 的决定。
- [ ] 1.5 在 macOS 与 Windows 验证目标 CPU 架构的打包、签名或公证、安装、系统权限与升级。记录 iOS/iPadOS、Android、鸿蒙及浏览器最低支持版本和代表设备。 [Windows x64 本地包与运行验证](../../../clients/desktop/README.md#打包和自测)
- [ ] 1.6 冻结目标并发、首字延迟、错误率、任务通过率、引用准确率、用量预算、恢复时间和恢复点目标。指定各端、后端、模型、测试及运维负责人，依据真机与供应商结果更新排期。
- [x] 1.7 对照 [ContiNew Admin v4.2.0](https://github.com/continew-org/continew-admin/releases/tag/v4.2.0) 固定后端分支、起始提交和构建工具链，记录基线构建、依赖来源与升级策略。比对上游 RSA 初始化相关修复，验证当前分支登录和启动路径。 [验证结果](../../../qa/m0-backend-baseline.md#postgresql-启动与认证验证)
- [x] 1.8 用隔离 PostgreSQL 与 Redis 执行签入的 Liquibase 空库、重复运行、增量迁移、服务启动和登录验证，检查默认租户、缓存命名空间及连接配置。验证后再冻结部署基线。 [迁移及权限证据](../../../qa/m0-backend-baseline.md)
- [x] 1.9 记录后端独立克隆、基线版本和本地构建入口，登记可复用组件和需实现的产品模块。团队协作和远程 CI 启用前再配置自有远端及版本锁定。 [后端基线](../../../qa/m0-backend-baseline.md)
- [ ] 1.10 审核 M0 证据。核心模型无供给的市场保持关闭，鸿蒙主路由失败时复测原生预案。记录后端启动、迁移及权限阻断问题，阶段条件满足后进入 M1。

## 2. M1 工程底座与服务端

- [ ] 2.1 按[工程结构](design.md#工程结构与客户端)配置本工程的客户端、Worker 和 CI。在已有 ContiNew Admin 后端添加独立 AI 业务 Maven 模块并注册根 POM，保留上游许可证与归因。 [本地 Worker 与 Maven 模块](../../../qa/assistant-jobs.md) · [各端 CI、后端提交锁定及本地验证](../../../qa/verify.md#持续集成)
- [x] 2.2 配置 PostgreSQL、Redis、对象存储、迁移检查、测试数据库和合成数据夹具。提供清洁初始化及增量迁移的可复现入口。 [本地依赖与验证记录](../../../infra/local/README.md)
- [x] 2.3 定义版本化 API、错误码、能力资格与 SSE 事件契约，生成或维护各端 SDK，添加请求与事件样例及契约测试。 [共享契约与测试](../../../packages/contracts/README.md)
- [x] 2.4 实现注册、登录、访客策略、账号切换、设备撤销与基本偏好。运营与用户端采取分用途令牌及独立路由权限，验证会话缓存清理、租户成员资格及对管理接口的隔离。 [账号验收记录](../../../qa/assistant-account.md)
- [x] 2.5 实现会话、消息节点、运行、事件、额度与订阅账本数据模型，写入工作空间权限及索引的迁移。 [双数据库迁移和约束验证](../../../qa/assistant-run-storage.md)
- [x] 2.6 实现会话新建、重命名、置顶、归档、历史搜索、删除和分页。用简繁中文、英文及专有词检验搜索。 [会话和历史验收](../../../qa/assistant-conversation.md)
- [x] 2.7 实现编辑分支、停止、重试与重新生成，并保留原分支和运行。测试双设备并发编辑与同一节点切换。 [聊天运行自测](../../../qa/assistant-run.md)
- [ ] 2.8 接入确定性模拟模型和至少一个 M0 确认的供应商。实现模型列表、推理档位、自动路由、超时、限流与地域约束。 [合成模型与供应商适配](../../../qa/assistant-model-gateway.md)
- [x] 2.9 实现请求幂等、持久化运行、SSE 顺序重放、快照降级与唯一终态。验证同键异请求冲突、事件截断、过期游标和取消竞态。 [聊天运行与账本自测](../../../qa/assistant-run.md)
- [ ] 2.10 实现用量预留和实际结算、权益查询及适用渠道的购买恢复和订单回调对账。验证占用释放、迟到退款、重复和乱序通知。 [本地用量与结算](../../../qa/assistant-run.md) · [合成订阅渠道与对账](../../../qa/assistant-billing-sandbox.md)
- [x] 2.11 实现数据导出、会话删除和账号注销。覆盖删除后访问阻断、备份保留边界及恢复后重放删除。 [个人数据导出](../../../qa/assistant-privacy-export.md) · [账号注销与备份重放](../../../qa/assistant-erasure.md)
- [x] 2.12 接入脱敏日志、模型/队列/账本观测和基础告警，用同一运行标识串联客户端及服务端证据。 [运行观测自测](../../../qa/assistant-observability.md)
- [x] 2.13 实现最小内容举报、运营授权和处置审计。后续分享、产物和任务使用同一举报链路。验证运营账号与用户账号互访被拒绝，模拟举报对象撤回。 [统一举报权限与审计](../../../qa/assistant-moderation.md) · [共享回复撤回与会话竞态](../../../qa/assistant-shared-report-moderation.md) · [公开产物与提醒模板](../../../qa/assistant-public-target-reports.md)
- [x] 2.14 保存模型实际版本、上下文预算与退役映射，覆盖旧会话接续、长上下文及退役模型选项。验证用户能辨认可用档位、降级和影响回答的上下文限制。 [模型和上下文自测](../../../qa/assistant-model-gateway.md#版本与上下文兼容)

## 3. M1 客户端及自测发布

- [x] 3.1 实现自有品牌、设计变量、聊天消息/输入框、历史导航及 Markdown、表格、代码、安全链接和操作反馈。 [青屿助手 Web 与自测](../../../clients/web/README.md)
- [x] 3.2 实现响应式 Web 客户端，验证桌面和移动浏览器的中文输入、键盘、缩放、断网、后台恢复和下载。 [桌面 Chrome 与 Android Chrome 实测](../../../qa/assistant-web-platform.md)
- [ ] 3.3 实现 iOS/iPadOS 客户端，验证手机/平板布局、令牌安全存储、系统输入、退后台恢复和适用的购买路径。 [移动端与 iOS JavaScript 打包](../../../clients/mobile/README.md)
- [ ] 3.4 实现 Android 客户端，验证手机/平板或折叠屏布局、系统返回、进程重启恢复及目标渠道安装或购买。Web 与首个可用移动端通过登录、流式接续、旅程成本及隔离自测后，再铺开其余端的发布工作。 [Android 调试包安装](../../../clients/mobile/README.md) · [Pixel Tablet 布局和恢复](../../../clients/mobile/README.md#pixel-tablet-硬件配置复测) · [Android 手机中文输入和系统返回](../../../clients/mobile/README.md#android-手机布局和中文输入)
- [ ] 3.5 采用 M0 选定的方案实现鸿蒙客户端，验证 NEXT 真机安装、登录、输入法、流式恢复及能力缺失时的回退。
- [ ] 3.6 实现 macOS 与 Windows 桌面宿主，复用兼容的界面组件，验证安全 IPC、域/外部链接策略、快捷键和签名升级。 [已实现 Electron 宿主及 Windows x64 验收](../../../clients/desktop/README.md)
- [x] 3.7 在 `qa/` 建立分阶段用例与证据目录，提供本地及 CI 的单元、契约、服务集成及 Web 端到端入口，执行后输出机器可读结果和失败日志。 [QA 入口与证据](../../../qa/verify.md)
- [ ] 3.8 在测试环境执行断流用例。从 iPhone 发消息后断网，在 Web 接续，再用鸿蒙恢复过期游标，在桌面检查同一回复与运行。注入重复事件、重复提交和停止竞态，核对消息、运行和有效用量无重复。 [Android 手机上同一运行冷启动续流、重复提交和账本](../../../clients/mobile/README.md#android-手机布局和中文输入)
- [x] 3.9 用双账号、双工作空间和旧设备执行越权、撤销、注销、导出与删除搜索用例。覆盖租户请求头与身份不匹配、SSE 续流和 Worker 租户上下文，验证缓存和恢复后的数据可见性。 [双账号及恢复回归](../../../qa/assistant-erasure.md) · [会话与缓存隔离](../../../qa/assistant-account.md)
- [ ] 3.10 对各已接入发行渠道执行支付沙箱购订、续订、恢复、退款和迟到回调，核对客户端显示与服务端账本。
- [ ] 3.11 对照 M0 阈值压测聊天与历史接口，注入供应商限流、服务重启和网络故障，验证告警、灰度关闭、数据恢复及兼容回滚。 [本地并发、断流、限流及重启演练](../../../qa/assistant-resilience.md)
- [ ] 3.12 用各端签名候选包执行登录、会话、同步、缩放/读屏、中文输入和版本升级冒烟。核心旅程、权限、数据和账本阻断问题清零后，生成各渠道内测或送审清单。

## 4. M2 多模态、语音和项目

- [ ] 4.1 接入检索与引用，保存来源、访问时间及展示关系。验证链接对应主张、来源过期、部分失效和无来源时的输出。 [本地审核来源、失效及权限验收](../../../qa/assistant-retrieval.md)
- [ ] 4.2 建立文件隔离上传、扫描、校验、解析、短期下载及撤权。各客户端接入文档、图像/相机扫描及音频输入、进度、取消和重试。 [UTF-8 文本导入、下载和撤权恢复](../../../qa/assistant-project-resources.md) · [Web 私有 PNG、隔离扫描和短期下载](../../../qa/assistant-png-attachments.md) · [私有 WAV 扫描、授权和旧库恢复](../../../qa/assistant-project-audio.md) · [Web 与 Android 本机录音及撤权](../../../qa/assistant-project-audio.md#web-本机录音) · [基础 PDF 和隔离进程压缩多页解析](../../../qa/assistant-project-pdf.md) · [单页扫描件与下载确认](../../../qa/assistant-project-pdf.md#单页扫描件-ocr) · [Android 文本选择器](../../../clients/mobile/README.md#项目文本资料) · [Android 拍照上传](../../../clients/mobile/README.md#拍照上传私有-png)
- [ ] 4.3 加入图像生成、编辑、版本、资产库及导出。验证参考图权限、可用的生成内容标识及失败退款或额度处理。 [本地裁剪、旋转、版本与源图撤回](../../../qa/assistant-local-image-edit.md)
- [x] 4.4 接入隔离数据分析和产物下载。用固定样例校验汇总、图表、运行元数据、超时与资源限制，复测跨账号和跨任务访问边界。 [固定列 CSV、Web 实测及备份恢复](../../../qa/assistant-csv-analysis.md)
- [ ] 4.5 实现实时听写及发送前编辑、朗读、实时语音、打断和转录。对每个声明支持的客户端实测权限拒绝/撤回、切换网络、后台恢复、音频路由和文本回退。 [Web 本机朗读](../../../qa/assistant-local-read-aloud.md) · [Android 离线朗读](../../../clients/mobile/README.md#android-本机朗读) · [Android 普通话离线听写调试包、编辑与权限撤回](../../../clients/mobile/README.md#普通话离线听写调试构建)
- [x] 4.6 实现项目说明、会话迁移、项目资料和资源检索。实现整段/单条回复分享、预览、受众、附件控制、继续为独立副本和访问撤回。验证加锁、离开组织和链接撤回。 [私有项目与会话迁移](../../../qa/assistant-jobs.md) · [分享限制、受众、附件隔离与旧链接撤回](../../../qa/assistant-sharing.md) · [项目文本资料](../../../qa/assistant-project-resources.md) · [主动退出工作空间与旧库重放](../../../qa/assistant-workspace-departure.md)
- [x] 4.7 实现自定义指令、个人和项目记忆、历史引用设置、可用时显示来源、临时及加锁对话。验证关闭后不写入、项目间不串用、撤权后不读取。 [手动记忆、指令设置和恢复](../../../qa/assistant-memory.md) · [本地上下文生成权限](../../../qa/assistant-personalized-run.md) · [历史引用](../../../qa/assistant-explicit-history.md) · [项目记忆来源](../../../qa/assistant-project-memory-sources.md) · [临时对话](../../../qa/assistant-temporary-chat.md) · [会话阅读锁与旧库撤权](../../../qa/assistant-conversation-read-lock.md) · [Android 加锁、撤权与冷启动](../../../clients/mobile/README.md#加锁对话)
- [ ] 4.8 执行 M2 联合回归。扫码/拍摄上传、图像生成与编辑、跨端查阅、分析、语音撤权、删除及分享撤回均保存证据。比较引用准确率、音频延迟、模型花费和目标阈值。 [本地媒体组合、构建及迁移核对](../../../qa/verify-results/combined-media-chrome-2026-11-24/build-witness.json) · [含单页 OCR 的八项 Chrome 回归](../../../qa/verify-results/combined-ocr-final-chrome-2026-11-24/browser.log)

## 5. M3 研究、自动化和协作

- [x] 5.1 实现持久化后台任务、状态、进度、事务发件箱、取消及 Worker 接续。重启执行进程后恢复同一运行和产物。 [后台导出、撤权与进程重启验收](../../../qa/assistant-jobs.md)
- [x] 5.2 实现深度研究计划、来源限定、运行中补充要求、审批节点、跨端接续及报告导出。用引用题集、约束修改与旧审批失效场景验证。 [审核来源、跨端审批、引用题集及旧库恢复](../../../qa/assistant-local-research.md) · [Android 接续与报告保存](../../../clients/mobile/README.md#接续研究任务)
- [x] 5.3 实现一次性、周期和连接器事件触发，以及时区、静默、暂停和通知。用固定时钟验证夏令时、漏触发补偿和重复投递。 [站内提醒、时区与递送](../../../qa/assistant-reminders.md) · [连接器事件去重、静默和旧库恢复](../../../qa/assistant-sandbox-event-reminders.md) · [Android 投递及重启](../../../clients/mobile/README.md#站内定时提醒)
- [x] 5.4 实现私有定制助手的指令、知识、工具与版本。验证权限和知识隔离及版本回退。 [私有配置、版本回退与本地运行](../../../qa/assistant-custom-assistants.md)
- [ ] 5.5 接入获准的连接器和工具审批，支持 OAuth 撤销与外部结果查证。用沙箱验证授权变化、审批后失败与重复执行保护。 [独立合成账本、审批撤回及未知结果恢复](../../../qa/assistant-sandbox-connector.md)
- [x] 5.6 实现项目内邀请、角色和资料/产物协作，验证用户加入退出和旧链接撤权。 [同一工作空间的邀请、角色与共享资料](../../../qa/assistant-project-collaboration.md) · [发布指定文稿版本与撤权恢复](../../../qa/assistant-project-artifact-publication.md)
- [x] 5.7 实现文稿、网页、代码稿等编辑和版本，接入表格、幻灯片和资产的创建、协作权限及格式导出。 [私有文稿](../../../qa/assistant-private-artifacts.md) · [回复关联与表格、幻灯片、代码协作](../../../qa/assistant-typed-artifact-collaboration.md) · [审核发布的 PNG](../../../qa/assistant-image-artifacts.md) · [Android 发布版本验收](../../../clients/mobile/.expo/published-documents-2026-11-24/android-results.json)
- [x] 5.8 实现并发编辑、评论、版本恢复和跨端阅读/编辑降级。复测撤销成员后不能读写以及导出文件可正常打开。 [Web 共享 Markdown 与冲突恢复](../../../qa/assistant-project-shared-drafts.md) · [指定发布版本评论和撤权](../../../qa/assistant-project-artifact-comments.md) · [Android 只读及权限复核](../../../clients/mobile/README.md#共享文稿)
- [x] 5.9 实现学习模式、测验、结构化图表和交互组件，并验证不支持端的文本回退能完成同一任务。 [Web 学习与 Android 离线文本验收](../../../qa/assistant-learning.md)
- [x] 5.10 实现站点生成、私有预览、复制创作、版本和分享。验证预览权限、依赖失败和隔离边界。 [回复生成、静态网页私有预览与复制](../../../qa/assistant-webpage.md) · [项目成员获准版本、预览依赖故障和撤权](../../../qa/assistant-webpage-publication.md)
- [ ] 5.11 为声明支持的端接入摄像及屏幕共享，验证用户授权、录制提示、权限撤销与回落到文本/语音。 [Web 摄像头撤权、屏幕取帧和录音回退](../../../qa/assistant-png-attachments.md#web-摄像头与屏幕取帧)
- [x] 5.12 执行 M3 故障演练，核对任务重启恢复、重复触发、外部结果未知、共编冲突及权限撤销的最终状态。验证长任务资源预算和灰度关闭。 [故障、恢复、权限与资源预算验收](../../../qa/assistant-m3-resilience.md)
- [x] 5.13 实现适用计划任务的分享预览、撤销和接收方套用。验证每个副本重新核对接收人的配额、时区和权限，并与 M3 故障用例共同完成发布回归。 [日历提醒分享、独立副本和撤回恢复](../../../qa/assistant-reminder-templates.md)

## 6. M4 企业治理与扩展域

- [ ] 6.1 实现组织成员、座席、角色、SSO/SCIM、组织用量和计费，验证目录停用、角色更改和跨组织访问。 [本地成员、座席、角色、审计和旧库恢复](../../../qa/assistant-organizations.md) · [签名目录停用、账号撤权竞态和旧库恢复](../../../qa/assistant-organization-directory.md) · [Keycloak 单点登录只读试点](../../../qa/assistant-organization-sso.md)
- [ ] 6.2 实现组织级模型/插件策略、驻留、保留、审计和预算控制，验证策略变更和恢复后仍生效。 [本地模型与连接器策略](../../../qa/assistant-organization-policies.md) · [组织月度模型用量上限、并发与旧账本恢复](../../../qa/assistant-organization-model-budget.md)
- [x] 6.3 实现经审核的助手/插件目录、版本发布、撤回和举报。用运营沙箱验证审核、入口可见和紧急禁用。 [经审核的助手与第一方插件目录、真实运营权限及旧库恢复](../../../qa/assistant-reviewed-catalog.md)
- [x] 6.4 实现站点公开托管、更新、版本回滚和撤回。自测仅使用授权测试域名，验证撤回后的访问和缓存策略。 [本地公开托管、Chrome 与旧库撤回](../../../qa/assistant-hosted-sites.md)
- [x] 6.5 在自有样例项目和隔离测试环境实现代码工作台的授权编辑、构建验证、产物、差异及审阅。 [原生工作台、受审修订、V8 编译验证及打包验收](../../../qa/assistant-local-code-workbench.md)
- [x] 6.6 实现桌面宿主与移动端配对和远程接续，验证单设备撤销、会话超时、目录越权拦截与审批记录。 [Windows 与 Android 本地配对、精确审批和撤销竞态](../../../qa/assistant-desktop-companion.md)
- [x] 6.7 实现主动助手的启用、建议、角色、通知与静默设置。验证关闭或移除应用授权后停止新的动作。 [站内建议、Chrome、Android 与关闭后的旧库恢复](../../../qa/assistant-local-proactive.md)
- [ ] 6.8 按目标市场实现商品搜索、价格时点、对比和商品来源，使用合成目录验证上下架、价格更新和跳转。 [合成目录、跨币种报价及下架回查](../../../qa/assistant-synthetic-catalogue.md)
- [ ] 6.9 在满足市场、供应商和授权要求的地区接入钱包类能力。使用商家测试环境验证金额确认、订单未知、重复通知、退款及审批撤销。
- [ ] 6.10 对获准的健康与财务连接器实现单独授权、隔离存储、删除与审计。用合成数据测试数据用途、区域策略和访问撤销。
- [x] 6.11 建立年龄和监护策略，以测试账号验证能力限制、监护授权和适用地区的专项入口。 [合成账号资格、明确授权、撤回及双份旧库恢复](../../../qa/assistant-guardian-eligibility.md)
- [x] 6.12 分能力执行安全、权限、成本、渠道和恢复回归，保存试点结论。依赖市场资格或渠道审批的功能保留关闭状态，待条件满足后逐项验收。 [M4 试点与默认关闭实测](../../../qa/assistant-m4-pilot.md)

## 7. 全量验收与交付

- [ ] 7.1 将每项规格场景、功能矩阵条目和测试结果对应到发布候选构建。复核平台、地区、套餐、权限、设备和灰度组合，记录适用依据与未完成项。 [41 项规格与本地候选证据](../../../qa/assistant-release-scenario-trace.md)
- [ ] 7.2 在生产等价的隔离环境执行端到端复测、压力/故障注入、备份恢复、数据库迁移、旧客户端兼容和回滚。核对跨端数据、权限及账本。 [本地组合恢复、并发账本、老版本兼容边界](../../../qa/assistant-composite-recovery.md) · [历史备份切换后的重新认证](../../../qa/assistant-composite-recovery.md#还原后重新认证)
- [ ] 7.3 输出版本发布说明、运行手册、客服排障、值班告警与各渠道材料。核验签名包、商店审核状态、市场材料和功能开关，提交分批开放与回退结论。 [本地候选版本与运行手册](../../../docs/release/本地候选版本与运行手册.md)
- [x] 7.4 自查阶段交付物与测试报告，汇总实测通过、失败、未测及不适用项。各发布范围只有在目标阈值满足且阻断缺陷清零后才标记为可发布。 [41 个规格场景追踪](../../../qa/assistant-release-scenario-trace.md) · [验收自查及分端发布结论](../../../docs/release/验收与风险审查.md#当前验收自查)

## 外部联调依赖

- 1.2、1.3、1.6、1.10、2.8 和 4.1 的正式候选需确认首发市场、授权供应商、实际可用模型、费用预算、生产阈值及负责人。现有证据属于本机或合成测试。 [地区、供应商和指标缺口](../../../qa/m0-live-readiness.md)
- 1.4、1.5、3.3、3.5、3.6、3.8、3.12 需要与任务范围匹配的 Apple、HarmonyOS NEXT 或 ARM64 真机、构建环境和渠道签名。Windows x64 本地包可运行，签名与升级仍待发行环境。 [平台实测和工具链预检](../../../qa/m0-live-readiness.md#工具链基线与测试设备)
- 2.10、3.4、3.10 的渠道验收需使用获准的商店测试账号、签名包及沙箱订单。 [本地订阅对账证据](../../../qa/assistant-billing-sandbox.md)
- 2.1 的远程 CI 还需要团队控制的独立后端仓库及其可检出版本。 [本地及 CI 运行约定](../../../qa/verify.md#持续集成)
- 4.2、4.3、4.5、4.8 和 5.11 的完整验收还需要各目标签名设备上的媒体及权限测试、获准的图像和实时语音供应商，以及目标延迟和花费阈值。Web 与 Android 的隔离上传、编辑、文件撤权和本机采集分别保留本地证据。 [媒体回归](../../../qa/verify-results/combined-ocr-final-chrome-2026-11-24/browser.log) · [Android 离线听写](../../../clients/mobile/README.md#普通话离线听写调试构建)
- 5.5 的真实 OAuth 撤回和外部结果核实需要获准的连接器测试应用、审核后的授权范围及测试账号。6.9 和 6.10 的正式接入需要获准的商家沙箱或专项数据供应商。 [本地模拟边界与验收结果](../../../qa/assistant-sandbox-connector.md)
- 6.1 的正式企业登录、目录同步与组织账单需目标企业目录、授权测试账号和计费联调。6.2 的数据驻留、保留和正式预算需确定供应商、区域及运营边界。6.8 实时报价需已确认的目标市场与授权商品来源。 [本地组织登录](../../../qa/assistant-organization-sso.md) · [组织策略](../../../qa/assistant-organization-policies.md) · [合成报价目录](../../../qa/assistant-synthetic-catalogue.md)
- 3.11、7.1、7.2 和 7.3 的发行验收需要生产等价的规模、恢复目标、各渠道签名候选、测试资格和审核状态。已有隔离运行、恢复和本地候选报告作为后续联调基线。 [故障与恢复](../../../qa/assistant-resilience.md) · [发布自查](../../../docs/release/验收与风险审查.md) · [运行手册](../../../docs/release/本地候选版本与运行手册.md)
