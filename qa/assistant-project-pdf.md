# 项目私有 PDF 文本预览

项目所有者可上传本地演练用的基础 PDF 文本文件。服务支持固定布局的单页、未压缩 PDF 1.4 文本层，输入最多 32 KiB，输出最多 32 行和 4 KiB ASCII 文本。扫描后的文本按 LF 保留换行，预览使用纯文本，临时导出固定为 `extracted.txt`。扫描件、加密文件、压缩流、多页布局和其他 PDF 结构会被校验拒绝。

请求入口先检查 MIME、大小和文件头。原始内容进入私有对象存储隔离区，扫描器使用通过摘要校验的完整原始字节。只有 ClamAV 明确通过后才读取 PDF 的固定文本结构、第 1 至第 5 个对象、流长度和交叉引用偏移。通过处理后保存带摘要的规范文本，并清理原始对象。拒绝的文件不产生预览或授权。读取预览、签发授权和兑换分别核对项目归属和撤回状态。下载授权绑定登录会话，只能兑换一次，有效期 60 秒。

PDF 入口默认关闭，仅在 `dev` 或 `test` 环境、非 `prod`、`assistant.attachments.pdf-enabled=true` 且现有隔离附件设施与绑定撤权日志就绪时可上传和读取。关闭 PDF 入口后，原有记录仍可在私有项目中查询处理状态或删除。账户导出仅提供获准记录元数据，内容类型为 `text/plain`。原始 PDF 不提供浏览器预览或下载。

