# 青屿助手移动端

Expo SDK 56 / React Native 0.85 客户端，共享根工程中的 TypeScript API 契约。支持账号登录、历史对话、流式生成、停止、编辑分支和重新生成。登录凭据存入系统安全存储。退出登录清除本地凭据与生成恢复点。

## 安装与自测

使用 Node.js 20.19.4、22.13.0 或同系列更新版本。在本目录安装依赖并运行检查。

```powershell
npm ci --prefix ../../packages/contracts
npm ci
npm run typecheck
npm run bundle:android
npm run bundle:ios
```

两个 bundle 命令输出 JavaScript 包。Android 安装、iOS 安装及发版需要对应的原生工具链。SDK 56 的 Expo CLI 及其构建期依赖仍有 npm 审计告警，升级后需重新验证 Expo Go 和构建链路。

已在 Windows 使用 Node.js 20.19.6 通过 TypeScript 检查，并成功导出 Android 和 iOS 的 Hermes 字节码。`expo install --check` 也已通过。2026 年 11 月 24 日再次通过 TypeScript 检查及两个平台的 Hermes 导出。iOS 原生安装、设备安全存储和后台恢复仍需用 macOS、Xcode 与真机验证。

## Android 本地验证

准备 SDK 56 版 Expo Go，启动 Android 模拟器与本机助手后端。后端需要启用账号注册和 `local-echo` 模型。

```powershell
adb reverse tcp:18080 tcp:18080
adb reverse tcp:3110 tcp:3110
$env:EXPO_PUBLIC_ASSISTANT_API_ORIGIN = 'http://127.0.0.1:18080'
npm start -- --go --localhost --port 3110
```

在模拟器打开 `exp://127.0.0.1:3110`。注册测试账号，发送消息并核对回复。发送较长消息后立即停止，确认生成终止。再次发送后将应用切到后台，再回到前台检查续流。强制停止并重启应用后确认账号仍登录、会话可以继续。测试结束退出账号。

如果 Windows 的 Metro 仅监听 IPv6 回环地址，可以先运行 `npm run contracts`，然后用 `node --dns-result-order=ipv4first .\node_modules\expo\bin\cli start --go --localhost --port 3110` 启动。

需要本地调试安装包时，用 SDK 56 模板生成 Android 工程，再使用 Android SDK 执行调试编译。

```powershell
npm run contracts
npx expo prebuild --platform android --no-install --template expo-template-bare-minimum@56.0.38
npx expo run:android --port 3110
```

### Android 验证记录

已在 Android API 36 的 x86_64 手机模拟器安装并启动调试 APK。早期测试包大小 45,948,154 字节，SHA-256 为 `afc6866e2d63a3e1af1f6423bb5d1f6b77959c8c79bfa83c46aed619bd4c59a8`，已保留独立快照。调试包从本机 Metro 加载应用代码，连接隔离后端的 `local-echo` 模型。 [早期调试包快照](.expo/read-aloud-2026-11-24/pre-read-aloud-debug.apk)

- 实测注册、退出后回到登录页、重新登录并从历史打开已保存的回复。Android 系统返回键可关闭历史面板并保留当前对话。
- 实测流式文字逐步显示。停止一条长回复后，界面显示「已停止生成」，部分回复保留且稳定。
- 在界面显示生成仍在进行时强制停止进程。重启后恢复登录和原对话，并读到测试模型约定的完整 2,048 字符回复。

手机调试包的构建日志和模拟器证据保存在 `.expo/`。

2026 年 11 月 24 日，使用同一调试 APK，在 Android API 36 x86_64 模拟器的 `sw1067dp` 平板尺寸和隔离后端复测。竖屏注册后，流式回复和历史可用。系统返回键关闭历史并保留当前回复，旋转横屏后可继续阅读和输入。生成期间强制停止应用并启动新进程，自动恢复登录和当前会话，最终回复与 2,048 字符的预期内容逐字一致。测试账号已退出。Android 平板真机和目标渠道的签名包安装或购买需要相应设备和渠道测试账号。 [平板复测结果](../../qa/verify-results/android-browser-2026-11-24/android-tablet-results.json) · [横屏](../../qa/verify-results/android-browser-2026-11-24/android-tablet-landscape.png) · [进程终止前](../../qa/verify-results/android-browser-2026-11-24/android-tablet-before-restart.png) · [重启后](../../qa/verify-results/android-browser-2026-11-24/android-tablet-after-restart.png)

### Pixel Tablet 硬件配置复测

使用 Android SDK 内置 Google `pixel_tablet` 硬件配置新建独立 AVD，运行 Android API 36 x86_64 系统镜像。Android 报告原生分辨率 2560 × 1600、320 dpi 和 `sw800dp`，竖屏与横屏均使用默认物理尺寸。实测注册、短回复、系统返回关闭历史面板，以及旋转后保留原回复和输入区。长回复生成时按 Home 切换到系统桌面，回到原进程后只显示一条回复，2,048 个字符与预期逐字一致。应用使用原生深色状态栏图标改善浅色背景上的可读性。 [布局](.expo/pixel-tablet-2026-11-24/pixel-tablet-landscape.png) · [后台前正在生成](.expo/pixel-tablet-2026-11-24/pixel-tablet-home-inflight.png) · [系统状态栏](.expo/pixel-tablet-2026-11-24/pixel-tablet-status-bar.png)

横屏软键盘打开时，输入区和发送按钮随界面上移。实测直接点按发送按钮后原生键盘收起。生成长回复期间强制停止进程，重新启动后自动恢复登录和原会话，最终只显示一条完整且逐字匹配的 2,048 字回复。合成账号已退出。当前代码通过 TypeScript 检查和 Android、iOS Hermes 导出。目标渠道签名包安装、购买和真机验收仍待相应设备与渠道账号。 [完整结果](.expo/pixel-tablet-2026-11-24/android-results.json) · [键盘打开时的布局](.expo/pixel-tablet-2026-11-24/pixel-tablet-keyboard.png) · [强制停止前](.expo/pixel-tablet-2026-11-24/pixel-tablet-restart-inflight.png) · [恢复后](.expo/pixel-tablet-2026-11-24/pixel-tablet-restart-restored.png)

### Android 手机布局和中文输入

