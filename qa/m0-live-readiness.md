# M0 外部联调待验证项

资料核对日期为 2026 年 11 月 22 日。当前可复现范围是本机开发和合成数据验证，首发市场、发行渠道和付费预算尚待确认。地区和渠道的候选用于准备测试与估算成本。

## 地区与数据路径

| 场景 | 模型、搜索与语音候选 | 数据与发布证据 |
| --- | --- | --- |
| 本地开发 | 使用确定性合成文本。搜索、语音和视觉可各自准备固定样例 | 本地样例和日志用合成值。出网上游、外部账号和付费权益留待独立联调 |
| 中国大陆候选 | 阿里云百炼北京、火山方舟北京。基础文本选型后，按模型版本分别验证搜索引用、视觉输入、识别、合成和实时语音 | 确认服务主体、账号授权、模型和工具实际执行地区、存储区、供应商与子处理方、留存、删除和允许用途。确定适用备案或登记、生成内容标识、用户隐私及分发材料，再开对应入口 |
| 海外候选 | 按目标国家或地区核对可采购的区域模型、搜索和语音组合。OpenAI 仅在其官方支持范围内考虑 | 仍无已确认的目标地区或采购授权。选择地区后，再确认数据驻留、功能可用性、合同价、商店支持和外部测试人群 |