Java 进程只接受该封闭文本结构。PDFBox 的按需加载和写入缓存策略适合评估更广的 PDF 处理。面向一般 PDF 的功能还需要独立进程、可验证的资源限额和网络隔离。 [PDFBox 3.0 迁移说明](https://pdfbox.apache.org/3.0/migration.html) · [PDFBox 安全说明](https://pdfbox.apache.org/security.html)

## 回归验收

使用合成文件、独立回环 API、PostgreSQL、Redis、私有 S3、ClamAV 和绑定撤权日志。 `node qa/assistant-project-pdf-smoke.mjs --profile-fixture-base64` 生成合法样例。 `--scanner-signature` 为测试专用 ClamAV 数据库生成无害签名，供扫描顺序检验。该签名只用于独立测试。

```sh
node qa/assistant-project-pdf-smoke.mjs http://127.0.0.1:18147 normal <证据目录> <隔离测试桶目录>
node qa/assistant-project-pdf-smoke.mjs http://127.0.0.1:18147 restore <证据目录> <隔离测试桶目录> http://127.0.0.1:18148
node qa/assistant-project-pdf-smoke.mjs http://127.0.0.1:18148 disabled <证据目录>
node qa/assistant-project-pdf-smoke.mjs http://127.0.0.1:18148 offline-scanner <证据目录> <隔离测试桶目录>
```

恢复用例在 `backup-ready.json` 出现后保存撤回前的数据库备份，再写入 `backup-done.json`。收到 `restore-ready.json` 后停源实例，恢复到另一独立数据库并使用同一撤权日志启动。确认健康后写入 `restore-done.json`。脚本验证旧 PDF 和授权均不可访问，同一上传键也无法恢复旧记录。未撤回对照仍能读取精确文本。独立测试桶用于检查隔离原件和撤回后规范文本对象的实际删除。

恢复命令可在目标地址后追加 `--check-disabled`。脚本创建 `disabled-ready.json` 后，在同一恢复库及撤权日志下关闭 PDF 开关重启目标实例，再创建 `disabled-done.json`。该分支复核读取停用、既有状态可见、以及仍可删除。

定向解析器单元测试通过 5 项，覆盖精确文本和转义、长度和交叉引用验证、异常语法、输入和输出上限。MySQL 8.4 独立原生迁移保留了旧 PNG 和 WAV 行，通过 PDF 隔离、批准、撤回状态测试，并拒绝八项跨类型、缺摘要和超限变更。 [MySQL 结果](verify-results/project-pdf-1795512722599/mysql/summary.json)

2026 年 11 月 24 日，精确验证包 `project-pdf` 通过 157 个 PostgreSQL 变更集的回环恢复检验。原生 ClamAV 拦截带无害签名且结构错误的样本，另一份干净但交叉引用损坏的文件报 `INVALID_PDF`。两份合格文件各产出 64 字节纯文本，原始对象被清理。跨账号及跨项目读取被拒绝，设备绑定授权只能使用一次，撤回后旧授权和相同上传键在恢复库继续被拒绝。既有记录在关闭入口时仍可查询状态和撤回。 [HTTP 结果](verify-results/project-pdf-1795512722599/restore/summary.json) · [PostgreSQL 结果](verify-results/project-pdf-1795512722599/restore/postgres-restored-access.json)

在第二份独立恢复库中，经真实 S3 接口恢复撤回前的 64 字节规范文本，再用同一日志回放。启动前带凭据的 S3 查询可见该对象。回放后该查询返回不存在，后端文件已删除，数据库确认旧授权及清理待处理项均为零。 [S3 回放前](verify-results/project-pdf-1795512722599/restore/s3-before-replay.json) · [S3 回放后](verify-results/project-pdf-1795512722599/restore/s3-after-replay.json)

生产构建的 Chrome 用例通过显式上传、按字面展示纯文本、下载字节相同以及撤回后的预览清空。相同后端包还通过既有 PNG 和 PCM WAV 的真实隔离扫描、摘要与权限回归。 [Chrome 结果](verify-results/project-pdf-chrome-2026-11-24/browser-fixed.log) · [既有媒体回归](verify-results/project-pdf-1795512722599/legacy-media/summary.json)

指向未运行的扫描器时，已隔离文件有限重试后报 `SCANNER_UNAVAILABLE`。期间无法读取预览或签发下载授权，最终清理原件。关闭 PDF 开关后，新账号不能上传，私有项目仍可读取空状态列表。 [扫描器不可用](verify-results/project-pdf-1795512722599/offline-scanner/summary.json) · [功能关闭](verify-results/project-pdf-1795512722599/disabled/summary.json)

Pixel Tablet Android 用系统选择器拒绝超限或文件头错误的文件，这两种失败与取消均未发送上传请求。656 字节合成 PDF 经真实 ClamAV 扫描后，按字面呈现并保存为精确的 64 字节文本。进入后台时清除预览，撤回文件后已打开的保存窗口也无法写出副本。冷启动关闭 PDF 能力后，旧记录可查看状态和删除，WAV 流程复测通过。 [Android 验收](../clients/mobile/README.md#项目-pdf-文本)

## 隔离进程提取压缩和多页文本

基础解析仍使用前述严格结构。需要处理压缩文本流或多页时，在开发或测试环境额外配置 `assistant.attachments.pdf-extractor-url` 和 `assistant.attachments.pdf-extractor-key`，并保留 PDF 上传与私有扫描开关。应用先校验入库对象摘要并通过独立 ClamAV 扫描。只有扫描通过且基础解析无法处理的文档才发送到受信任主机的 IPv4 回环解析服务。 [运行和协议](../services/document-worker/README.md)

隔离进程接受 32 KiB 以内、最多八页的未加密文本 PDF，返回不超过 4 KiB 的 NFC 纯文本。Linux 进程的网络、命名空间、文件系统、进程派生和资源上限已经实测。Java 客户端核对响应形状、字节预算和总完成时限。既有附件的授权、专用文件名、原件清理和撤权路径继续适用。

2026 年 11 月 24 日，实际 Java、私有 S3、ClamAV 与 WSL Linux 解析服务从两页压缩 ToUnicode 合成 PDF 得到 11 字节中英文本。真实 API 验证九页文件、错误交叉引用指针、跨账号访问、不同设备兑换、重复兑换、撤回和隔离原件清理。Windows Chrome 生产构建通过基础文档与 Unicode 多页文档的字面预览和精确下载。 [真实 API](verify-results/general-pdf-java-2026-11-24/general/summary.json) · [Chrome 基础与压缩多页用例](verify-results/general-pdf-java-2026-11-24/browser.log)

将解析地址指向未启动的回环服务时，压缩文档经过有限重试被拒绝，不能签发下载授权，隔离原件已清理。同一实例仍通过基础文档扫描与下载。Pixel Tablet 原生文件选择、字面文本显示和 51 字节导出通过。关闭扩展解析后继续读取已批准文本，新 PDF 1.7 在设备选取阶段受阻，撤回先前授权期间未生成文件。 [解析服务不可用](verify-results/general-pdf-java-2026-11-24/worker-offline/summary.json) · [Android 正常、关闭与撤权实测](verify-results/general-pdf-android-2026-11-24/android-results.json)

## 单页扫描件 OCR

OCR 默认关闭。只在上述私有开发或测试环境同时启用 `assistant.attachments.pdf-ocr-enabled=true` 和 Worker 的 `--ocr-language chi_sim` 或 `eng`。经扫描批准后，Java 以明确的请求头授权 OCR。Worker 只在无内嵌正文且有覆盖整页的单张光栅图像时识别一页，每次使用固定的一个语言模型。空白页、加密文档、无效结构、任一处理上限或模型缺失均无法保存结果。图像中间数据留在沙箱内存，最长边 1024 像素。识别可能出现错字，Web 和 Android 均提示核对原件。 [Worker 限制与测试](../services/document-worker/README.md)

已批准的扫描文本持久化 OCR 标记，并在 UTF-8 文本字节中保留中英文误差提示。旧文本层结果保持原有格式。当前版签发扫描件下载授权前必须提交用户确认。关闭 OCR 后可预览已批准文本，保存时仍需确认。将 OCR 启用前的真实后端接到同一个 OCR Worker 后，新扫描件得到拒绝，含正文的压缩 PDF 仍返回精确文本。旧版 PDF 下载不支持交互确认，回退期间若仍需强制确认，应关闭整个 PDF 入口。 [旧版后端验收](verify-results/pdf-ocr-2026-11-24/legacy-consumer/summary.json)

2026 年 11 月 24 日，真实 ClamAV、WSL 隔离 OCR、私有 S3 与 PostgreSQL 验收使用 9,696 字节合成扫描件，产生包括提示在内的 159 字节文本。验证以未撤回前备份还原目标库，撤回文本和旧授权继续被拒绝，独立合格文本保留，关闭 OCR 后新的扫描件拒绝写入。PostgreSQL 从 177 追加一项变更，还原后重复执行 0 项。MySQL 8.4.11 保留既有附件，拒绝非 PDF、未批准和非布尔标记。 [HTTP 与恢复](verify-results/pdf-ocr-2026-11-24/http-restore/summary.json) · [PostgreSQL](verify-results/pdf-ocr-2026-11-24/postgresql-migration.log) · [MySQL](verify-results/pdf-ocr-2026-11-24/mysql.log)

生产 Web 的 Chrome 用例验证取消无授权、明确确认后的精确下载和撤回预览。Android Pixel Tablet API 36 也经系统文件选择验证真实上传、后台与取消、159 字节保存、关闭 OCR 后重开及撤回时停止写文件。Android、iOS Hermes 包通过，实际 iOS 文件选择、生产病毒库和签名渠道仍待验收。 [Chrome](verify-results/pdf-ocr-2026-11-24/browser.log) · [Android](verify-results/pdf-ocr-android-2026-11-24/android-results.json)