2026 年 11 月 24 日，使用独立的 Medium Phone 配置验证 Android 手机端。该模拟器运行 Android 16、API 36、x86_64，竖屏 1080 × 2400、420 dpi，最小宽度 411 dp。Fcitx5 Android 实际拼音键盘生成并提交了「你好」候选。点系统软键盘返回键后，输入内容保留。点发送后产生一条消息，收到同一文本的模拟回复。打开历史面板再按系统返回后，仍停留在该对话。 [手机配置和包类型](../../qa/verify-results/android-phone-2026-11-24/device-build.json) · [拼音候选](../../qa/verify-results/android-phone-2026-11-24/phone-ime-candidate.png) · [返回后的对话](../../qa/verify-results/android-phone-2026-11-24/phone-after-system-back.png)

长回复正在输出时停止 Android 应用进程。重启后自动打开同一运行，在事件序号 62 接续，从 63 开始接收，最后只显示一份完整的 2,048 个字符的回复。用另一登录会话直接调用 API，重放同一提交键仍返回原运行和消息。相同键改写请求返回 409，完成事件只回放一次，三轮会话合计六条消息、4,105 个已结算码点且预留为零。后端用同一数据库和撤权日志重启后复核通过。 [中断时的回复](../../qa/verify-results/android-phone-2026-11-24/phone-inflight-before-kill.png) · [重启恢复](../../qa/verify-results/android-phone-2026-11-24/phone-cold-recovery.json) · [运行及用量核对](../../qa/verify-results/android-phone-2026-11-24/same-run-api-results.json) · [服务重启后核对](../../qa/verify-results/android-phone-2026-11-24/same-run-after-api-restart.json)

首次启动模拟器时，Android 系统界面出现了一次无响应提示，选择等待后恢复。调试提示首次覆盖发送按钮，提示消失后复测只发出一条请求。 [键盘收起后的调试提示](../../qa/verify-results/android-phone-2026-11-24/phone-ime-soft-back.png)