百炼北京文档将接入与存储地区、推理部署范围分别说明。2026 年 10 月 13 日及以后发布的北京模型默认采用中国弹性区范围。选型时记录目标模型及所用接入点的实际范围，并单独核对搜索与实时语音的数据路径。隐私说明和公开报价作为初筛证据，保留、删除和实际开通范围以对应产品与账户文件核验。 [百炼北京接入与部署范围](https://help.aliyun.com/en/model-studio/beijing-access-information) · [百炼隐私说明](https://help.aliyun.com/en/model-studio/privacy-notice) · [百炼联网搜索](https://help.aliyun.com/en/model-studio/web-search)

火山方舟有独立的数据面和鉴权要求，搜索、实时语音与模型调用需分别核对能力、权限和费用。方舟专用条款第 3.1 节涉及中国大陆使用范围及商业使用的事先书面许可，采购评审需核对实际服务订单和适用协议。按选定推理接入点确认数据投递和保留设置。 [方舟数据面与鉴权](https://docs.volcengine.com/docs/ark/base-url-and-authentication?lang=zh) · [方舟专用条款](https://console.volcengine.com/ark/region%3Acn-beijing/docs/volcengine-ark-platform-terms) · [方舟工具调用](https://console.volcengine.com/ark/region%3Acn-beijing/docs/responses-api-tool-calling) · [方舟数据回流](https://console.volcengine.com/ark/region%3Acn-beijing/docs/data-backflow-workflow) · [火山语音计费](https://docs.volcengine.com/docs/real-time-communication/conversation-ai-billing?lang=zh)

大陆公开发布前，由发布主体按实际服务形态核对属地网信备案或应用登记、模型名称和编号公示、AI 生成合成内容标识，以及 APP 备案及商店材料的适用性。海外模型选型依目标地区名单与供应商条款确认。 [生成式 AI 备案和登记公告](https://www.cac.gov.cn/2026-11/20/c_1796918603542950.htm) · [生成合成内容标识办法](https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm) · [工信部 APP 备案解读](https://wap.miit.gov.cn/zwgk/zcjd/art/2023/art_39b4f1acc36745b98478e0ec3e07128d.html) · [OpenAI 支持地区](https://help.openai.com/en/articles/7947663-chatgpt-and-openai-api-supported-countries-and-territories)

### 文本成本示例

统一用 1,000 个未缓存文本输入 token 和 500 个输出 token 估算。以下使用各平台的北京公开价和最短输入档，未计搜索、语音、图片、长上下文、缓存、重试及合同折扣。样例成本不构成报价或质量结论。

| 候选文本模型 | 输入 / 输出公开价（元/百万 token） | 每次样例调用估算 |
| --- | --- | --- |
| 百炼 `qwen3.7-flash-2026-07-15`，输入不超过 32K | 0.20 / 0.80 | 0.0006 元。 [百炼模型价格](https://help.aliyun.com/en/model-studio/model-pricing) |
| 火山方舟 `doubao-seed-2.0-mini` 家族，常规在线推理档，输入不超过 32K | 0.20 / 2.00 | 0.0012 元。 [方舟模型价格](https://console.volcengine.com/ark/region%3Acn-beijing/docs/model-pricing) |

用探针实际计量替换样例 token 数，另按真实调用量加入搜索、语音和图片费用，记录账单、报价日期、模型版本、计费档及峰值预算。报价或开通范围待确认的能力保持未验收。

## 供应商评测

[模型探针](m0-model-probe.mjs) 有 `text` 和 `vision` 两套固定题集。默认以进程内 SSE 夹具运行中文提取、多轮和 JSON 三道文本题。视觉题使用 64×64 的合成色块。指定 `dashscope` 或 `ark` 后，使用 `M0_MODEL_ID` 指定适用于本套题的模型，向对应北京接口发起流式请求。文本题中的结构化用例使用供应商的 JSON 对象模式，并按产品期望的结构判分。 [百炼流式接口](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/stream) · [百炼视觉接口](https://docs.modelstudio.console.alibabacloud.com/en/model-studio/vision) · [方舟视觉接口](https://api.volcengine.com/api-explorer/?action=ChatCompletionsVision&groupName=%E5%AF%B9%E8%AF%9D%28Chat%29+API&serviceCode=ark&version=2024-01-01) · [方舟结构化输出](https://docs.volcengine.com/docs/ark/structured-output-beta?lang=en)

报告记录题集哈希、请求和响应模型编号、首段可展示文本、SSE 终态、完整响应耗时与供应商返回的 token 用量。遇到 HTTP 限流或错误时记录状态与可用的重试提示。报告只保留结果和计量元数据。两家模型的结果用相同的 `fixtureSha256` 对照。

```powershell
node qa/m0-model-probe.mjs mock text
node qa/m0-model-probe.mjs mock vision
```

2026 年 11 月 24 日复跑，文本 3/3、视觉 1/1 均通过。两套报告保存于 [本机运行证据](verify-results/m0-readiness-2026-11-24/)。结果类型为 `synthetic-fixture`，模拟计量只供解析回归。本机未配置这两个候选的 API 令牌和模型 ID，真实调用仍待验证。

| 核验项 | 完成真实评测所需的证据 |
| --- | --- |
| 中文、多轮、结构化结果 | 两家用相同文本题集和请求设置。记录服务端返回的模型版本、请求编号、通过数和完整响应耗时 |
| 流式首字、限流与回退 | 用探针采集首段和完整响应耗时及 429 状态。对真实部署另验证超时、重试和符合地区策略的回退 |
| 视觉与语音 | 视觉题用探针提供的固定色块。语音需用同一段合成中文音频，分别记录识别、打断、延迟和用量计量 |
| 搜索与引用 | 选用固定无个人资料的公开来源，记录检索能力、来源可定位性和引用准确性。分别覆盖来源失效与搜索关闭后的行为 |
| 单位成本 | 保存各轮原始用量、调用次数、区域计费档和报价版本并对账。将合成数据、供给实测和故障注入分类记录 |

真实探针使用已开通的北京测试账号、已选模型 ID 和对应的 `DASHSCOPE_API_KEY` 或 `ARK_API_KEY`。配置后可执行 `node qa/m0-model-probe.mjs dashscope text` 或 `node qa/m0-model-probe.mjs ark vision`。真实语音、引用、回退及账单证据另行收集。

## 设备和发行环境

| 端 | 内部验证与发行候选 | 开放前仍需确认 |
| --- | --- | --- |
| Web | 先跑本地开发环境。远程内测待确认环境和访问范围 | 服务主体、域名、目标地区、访问策略和公开服务适用要求 |
| Android | 先在真机安装签名测试包，可为有对应发行权限的市场评估 Google Play 内部测试 | 目标渠道和国家或地区、签名、安装升级、测试账号及适用商店材料。 [Android 应用签名](https://developer.android.com/studio/publish/app-signing) · [Google Play 测试轨道](https://support.google.com/googleplay/android-developer/answer/9845334) |
| iOS 和 iPadOS | App Store Connect 中的 TestFlight 内部测试 | Apple 构建环境、平台账号与角色、设备、签名。大陆上架时核对 App Store Connect 要求的适用 ICP 备案号和资料。 [TestFlight 内部测试](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/) · [App Store Connect 应用信息](https://developer.apple.com/help/app-store-connect/reference/app-information/app-information/) |
| HarmonyOS NEXT | 开发者联盟文档列有 AppGallery 和 AppTest 邀请测试 | NEXT 设备、HDC、适用证书及 Profile、开发者账号、上架材料和渠道地区限制。需要真机证据确定 RNOH 或 ArkTS/ArkUI 路线。 [NEXT 邀请测试](https://developer.huawei.com/consumer/cn/doc/app/agc-help-invite-test-overview-0000002287701773/) · [HarmonyOS 发布签名](https://developer.huawei.com/consumer/cn/doc/HarmonyOS-Guides/ide-publish-app/) |
| macOS | 内部分发候选使用 Developer ID 签名及 Apple 公证流程 | Mac 构建环境、目标 CPU 架构、签名和公证账号、安装和升级。 [Apple Developer ID](https://developer.apple.com/developer-id/) · [macOS 公证](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution) |
| Windows | 内部评估签名 MSIX，公共发行渠道待确认 | 候选安装包、目标架构、设备信任的证书、安装与更新。 [MSIX 签名](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview) |

### 工具链基线与测试设备

| 端 | 构建或浏览器基线 | 现有证据与待验证设备 |
| --- | --- | --- |
| Web | Next.js 16 能力基线为 Chrome、Edge、Firefox 111+ 和 Safari 16.4+ | 已验证桌面 Chromium 和 API 36 的 Android Chrome。逐浏览器验证涉及 Safari、Firefox、最低版本与真实输入法。 [Next.js 16 浏览器支持](https://nextjs.org/docs/app/guides/upgrading/version-16#nodejs-runtime-and-browser-support) |
| iOS 与 iPadOS | Expo SDK 56 运行基线 16.4+，原生构建用 Xcode 26.4+ | 已通过 Hermes 导出。需要按候选范围选一台接近最低版本的 iPhone 和至少一台 iPad 安装签名包，复核密钥存储、后台恢复和升级。 [Expo SDK 56](https://docs.expo.dev/versions/v56.0.0/#support-for-android-and-ios-versions) |
| Android | Expo SDK 56 运行基线 Android 7+，构建和目标 API 36 | 本机调试 APK 的清单实测为 minSdk 24、targetSdk 36、x86_64。API 36 手机和平板模拟器已验证。接近最低支持版本的签名包、近期 ARM64 手机及实体平板或折叠屏待验收。 [Expo SDK 56](https://docs.expo.dev/versions/v56.0.0/#support-for-android-and-ios-versions) |
| HarmonyOS NEXT | 首个最低支持 API 随实机路线确认 | 工作站未检测到 HDC。需要同一组 NEXT 真机测试结果才能选择 RNOH 桥接或 ArkTS/ArkUI。 [HDC 使用说明](https://developer.huawei.com/consumer/en/doc/harmonyos-guides/hdc/) |
| macOS | Electron 45 运行基线 macOS 13+，构建目标 Apple silicon 和 Intel | 待取得两类签名构建及代表性设备，用正式包验证系统权限、信任与更新。 [Electron 系统版本变化](https://www.electronjs.org/docs/latest/breaking-changes/) |
| Windows | Electron 45 构建目标 x64、ARM64 | 可在 Windows x64 直接运行本地包。Windows x64 签名安装、ARM64 实机、旧版本升级和系统权限回归待验证。 [Electron 安装架构](https://www.electronjs.org/docs/latest/tutorial/installation) |

[工具链预检](m0-release-preflight.mjs) 探测本机工具、连接目标数量、Android 调试 APK 的 SDK 和架构、Windows 包架构和 Authenticode 状态。报告只记录候选评测环境变量是否齐备。预检结果用于定位联调条件。

```powershell
node qa/m0-release-preflight.mjs
```

2026 年 11 月 24 日，预检识别 Android API 36、一台在线模拟器和零台非模拟器目标。HDC 和 Xcode 不可用。Windows x64 可执行文件的实际 PE 架构和既有 SHA-256 记录一致，签名状态为 `NotSigned`，ARM64 本地包尚未生成。桌面安全策略测试 4/4 和本地包启动测试 1/1 均通过。 [桌面打包证据](../clients/desktop/README.md#打包和自测) · [移动端运行证据](../clients/mobile/README.md#android-验证记录)

## M0 放行复核

| 任务 | 当前证据与缺口 |
| --- | --- |
| 1.2 | 已保存候选模型、区域、搜索、语音、价格与渠道差异。待确认拟发行的实际市场、渠道、服务主体、适用材料和采购条件 |
| 1.3 | 文本与视觉题集的流式夹具通过。需要经授权的测试模型与账单，以及真实语音、引用和故障运行记录 |
| 1.4 | 缺少可联调 NEXT 设备、配套 HDC/DevEco 和签名测试资格。保持鸿蒙外部发布关闭 |
| 1.5 | Windows x64 单机启动与权限策略通过。待补 Windows 签名安装及升级、ARM64 和 macOS 设备、Developer ID 与公证 |
| 1.6 | 本机负载四并发首段 p95 为 2.75 秒，8 次运行无预期外错误。生产并发、质量、预算、RTO、RPO 和负责人员待根据发行范围、供给、真机及演练数据确认。 [本地负载证据](assistant-resilience.md#本机观测) |
| 1.10 | 后端启动、迁移、权限隔离和本地客户旅程已有证据。市场、供应商和真机门槛仍未通过，核心能力供给未确认的市场继续关闭 |

本机开发继续验收独立功能。正式发行需要补齐相应市场和渠道证据。 [OpenSpec 任务](../openspec/changes/build-cross-platform-ai-assistant/tasks.md)
