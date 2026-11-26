# 私有项目 PNG 附件验收

私有项目所有者可上传 1 MiB 以内的非交错、8 位 RGB 或 RGBA PNG。每边最多 2048 像素，总面积最多 200 万像素。每个项目最多保留 8 条未撤销的附件，每个账号最多 32 条。客户端提交 UUID 请求标识用于重试。相同标识和内容返回原附件，内容改变时返回 409，标识对应的附件已撤销时返回 404。

服务先把原始字节写入私有对象存储的隔离区。Worker 从隔离区读取完整对象、验证摘要，再请求回环 ClamAV。只有明确收到干净结果且通过 PNG 分块、CRC、尺寸及解压长度检查时，才保存去掉辅助分块的可下载版本。扫描或存储暂时失败时保持隔离并有限重试，失败记录可由用户取消或删除。 [ClamAV 守护程序协议](https://docs.clamav.net/manual/Usage/ClamdProtocol.html)

下载授权有效 60 秒，可用一次。下载时需要当前账号和设备会话、目标工作空间、项目及附件授权。撤回先通过独立日志阻断读取和下载，再通过发件箱清理隔离和已批准对象。恢复旧数据库后重放撤回，同一个持有旧令牌的设备仍会被拒绝。 [独立删除日志](assistant-erasure.md)

## 本地复跑

设立独立回环 S3 和 ClamAV，启用消费者注册及可写、已绑定的独立删除日志。S3 端点使用 `http://127.0.0.1:<port>`、私有桶和单独凭据。对象验收可使用本地 rclone，并确认匿名读取返回 401 或 403。 [本地对象存储](../infra/local/README.md) · [rclone S3 服务](https://rclone.org/commands/rclone_serve_s3/)

| 参数 | 值 |
| --- | --- |
| `ASSISTANT_ATTACHMENTS_ENABLED` | `true` |
| `ASSISTANT_ATTACHMENTS_OBJECT_ENDPOINT` | 本地 S3 回环地址 |
| `ASSISTANT_ATTACHMENTS_BUCKET` | 私有测试桶 |
| `ASSISTANT_ATTACHMENTS_ACCESS_KEY`、`ASSISTANT_ATTACHMENTS_SECRET_KEY` | 通过进程环境注入的测试凭据 |
| `ASSISTANT_ATTACHMENTS_SCANNER_PORT` | ClamAV 回环端口 |

```powershell
node qa/assistant-png-attachments-smoke.mjs http://127.0.0.1:18108 --expiry
```

可通过 `--object-root <临时测试桶目录>` 同时核对实际对象删除。用 `node qa/assistant-png-attachments-smoke.mjs --scanner-fixture-base64` 生成无害 PNG，在隔离 ClamAV 中加载对应测试签名后添加 `--scanner-rejection`，复跑扫描拒绝分支。验收只允许合成文件和显式回环测试服务。

## 恢复到上传前的备份

使用测试服务、独立数据库、原测试桶和同一独立日志。为脚本创建空的证据目录，并提前为恢复后的服务另选回环端口。

```powershell
node qa/assistant-png-attachments-smoke.mjs http://127.0.0.1:18108 --before-upload-replay $evidence http://127.0.0.1:18109 --object-root $bucketDirectory
```

1. 脚本在生成 `backup-ready.json` 前创建账号和项目。此时备份原数据库，备份成功后在证据目录创建 `backup-done`。
2. 脚本上传、下载授权并撤回图片，确认产生 `deletion-ready.json`。随后停止原测试服务，将备份恢复到独立空库。
3. 使用同一绑定日志和同一测试桶启动恢复后的服务。确认应用就绪后创建 `restore-done`。脚本检查旧会话仍能访问原项目，同一附件标识、旧下载授权和同一上传请求标识均被拒绝。

## 验收记录

本轮使用独立解包的 Ubuntu ClamAV 1.5.4 和 Windows rclone 1.76.0。ClamAV 的原生协议确认普通合成内容能通过，带测试签名的合成 PNG 被识别，rclone 匿名桶请求返回 403。验收签名仅覆盖合成样例，正式候选还需核对发布环境中的官方病毒库、更新监控、存储网络与清理策略。其他文档和图像格式、音频以及相应平台的原生验收仍需完成。

2026 年 11 月 24 日，打包后端通过 PostgreSQL、Redis、ClamAV 和 rclone 的真实 HTTP 回归。验证了 413 大小限制、415 类型拒绝、扫描拒绝、跨账号和工作空间保护、同一上传请求重试、去掉辅助分块后的字节一致性、单次且绑定设备的下载授权及实际经过 60 秒的过期行为。撤回附件和注销账号分别阻断了在线访问并清理测试桶中的真实对象。

同日恢复到上传前的真实 PostgreSQL 备份后，服务识别全部 86 个既有 Liquibase 变更集，本次新增执行 0 个。旧会话仍可访问项目，旧附件和下载授权均返回 404，同一请求标识重传仍被拒绝，私有桶中也未重新出现该对象。附件标识由版本化作用域和请求标识确定，恢复时即使备份早于上传，也能用该标识核对独立撤回日志。

最新后端在独立回环服务再次通过真实 S3 与 ClamAV 验收。Android API 36 使用 Pixel Tablet 后置软件相机，先拒绝再授予相机权限，验证取消、重拍与上传前预览。点击上传前项目列表为空，确认上传后只出现一项经扫描通过的 752 × 1024 像素 PNG。 [Android 拍照验收](../clients/mobile/README.md#拍照上传私有-png)

## Web 摄像头与屏幕取帧

项目图像弹窗可以申请摄像头或浏览器屏幕采集。浏览器处理权限及屏幕选择，并显示系统使用提示。页面使用无音轨的本机预览，选中一帧后立即结束采集。单帧压缩在 1 MiB 内才可进入明确确认的私有上传流程。切换到后台、关闭弹窗、关闭捕获源或停止预览时释放视频轨。没有相应权限或接口时仍可导入 PNG 或继续文字聊天。实时媒体传输和模型理解需要单独开放及验收。 [屏幕采集规范](https://www.w3.org/TR/screen-capture/) · [Chrome 屏幕采集选项](https://developer.chrome.com/docs/web-platform/screen-sharing-controls)

浏览器报告摄像头授权撤回时，页面也会立即结束当前采集。项目具备音频输入权限时，用户可从相同项目切换到本机录音和 WAV 选取。生产 Chrome 组合回归实际撤回已开启的摄像头，确认旧轨道结束、未触发上传；关闭屏幕捕获源后可以直接切换录音。PNG、基础 PDF、本机 WAV 及裁剪旋转与两条取帧用例同批通过。 [媒体组合回归七项通过](verify-results/combined-media-chrome-2026-11-24/browser.log)

```powershell
$env:ASSISTANT_WEB_TEST_API_ORIGIN='http://127.0.0.1:18125'
$env:ASSISTANT_WEB_TEST_BROWSER='chrome'
$env:ASSISTANT_WEB_TEST_PRODUCTION='true'
$env:ASSISTANT_WEB_TEST_CAPTURE='true'
$env:ASSISTANT_WEB_TEST_ATTACHMENTS='true'
npm --prefix clients/web run build
npm --prefix clients/web test -- project-capture-live.spec.ts project-attachments-live.spec.ts
```

2026 年 11 月 24 日，Windows Chrome 生产构建通过三个用例。360 像素视口在真实浏览器权限拒绝后重新获得合成摄像头权限，验证手动停止、关闭弹窗释放轨道、取帧、丢弃和实际私有上传。确认之前没有上传请求。回环 API 返回 202，ClamAV 与私有 S3 隔离流程处理后可以撤回。屏幕用例实际调用浏览器的 `getDisplayMedia` 采集合成标签页，验证无音轨、可取帧、停止后不上传，以及源标签页关闭后自动停止和文件入口仍可用。测试捕获源限于合成 Y4M 和测试标签页。 [用例](../clients/web/tests/project-capture-live.spec.ts) · [浏览器结果](verify-results/web-project-capture-2026-11-24/browser-y4m.log)