测试通过 ADB 安装 v2 签名的 Android Debug 包。应用包声明最低 API 24、目标 API 36。本次验收使用 API 36 模拟器。实体手机、其他受支持的 Android 版本、发行签名、商店安装与购买仍待验收。 [APK 签名核验输出](../../qa/verify-results/android-phone-2026-11-24/debug-apk-cert.log) · [Android apksigner](https://developer.android.com/tools/apksigner)

### 流式列表与手机浏览器复测

2026 年 11 月 22 日，历史分支和已存消息行复用稳定的列表数据，流式文本和跟随滚动按显示帧合并更新。SSE 事件序号仍在接收时记录，后台恢复及停止可使用最新快照。Node.js 20.19.6 上的 TypeScript 检查、Android 及 iOS Hermes 导出通过。

使用同一调试 APK 加载新 Metro 代码，在 API 36 x86_64 模拟器复测注册、发送、历史系统返回、退出后重新登录、长回复停止和进程重启。停止后部分答复保持稳定，进程重启后回到原对话并恢复完整的 2,048 个字符。调试日志仍记录 `VirtualizedList` 的滚动间隔提示，该提示依据连续滚动事件的间隔与内容长度。发布包的帧时间仍需在目标真机上测量。证据位于 `.expo/android-optimized-runtime.log`。

同一模拟器的 Android Chrome 133.0.6943.137 通过主机回环别名访问 Web 生产构建。合成账号注册、发送并读取回复、开关移动历史侧栏和退出均通过。首次测试用竖屏与 ADB 文本输入，证据位于 `.expo/android-chrome-smoke.json` 与 `.expo/android-chrome-reply.png`。11 月 24 日复测补充了 Android 系统拼音输入法、键盘快捷操作、125% 缩放、断网与后台恢复以及 Markdown 下载。 [跨浏览器自测](../../qa/assistant-web-platform.md) · [Android 模拟器网络](https://developer.android.com/studio/run/emulator-networking-address)

## 后台导出任务

服务端为当前账号开放 `background_tasks` 后，可从已有对话的「后台导出」提交当前已保存的分支。历史侧栏中的「后台任务」会显示本账号的状态与进度，进行中的任务可取消。关闭面板后，服务端继续处理任务。完成后，用同一账号登录网页版，在「后台任务」中下载 Markdown。 [服务端与 Web 验收](../../qa/assistant-jobs.md)

2026 年 11 月 22 日，使用既有调试 APK 与更新后的 Metro 代码，在 Android API 36 模拟器连接开放任务的独立后端。实测提交当前分支、取消进行中的任务、另一次任务完成至 100%、重新打开后确认两条任务状态、显示网页版下载入口提示及退出登录。移动 TypeScript 和 Android/iOS Hermes 导出通过。模拟器证据位于 `.expo/android-background-jobs.json`，iOS 设备交互待实测。

## 临时对话

测试服务开放 `temporary_chat` 时，登录后可从输入区上方打开「临时对话」。每条消息最多 512 个 Unicode 码点，测试服务使用本地模拟模型仅处理当前消息。窗口只显示最近一轮结果，应用不会将临时内容写入历史、记忆或本地安全存储。关闭窗口、切到后台或移除当前账号及工作空间的界面时，临时内容随窗口清除，进行中的请求会中止等待。 [AppState](https://reactnative.dev/docs/appstate)

2026 年 11 月 24 日，在 Android API 36 手机模拟器用调试 APK 连接打包测试 API。连续发送两条临时消息后只显示后一轮。513 个 ASCII 码点触发长度提示并禁用发送，512 个完整往返。关闭、系统返回和退到后台后，重开窗口为空。生成中退到后台并等待超过预期回复时间，回到应用时仍没有恢复临时内容。普通历史保持为空，测试账号正常退出。TypeScript 检查与 Android、iOS 的 Hermes 导出通过。iOS/iPadOS 设备交互和移动端工作空间切换仍需实际入口及环境验收。 [Android 结果](.expo/temporary-chat-2026-11-24/android-results.json) · [退到后台前的生成状态](.expo/temporary-chat-2026-11-24/request-pending-before-background.png) · [回到应用后重开的空窗口](.expo/temporary-chat-2026-11-24/empty-after-background.png)

## 私有项目图像

服务开放 `project_attachments` 时，从输入区上方打开「项目图像」，选择已有项目或创建项目。通过系统文件选择器选择 1 MiB 以内的 PNG。上传后可刷新隔离扫描状态，扫描通过后可以选择设备上的目录并保存。上传中可取消等待，并用同一选择重试。删除会撤回服务上的访问，用户已经保存到设备的副本由用户管理。 [Expo SDK 56 FileSystem](https://docs.expo.dev/versions/v56.0.0/sdk/filesystem/) · [服务端隔离与撤权](../../qa/assistant-png-attachments.md)

2026 年 11 月 24 日，使用现有 Android API 36 调试 APK、私有 S3、ClamAV 与打包 API，实测创建和选择项目、取消系统文件及目录选择、隔离扫描、选择保存位置和撤回。保存的 70 字节 PNG 与合成样例逐字节一致。另延迟一条已被服务端接收的上传响应，确认客户端取消等待会关闭该请求，重新提交沿用同一请求标识并返回同一附件，列表只显示一份。撤回后刷新，已撤回附件的保存操作消失，设备上此前保存的副本保留。Android 系统返回、退出、TypeScript 检查及 Android、iOS Hermes 导出均通过。iOS/iPadOS 的系统选择器和保存交互仍待设备验收。 [Android 结果](.expo/project-images-2026-11-24/android-results.json) · [重试记录](.expo/project-images-2026-11-24/delay-attachment-response.log) · [保存在设备上的图像](.expo/project-images-2026-11-24/saved-native-image.png)

### 拍照上传私有 PNG

打开项目后点击「拍照」，按系统提示授权相机。拍摄只调用后置相机。照片在设备上缩放并编码为 PNG，文件须为 1 MiB 以内。点按「上传 PNG」前可以预览、清除或重拍。上传后的图像仍需通过私有隔离扫描。相机权限被拒绝或无法启动时，可以继续通过系统选择 PNG。应用的原生相机配置禁用了音频录制和条码扫描。 [Expo Camera](https://docs.expo.dev/versions/v56.0.0/sdk/camera/) · [Expo ImageManipulator](https://docs.expo.dev/versions/v56.0.0/sdk/imagemanipulator/)

2026 年 11 月 24 日，使用官方 Expo Go 56.0.4 和 Android API 36 的 Pixel Tablet 后置软件相机实测权限拒绝后重新授权、预览、系统返回取消、拍摄后清除及重拍。确认上传前刷新项目，服务端列表保持为空。手动上传后，隔离扫描通过一张 752 × 1024 像素的 PNG，附件只出现一次，撤回后刷新列表为空。只读诊断显示拍摄产生一份待传缓存，清除或上传成功后缓存归零，转换中间目录在各次检查时均为空。当前代码通过 TypeScript 和 Android、iOS Hermes 导出。独立安装包需重新生成包含相机模块的原生工程，iOS/iPadOS 相机和签名包仍待设备验收。 [相机验收](.expo/camera-2026-11-24/android-results.json) · [上传前预览](.expo/camera-2026-11-24/camera-png-before-upload.png) · [扫描通过](.expo/camera-2026-11-24/camera-scanned.png) · [缓存计数](.expo/camera-2026-11-24/cache-counts.json)

## 项目文本资料

服务开启 `project_resources` 后，从「历史」进入「项目文本资料」，打开自有项目。通过系统选择一个 16 KiB 以内的 UTF-8 `.txt` 文件，再点「导入到项目」提交。资料可按名称或正文搜索，`%`、`_`、`!` 按普通字符匹配。正文按纯文本显示。可选择设备目录保存 TXT，删除前需要确认。 [文本接口与恢复验收](../../qa/assistant-project-resources.md) · [Expo 文件选择与读取](https://docs.expo.dev/versions/v56.0.0/sdk/filesystem/)

回到前台时会重新检查访问权限，只有通过后才显示正文。保存到设备前会再次检查该资料的读取权限。Android 从系统选中的文件读取，关闭读取句柄后仅保留内存中的导入内容。iOS 系统选择器可能产生临时副本，应用只尝试清理可确认位于本应用缓存目录内的副本。

2026 年 11 月 24 日，Pixel Tablet API 36 模拟器与隔离测试服务通过文件取消、无效 UTF-8、空白文本、超限、显式导入、字面量搜索、选择目录、逐字节导出及撤权检查。授权接口不可用时，回到前台不显示旧正文，选择保存目录后授权超时也没有写入文件。TypeScript 和 Android、iOS Hermes 导出通过。iOS/iPadOS 设备交互和签名包仍待验收。 [Android 结果](.expo/project-text-2026-11-24/android-results.json) · [文本导入](.expo/project-text-2026-11-24/tablet-native-utf8.png) · [授权超时](.expo/project-text-2026-11-24/tablet-export-timeout.png)

## 项目音频 WAV

Android 从「历史」进入「项目音频」。选择自有项目后，可导入最长 30 秒且不超过 1 MiB 的 16 位 PCM WAV，支持 8–48 kHz 的单声道和双声道。系统文件选择器返回后，应用检查格式并显示待上传文件的名称和规格。确认上传后，服务器隔离扫描并清理 WAV 容器的附加元数据。扫描通过的音频可以查看波形并保存为 WAV。

选择设备目录后，应用核对当前附件权限再申请一次性下载授权。附件撤回后，应用清除波形，并拒绝继续保存。取消等待后可以用同一文件重试，操作沿用原有上传标识。切到后台或离开项目会清除未提交的选择和波形。

2026 年 11 月 24 日，Pixel Tablet API 36 模拟器拦截了非法编码、超时长和超容量的选中文件。取消选择及取消上传确认均未发起上传。模拟响应丢失后，取消等待并重试仍使用相同上传标识和字节，只生成一个附件。隔离扫描后的 65,580 字节 WAV 与设备保存的文件逐字节一致。实测跨账号和跨项目拒绝访问、一次性授权、后台清除波形、前台撤回清除，以及选目录期间撤回后没有下载或写入。TypeScript、Android 和 iOS Hermes 导出通过。WAV 项目入口的运行验收覆盖 Android 调试模拟器。 [Android 结果](.expo/project-wav-2026-11-24/android-results.json) · [上传确认](.expo/project-wav-2026-11-24/android-confirm-private-upload.png) · [波形](.expo/project-wav-2026-11-24/android-preview-waveform.png) · [保存期间撤权](.expo/project-wav-2026-11-24/android-revoked-wave-during-folder.png)

### Android 本机录音

在 Android 10 及以上的原生应用中，从「历史 → 项目音频」进入自有项目，点「开始本机录音」，按系统提示授权麦克风。录音采用 16 kHz、16 位、单声道 PCM，最长 30 秒。「结束录音」留下当前项目的内存草稿，可选择试听、丢弃或上传。只有在上传对话框中再次确认，录音才进入既有的私有隔离扫描流程。 [Android AudioRecord](https://developer.android.com/reference/android/media/AudioRecord) · [Android AudioTrack](https://developer.android.com/reference/android/media/AudioTrack)

切到后台、离开项目、断网或撤销设备权限会结束录音及清除草稿。麦克风未授权时，仍可使用 WAV 文件选择器。暂存在本机的录音草稿随页面会话结束而清除。 [Android 麦克风行为](https://developer.android.com/media/platform/sharing-audio-input)

2026 年 11 月 24 日，Pixel Tablet API 36 调试模拟器通过系统权限拒绝和授予、主动结束、应用内试听、退到后台、切换项目、真实断网及系统撤销。模拟器关闭宿主麦克风，使用低幅度虚拟输入。录到上限后自动停止。用户确认后只发出一次上传，ClamAV 扫描通过，独立核对到 29.968 秒、959,020 字节的规范 WAV。Android 原生 Lint、调试包、移动 TypeScript、Android 和 iOS Hermes 导出通过。实体设备的语音质量和签名包仍待验证。 [Android 权限与试听](../../qa/verify-results/project-recording-android-2026-11-24/permission-audition.json) · [权限与网络撤销](../../qa/verify-results/project-recording-android-2026-11-24/privacy-results.json) · [WAV 扫描结果](../../qa/verify-results/project-recording-android-2026-11-24/canonical-recording.json) · [模拟器麦克风设置](https://developer.android.com/studio/run/emulator-extended-controls)

## 项目 PDF 文本

Android 从「历史」打开「项目 PDF」并选择自己的项目。系统文件选择器一次接收一个 32 KiB 以内的文件。默认支持单页无压缩 PDF 1.4 文本。服务启用 `project_general_pdf` 时，也可选择含文本层的多页或压缩 PDF，最多 8 页。选中后可检查文件名与大小，再确认上传。 [PDF 文本规范和权限](../../qa/assistant-project-pdf.md)

服务完成隔离扫描和文本提取后，应用可显示最多 4 KiB 的 UTF-8 纯文本。切入后台会清除预览，返回后重新核对权限。选择保存目录后，应用复核授权，再将文本原始字节保存为 `extracted.txt`。关闭通用提取但保留基础 PDF 功能时，已通过扫描的 Unicode 文本仍可读取和保存，之后的上传遵循基础规范。关闭 PDF 功能时，已有附件仍可查看处理状态或删除。加密文档和版式预览仍待支持。

服务启用 `project_pdf_ocr` 时，可尝试识别单页扫描件。列表和预览会提示 OCR 结果可能有误，请对照原件核对。保存前需要明确确认，取消可留在项目里，应用不会打开目录选择器。保存的纯文本保留中英文提示，提示计入 4 KiB 文本上限。

2026 年 11 月 24 日，Pixel Tablet API 36 调试模拟器使用系统选择器验证了取消、超限和错误文件头拦截。明确确认后上传 656 字节的基础 PDF，真实 ClamAV 扫描通过后显示字面文本。64 字节的 `extracted.txt` 与规范文本逐字节相同。选择保存目录期间撤回附件，应用未写入文件，旧授权也无法兑换。移动端 TypeScript 和 Android、iOS Hermes 导出通过。iOS 设备交互和签名包仍待验收。 [Android 验收](../../qa/verify-results/project-pdf-android-2026-11-24/android-online-results.json) · [文本预览](../../qa/verify-results/project-pdf-android-2026-11-24/android-literal-text.png) · [保存期间撤回](../../qa/verify-results/project-pdf-android-2026-11-24/android-revoked-during-directory.png)

使用同一隔离数据库关闭 PDF 功能重启后，Android 保留已有的扫描状态和删除操作。上传、预览及导出入口随能力关闭。共用该界面的 WAV 文件仍通过原生选择、隔离扫描、波形预览和删除。 [停用 PDF 后的 Android 验收](../../qa/verify-results/project-pdf-android-2026-11-24/android-disabled-results.json) · [WAV 波形](../../qa/verify-results/project-pdf-android-2026-11-24/android-wav-regression.png)

同一调试模拟器也验证了两页压缩 PDF 1.7 的系统文件选择、超限拦截和二次确认。一次上传经 ClamAV 和隔离提取器处理后，Android 显示带重音的字符和原样的标签文本。导出的 51 字节文件与预期 UTF-8 逐字节一致。仅关闭通用提取并重启服务后，已有文本仍能预览和原样导出，新选的 PDF 1.7 在设备上被拒绝。选择保存目录时撤回权限，目录保持为空，已发出的授权失效。4 项输入与文本校验测试、严格 TypeScript、Android 和 iOS Hermes 导出通过。 [Android 验收](../../qa/verify-results/general-pdf-android-2026-11-24/android-results.json) · [通用 PDF 预览](../../qa/verify-results/general-pdf-android-2026-11-24/android-enabled-literal.png) · [恢复基础规范后的文件校验](../../qa/verify-results/general-pdf-android-2026-11-24/disabled-device-bytes.json) · [构建结果](../../qa/verify-results/general-pdf-android-2026-11-24/build-results.json)

单页中英文合成扫描件通过 Android 系统文件选择、ClamAV 和隔离 OCR。预览显示识别来源，确认后保存的 159 字节与带中英文提示的服务端文本逐字节一致。取消确认、系统返回、退到后台或取消目录选择均未获取下载授权。仅关闭 OCR 并重启后，已识别文本仍保留提示和保存确认。选择目录期间撤回附件后，旧授权失效，目录保持为空。6 项 PDF 专项测试、严格 TypeScript、Android 和 iOS Hermes 导出通过。 [OCR 实测](../../qa/verify-results/pdf-ocr-android-2026-11-24/android-results.json) · [保存确认](../../qa/verify-results/pdf-ocr-android-2026-11-24/android-ocr-confirmation.png) · [撤回](../../qa/verify-results/pdf-ocr-android-2026-11-24/android-ocr-revoked.png) · [构建结果](../../qa/verify-results/pdf-ocr-android-2026-11-24/build-results.json)

## 接续研究任务

服务开放 `curated_research` 时，从输入区上方打开「研究任务」。选中当前账号和工作空间中已保存的计划，可查看问题、来源、版本和状态。确认和取消会提交界面显示的版本。版本或来源变化时，刷新核对后可重新操作。报告可用后，先选择设备上的目录，再下载该版本的 UTF-8 文本报告。

2026 年 11 月 24 日，在 Android API 36 模拟器用现有调试 APK 连接打包测试 API。第二个消费者会话改动来源后，Android 对版本 1 的确认被拒绝，后端仍保留待确认的版本 2。刷新显示新的来源后，Android 明确确认版本 2。终止并重启 Android 进程后读到已完成报告。另一项任务通过系统确认对话框取消。取消目录选择未产生文件，确认保存目录后得到的 294 字节 UTF-8 报告与同版本 API 响应逐字节一致，只包含修改后的审核来源。Android 返回与退出、TypeScript 检查、Android 和 iOS Hermes 导出通过。iOS/iPadOS 的设备交互及签名包验收仍待测试。 [Android 结果](.expo/research-2026-11-24/android-results.json) · [旧审批被拒绝](.expo/research-2026-11-24/research-stale-approval.png) · [已保存报告](.expo/research-2026-11-24/android-research-report.txt)

同日通过三端会话接续测试。原 Chrome 会话创建并确认版本 1。后端报告任务正在执行后，独立 Chrome 会话修改要求和来源，生成待确认的版本 2。旧审批返回 HTTP 409，审批前两个版本均无法下载。Pixel Tablet API 36 独立登录并通过系统确认框批准版本 2。原 Chrome 会话重新打开同一任务，下载的 294 字节报告与授权 API 响应逐字节一致，只包含版本 2 批准的陈述和引用。Android 也刷新到了完成状态。测试会话已退出，合成账号已删除。 [跨端结果](.expo/research-handoff-2026-11-24/handoff-results.json) · [Android 版本确认](.expo/research-handoff-2026-11-24/android-confirm-v2.png) · [Chrome 完成状态](.expo/research-handoff-2026-11-24/chrome-completed-v2.png) · [引用题集](../../qa/verify-results/research-handoff-2026-11-24/citations.log)

## 站内定时提醒

服务开放 `scheduled_reminders` 时，从输入区上方打开「定时提醒」。新建计划时填写本地日期时间和 IANA 时区，选择一次、每日或每周，并可设定跨午夜的静默时段。提醒计划可暂停或恢复。「送达记录」显示当前账号及工作空间中的站内送达和过期结果，并可把未读提醒标为已读。 [日历规则与服务端验收](../../qa/assistant-reminders.md)

2026 年 11 月 24 日，Android API 36 模拟器连接打包服务验证了非法日期与非 IANA 偏移量提示、`Asia/Shanghai` 每日计划和 22:00–07:00 静默区间、暂停、刷新、恢复及进程重启。Android 创建的一次性计划在实际 UTC 整分只投递一次，标为已读后刷新仍保留状态。隔离数据库中另一条刻意设置为逾期的合成计划经真实 Worker 处理后显示已过期。切换账号后，计划和送达记录均为空，两个测试账号已退出。TypeScript 与 Android、iOS Hermes 导出通过。iOS/iPadOS 的原生交互及设备推送仍需相应环境。 [Android 结果](.expo/reminders-2026-11-24/android-results.json) · [真实送达](.expo/reminders-2026-11-24/reminder-delivered.png) · [已读回查](.expo/reminders-2026-11-24/reminder-marked-read.png) · [过期样例](.expo/reminders-2026-11-24/reminder-expired.png)

## 主动助手

支持本地主动助手的服务开放 `local_proactive_assistant` 后，Android 从「历史」进入「主动助手」。新账号默认关闭。启用开关、核对提醒或规划日程角色、站内通知或静音、IANA 时区和可选静默时段，都在点击「保存主动助手设置」后生效。

建议来自当前工作空间内已有的提醒。用户可忽略建议，也可打开对应的提醒计划或送达记录。主动助手会在后台清除未保存的设置和已显示的建议，返回前台时重新读取当前账号和工作空间的设置。关闭主动助手后停止显示和生成建议，已有提醒由「定时提醒」页面管理。

2026 年 11 月 24 日，Pixel Tablet API 36 从默认关闭开始验证主动助手。未保存的选择在后台被丢弃，非法时区和静默时段在本地被拦截。切断接口连接会清除设置和建议，重新连接后需授权读取。静音和当前生效的静默时段均抑制了来自实际送达提醒的建议。两种建议分别打开提醒计划和未读送达记录。忽略结果在重启后生效，关闭后建议列表清空，仍可在定时提醒中查阅原计划和未读送达。375 dp 竖屏视口和放大字体下可滚动到保存按钮。TypeScript、Android 和 iOS Hermes 导出通过，实际运行验收覆盖 Android 调试模拟器。 [Android 验收结果](.expo/proactive-2026-11-24/android-results.json) · [规划建议](.expo/proactive-2026-11-24/android-planning-suggestion.png) · [未读送达记录](.expo/proactive-2026-11-24/android-calendar-history-fallback.png) · [窄屏和放大字体](.expo/proactive-2026-11-24/android-small-viewport-large-text.png)

## 学习模式

登录后从「历史」进入「学习模式」。学习页列出图表数值与编号选项，输入答案序号即可查看分数和逐题讲解。可以导入相同格式的课程 JSON。课程与作答由当前设备处理。 [Web 学习模式与文本回退](../../qa/assistant-learning.md)

2026 年 11 月 24 日，在 Android API 36 的 Pixel Tablet 硬件配置上启动已登录的调试应用，关闭模拟器的 Wi-Fi 和蜂窝数据，并解除助手服务转发后打开学习模式。实测文本图表完整显示 4、7、6 三个数值，提交空答案后提示第 1 题并将焦点移到对应输入框，输入 2、2 得到「答对 2 / 2 题。」与两条讲解。系统返回键和「返回历史」均可回到历史列表。 [Android 离线结果](.expo/learning-2026-11-24/android-results.json) · [文本图表](.expo/learning-2026-11-24/android-offline-chart.png) · [测验得分](.expo/learning-2026-11-24/android-offline-grade.png)

## Android 本机朗读

当前设备有与中英文回复匹配的系统离线语音时，已完成的普通助手回复可点按「本机朗读」。原生模块在播放前读取系统语音的安装状态和网络需求标记，并显式选定系统报告可以离线使用的语音。Android 可以在服务断开后重新绑定，因此检测到非系统语音引擎时会隐藏入口。没有匹配语音或超过系统单次播放长度时，可继续阅读和选择回复文字。此功能不请求麦克风权限。 [Android Voice API](https://developer.android.com/reference/android/speech/tts/Voice) · [Android TextToSpeech](https://developer.android.com/reference/android/speech/tts/TextToSpeech)

点按「停止朗读」、打开历史等弹窗、切换会话或分支、退出账号、切到后台或滚动使当前回复离开屏幕时，会停止当前播放。重新返回界面需再次点按才会播放。原生模块通过项目的 SDK 56 Android 构建接入。旧调试包、Expo Go 和 iOS 保留文字回复。 [Expo 本地模块](https://docs.expo.dev/modules/get-started/)

2026 年 11 月 24 日，用于朗读验收的 Android 调试 APK 在 Pixel Tablet API 36 模拟器上通过安装，清单包含 TTS 服务可见性且无麦克风权限。关闭 Wi-Fi 和蜂窝数据并解除助手服务转发后，确认 Android 系统语音产生 24 kHz 语音播放轨。实测正常结束、手动停止、历史弹窗、切到系统桌面、切换会话，以及在同一会话中把当前回复滚出屏幕。停用模拟器的系统语音服务后，重启应用仍可查看原回复，朗读入口隐藏。TypeScript、Kotlin 编译及 Android、iOS Hermes 导出通过，原生模块的 Android Lint 报告无问题。真机音频切换、实时语音、转录及 iOS 音频仍需另外验收。 [Android 结果](.expo/read-aloud-2026-11-24/android-results.json) · [离线朗读](.expo/read-aloud-2026-11-24/android-offline-speaking.png) · [滚动停止](.expo/read-aloud-2026-11-24/android-scrolled-away-stops.png) · [无语音时的文字回退](.expo/read-aloud-2026-11-24/android-no-local-engine.png)

## Android 本机听写

默认构建从 Android 12 起调用系统端侧识别接口。Android 13 及更新版本还会检查系统语言对应的离线模型是否已安装。点击「本机听写」时才请求麦克风权限。预览中的识别片段保留在听写界面，结束后把最终文本追加到原草稿。可以继续修改文字，点按「发送」才提交。取消、离开当前会话、打开弹窗或进入后台会结束听写并丢弃未确认的结果。没有端侧识别器、语言模型或权限时，可以直接输入文字。麦克风权限由独立的听写模块声明，项目相机继续只拍摄照片。 [Android SpeechRecognizer](https://developer.android.com/reference/android/speech/SpeechRecognizer) · [Android RecognitionSupport](https://developer.android.com/reference/android/speech/RecognitionSupport)

2026 年 11 月 24 日，Pixel Tablet API 36 模拟器的系统端侧识别器报告当前语言没有已安装或可用的离线模型。实测原始调试包隐藏听写入口，保留文字输入，启动时不请求麦克风。独立测试只替换语言目录，真实原生模块在用户拒绝及恢复授权后仍能发现模型缺失，保留原草稿，Android AppOps 未记录麦克风使用。完整 Android 调试构建、原生模块 Android Lint、TypeScript 和 Android、iOS Hermes 导出通过。真实音频转写仍需有可用端侧模型的设备验收。 [原生无模型回退](.expo/dictation-2026-11-24/native-no-model.json) · [原生权限与模型检查](.expo/dictation-2026-11-24/native-guard-permission.json)

在隔离调试环境中，测试适配器提供模拟识别事件，未采集音频。关闭网络后验证了片段预览、手动结束、取消后忽略迟到结果、进入后台或打开历史后停止、最终结果追加至原草稿。编辑后的文字经手动点按「发送」，收到了隔离后端的逐字回显。Android 实际撤回麦克风权限后终止了运行进程。恢复原始调试代码并重新启动后，应用恢复原会话，先前的听写结果未进入草稿。 [完整验收记录](.expo/dictation-2026-11-24/android-results.json) · [模拟听写回归](.expo/dictation-2026-11-24/fixture-workflow.json) · [权限撤回](.expo/dictation-2026-11-24/permission-revoke.json)

### 普通话离线听写调试构建

Android 调试包可以显式加入普通话端侧模型。Android 13 及更新版本优先使用已经安装且匹配简体普通话的系统模型，缺少时使用调试包内的模型。Android 12 的系统接口无法查询已安装的语言包，选择简体普通话且已配置调试模型时使用包内模型。该调试路径支持 Android 10 及以上的 `arm64-v8a` 和 `x86_64`。默认调试构建和发布构建继续使用系统端侧识别。 [Android RecognitionSupport](https://developer.android.com/reference/android/speech/RecognitionSupport)

从[资源清单](modules/local-dictation/android/mandarin-assets.json)下载固定版本的两个官方压缩包，用 Python 3.11 及以上校验并解包到项目目录之外。Gradle 会再次核对文件大小和 SHA-256。模型仅随选择此配置的调试包打包。以下命令适用于已准备好 Android 构建依赖的环境。

```powershell
python modules/local-dictation/android/prepare-mandarin.py --aar "<本地AAR>" --model "<本地模型压缩包>" --output "<新建的外部目录>"
cd android
.\gradlew.bat --offline "-PqingyuOfflineMandarinDir=<外部目录绝对路径>" "-PreactNativeArchitectures=x86_64" :app:assembleDebug
```

点击「本机听写」并授权后，应用在人机交互期间把单声道 16 kHz PCM 按块送入本机模型，最长 30 秒。取消、后台切换、草稿目标切换或麦克风撤权会停止采集。手动结束后，当前识别文本可以在消息输入框修改，由用户决定何时发送。

模型和 sherpa-onnx 源码采用 Apache 2.0。调试构建引用的官方预构建库还包含其他语音功能的符号。对外发布需使用只含识别能力的构建并核对其第三方许可与归因。 [sherpa-onnx 2.0.3 许可证](https://github.com/k2-fsa/sherpa-onnx/blob/v2.0.3/LICENSE) · [模型许可](https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-small-ctc-zh-int8-2025-04-01/tree/763e4e5) · [上游构建选项](https://github.com/k2-fsa/sherpa-onnx/blob/v2.0.3/CMakeLists.txt)

2026 年 11 月 24 日，独立 Pixel Tablet API 36 x86_64 调试模拟器关闭宿主麦克风和设备无线网络，并解除助手 API 转发。通过已认证的回环模拟器接口注入合成普通话，走实际 Android 麦克风采集和本机解码。手动结束后识别对 18/19 个字，片段预览未改变草稿，最终文字可编辑且未创建会话。30 秒上限会结束麦克风采集。取消已有识别片段、切到后台和撤回 Android 麦克风 AppOps 均释放了麦克风并保留原草稿。默认和启用模型的调试包均离线构建成功，默认包无模型文件。此 x86_64 调试包增加 48,610,279 字节。严格 TypeScript、原生模块 Lint 和 Android/iOS Hermes 导出通过。 [模拟器证据](../../qa/verify-results/offline-mandarin-android-2026-11-24/android-positive.json) · [退出和撤权](../../qa/verify-results/offline-mandarin-android-2026-11-24/android-lifecycle.json) · [构建证据](../../qa/verify-results/offline-mandarin-android-2026-11-24/build-results.json) · [模拟器接口](https://developer.android.com/studio/run/emulator-console)

同一条 7.767 秒合成语音在无外部网络的 WSL x86_64 中单核运行时，两种模型均识别对 19 个字。sherpa-onnx 解码约 0.42 秒、进程峰值约 106 MiB，Vosk 约 2.46 秒、168 MiB。指标来自单条合成样例。实体 ARM64 设备的资源占用、真实口音与噪声下的准确率及签名发布包仍需验收。 [sherpa-onnx 结果](../../qa/verify-results/offline-mandarin-android-2026-11-24/sherpa-huihui-result.json) · [Vosk 结果](../../qa/verify-results/offline-mandarin-android-2026-11-24/vosk-huihui-result.json) · [Vosk 模型目录](https://alphacephei.com/vosk/models)

在保留调试模型参数的配置下，`:local-dictation:bundleReleaseAar` 构建通过。检查归档及 24 个编译类，Release 库仅包含系统听写实现，模型、Sherpa 引用和 JNI 均未进入归档。 [Release 模块验收](../../qa/verify-results/offline-mandarin-android-2026-11-24/android-release-module.json)

## 共享文稿

服务同时开放 `project_collaboration` 和 `project_shared_drafts` 时，从「历史」进入「共享文稿」。可切换到账号实际加入的工作空间、接受项目邀请，读取项目内可见的 Markdown 原文和历史版本。文稿按纯文本显示。编辑者和所有者可在桌面网页版编辑。

移动端正文只保留在当前页面内存中。切到后台会清除已显示的正文，回到前台时重新核对当前权限。详情页在前台每 15 秒再次核对权限。服务拒绝访问或核对失败时清除正文。

2026 年 11 月 24 日，使用 Pixel Tablet API 36 模拟器和隔离服务验证了原生登录、工作空间切换、邀请接受、中英文和 emoji 的新旧版本读取、文本显示、撤权后清除已打开内容、编辑者入口提示及退出后冷启动。授权接口不可用时，回到前台未显示旧正文。恢复授权接口并重新读取后显示同一历史版本。移动端 TypeScript 和 Android、iOS Hermes 导出通过。iOS/iPadOS 原生交互和签名包仍待验收。 [Android 结果](.expo/shared-drafts-2026-11-24/android-results.json) · [历史版本](.expo/shared-drafts-2026-11-24/tablet-viewer-revision-one.png) · [撤权后清除](.expo/shared-drafts-2026-11-24/tablet-viewer-revoked.png)

## 项目发布的 PNG

Android 登录后从「历史」进入「项目发布」。选择账号实际加入的工作空间并接受邀请后，可打开对应项目的已发布 PNG。详情显示所选发布版的标题、尺寸、大小和替代文字。「预览已发布图片」即时读取该版本并显示在当前页面。「保存发布 PNG」先选择系统目录，再核对当前访问权限并申请该版本的一次性下载授权。 [React Native 图像组件](https://reactnative.dev/docs/image) · [PNG 发布和授权](../../qa/assistant-image-artifacts.md)

进入后台会清除预览和详情。回到前台重新检查权限，仍有权访问时可再次打开预览。详情打开期间每 15 秒重新核对。撤回发布或移除项目成员后，旧投影会清除。

2026 年 11 月 24 日，Pixel Tablet API 36 模拟器通过真实工作空间选择、项目邀请和查看者授权。预览像素和 70 字节导出文件均与扫描批准的第一版 PNG 一致。取消保存目录没有申请下载授权。撤回发布后，处于前台的预览及详情在下一次校验后清除。选目录时撤回成员权限，确认目录后服务拒绝访问，设备未写入文件。TypeScript、Android 与 iOS Hermes 导出通过。本功能的运行时验收覆盖 Android 调试模拟器。 [Android 验收](.expo/published-png-2026-11-24/android-results.json) · [原生预览](.expo/published-png-2026-11-24/android-native-preview.png) · [保存期间撤权](.expo/published-png-2026-11-24/android-membership-revoked-during-save.png)

### 项目发布的工作表、幻灯片和代码稿

Android 的「项目发布」也可查看当前项目已批准的工作表、幻灯片和代码稿。工作表按单元格保留数据类型，幻灯片按页显示标题和要点，代码以文字显示。详情只读取选中的发布版本。选择设备目录后，应用再次核对当前权限及版本，分别保存 XLSX、PPTX 或代码纯文本。发布和评论操作使用桌面网页版。 [类型化产物协作](../../qa/assistant-typed-artifact-collaboration.md)

2026 年 11 月 24 日，Pixel Tablet API 36 模拟器以查看者身份接受项目邀请。比对设备上保存的 XLSX、PPTX、代码文本和 PNG，四个文件均与该设备收到的授权响应逐字节一致。独立解析器核对了工作表中形似公式的文本、数字和布尔值，以及演示文稿的页标题和要点。代码记录保留已发布版本的 CRLF，私有新版本对查看者不可见。撤回工作表发布后，详情清除了标题和正文。选择保存目录期间移除成员资格，后续核对返回 HTTP 404，设备未下载或写入新文件。Android 和 iOS Hermes 导出及 TypeScript 检查通过，实际运行验收覆盖 Android 调试模拟器。 [Android 结果](.expo/published-documents-2026-11-24/android-results.json) · [工作表](.expo/published-documents-2026-11-24/android-literal-sheet.png) · [演示](.expo/published-documents-2026-11-24/android-literal-slides.png) · [代码稿](.expo/published-documents-2026-11-24/android-literal-code.png) · [目录选择时撤权](.expo/published-documents-2026-11-24/android-membership-revoked-during-picker.png)

## 私有产物

服务开放 `private_artifacts` 后，从「历史」进入「私有产物」。可查看当前工作空间中自己持有的纯文本、Markdown、代码稿、工作表、幻灯片和静态网页，以及各产物的历史版本。工作表保留文本、数字、布尔值和空值的区别，幻灯片显示每页标题与要点，网页显示标题、导语和文字区块。Markdown 链接、源码和网页标签均按文字显示。编辑入口位于桌面网页版。 [私有产物权限与格式](../../qa/assistant-private-artifacts.md)

切到后台会清除已显示内容，返回时重新核对当前工作空间和账号权限。「保存此版本到设备」需要先选择系统目录，服务验证所选版本后才写入文件。文件名使用产物标识和版本号，代码资料使用文本后缀。

2026 年 11 月 24 日，Pixel Tablet API 36 模拟器连接隔离服务，实测六种格式预览及 Markdown、代码稿、空版本、XLSX、PPTX 和 HTML 逐字节导出。核查 Office 文档结构时，工作表保留了形似公式的文本和布尔类型，演示稿保留两张幻灯片的文字。授权接口不可用时回到前台会清除旧版本内容。目录选择期间服务器撤回版本后，确认保存没有产生新文件。移动 TypeScript 和 Android、iOS Hermes 导出通过。iOS/iPadOS 设备交互和签名包仍待验收。 [Android 结果](.expo/private-artifacts-2026-11-24/android-results.json) · [工作表](.expo/private-artifacts-2026-11-24/android-sheet-types.png) · [撤回后保存被拒绝](.expo/private-artifacts-2026-11-24/android-revoked-during-chooser.png)

### PNG 图像版本

私有产物可显示各个已批准 PNG 版本的替代文字。选择历史版本和设备目录后，应用申请该版本的一次性下载授权。授权的取得与写入使用同一账号、工作空间和设备会话。原图撤回后，列表用固定名称标识退役产物，版本记录仍可读取其他有效版本。恢复编辑使用桌面网页版提供的操作。 [私有 PNG 与版本授权](../../qa/assistant-image-artifacts.md)

2026 年 11 月 24 日，Pixel Tablet API 36 模拟器分别在图片编辑开启和关闭时保存了同一历史版本。两个 PNG 均与隔离扫描批准的原件逐字节一致。目录选择期间撤回原图后，授权申请返回 HTTP 404。另一轮在签发授权后撤回图片，使用原授权下载仍返回 HTTP 404。两个目录均未写入文件，其他有效历史版本仍可读取。移动 TypeScript 及 Android、iOS Hermes 导出通过。iOS/iPadOS 设备存储与签名包仍待验收。 [Android 验收](.expo/image-artifacts-2026-11-24/android-results.json) · [退役产物](.expo/image-artifacts-2026-11-24/android-retired-head.png) · [授权撤回](.expo/image-artifacts-2026-11-24/android-grant-revoked-before-write.png)

## 加锁对话

服务启用 `conversation_read_lock` 后，在已打开的对话中点「加锁对话」并确认。服务停止该对话当前生成，撤回旧分享，并在恢复阅读前拒绝直接读取。移动端清除当前标题、正文和未发草稿，停止展示旧生成，并移除该对话的本机恢复标记。

「历史」中的「加锁对话」只显示对话编号。恢复时输入当前账号密码，移动端在提交和进入后台时清除输入框。密码不正确时可以重新输入。服务关闭新建加锁后，现有锁可继续通过 `locked_conversations` 恢复。

回到前台时，移动端先核对已选对话的访问权限，再显示标题及正文。带加锁能力的工作空间在前台每 15 秒核对已选对话。消息按只读文字显示，后台导出也会先检查当前对话权限。

2026 年 11 月 24 日，Pixel Tablet API 36 模拟器通过主动加锁、读取权限拒绝、生成中的回复取消、错误密码重试和后台密码清除。使用同一账号的另一会话在后台加锁后，设备收到 HTTP 423 并清除原有内容。对已完成回复的本机恢复标记也实测了同样的拒绝流程。用同一数据库和删除日志重启服务并关闭新建加锁后，旧锁仍可通过当前密码恢复。移动 TypeScript 和 Android、iOS Hermes 导出通过。iOS/iPadOS 设备交互和签名包仍待验收。 [Android 结果](.expo/read-lock-2026-11-24/android-results.json) · [历史恢复被拒绝](.expo/read-lock-2026-11-24/android-stale-bookmark-denied.png) · [关闭新建加锁后的恢复](.expo/read-lock-2026-11-24/android-recovery-creation-disabled.png)

## 历史引用和项目记忆来源

个人工作空间开启历史引用后，在普通对话使用 `local-echo` 时点「引用历史回复」。应用先读取当前设置，再让用户选择另一条未放入项目的对话中的一条已完成回复。选择只用于本次发送。切换对话、模型、账号或进入后台会清除待发送的选择。 [历史引用服务端验收](../../qa/assistant-explicit-history.md)

打开「查看历史来源」时，应用按当前权限显示来源回复编号。项目内的回复如果使用了项目记忆，可以打开「查看项目记忆来源」读取受权限保护的摘要。来源面板在前台每 15 秒重新核对权限，也可手动刷新。来源撤回后，只显示不可访问状态。

2026 年 11 月 24 日，Pixel Tablet API 36 模拟器通过历史引用关闭、每次打开重新核对设置、排除当前与项目对话、后台和切换对话清除选择、明确引用及发送后清除。来源加锁后，已打开的回执清除了编号和打开按钮。隔离数据库从 132 个 Liquibase 变更集升级到 133 个，旧回执维持撤回状态。随后实测项目内的回复显示受保护的摘要，删除该条记忆后，已打开的面板清除了摘要及编号，已送达的回复仍可阅读。移动 TypeScript 与 Android、iOS Hermes 导出通过。iOS/iPadOS 设备交互和签名包仍待验收。 [Android 验收](.expo/explicit-history-2026-11-24/android-results.json) · [历史来源撤回](.expo/explicit-history-2026-11-24/android-history-receipt-redacted.png) · [项目记忆来源撤回](.expo/explicit-history-2026-11-24/android-project-memory-source-redacted.png)

## 桌面接续

Android 调试端连接已启用 `local_desktop_companion` 的回环开发服务后，可从「历史」打开「桌面接续」。使用同一账号登录，输入桌面本地代码工作台生成的配对码并等待桌面确认。手机显示当前修订号、目录授权标识和 SHA-256，可批准该修订的语法验证、拒绝或解除配对。退出页面、退出账号或切入后台会清除当前显示的配对和任务。返回后应用重新核对服务端权限。 [桌面接续验收](../../qa/assistant-desktop-companion.md)

应用发布前设置 `EXPO_PUBLIC_ASSISTANT_API_ORIGIN` 为助手服务的 HTTPS 源地址。开发模式可使用 HTTP 回环地址。
