# 私有项目音频验收

项目所有者可以选择 WAV 文件，确认后上传。服务支持 16 位单声道或双声道 PCM、8 至 48 kHz、最长 30 秒和不超过 1 MiB。文件先写入私有隔离对象并经 ClamAV 扫描，再重建 WAV 头部、移除无关元数据并保留样本。公开界面使用固定文件名 `audio.wav`。 [微软 RIFF 规范](https://learn.microsoft.com/en-us/windows/win32/xaudio2/resource-interchange-file-format--riff-) · [PCM 帧结构](https://learn.microsoft.com/en-us/windows/win32/api/mmreg/ns-mmreg-waveformatex)

只有所属项目的所有者可以申请绑定当前设备的一次性授权，60 秒内经请求头兑换。服务在读取对象后再次核对授权，返回禁止缓存且声明 `audio/wav` 的响应。图像列表和 WAV 列表独立，混用标识会被拒绝。撤回会清除已批准字节及原始对象，旧库恢复沿用独立日志。用户数据导出包含当前合法音频的格式元数据。Web 本机播放器在视图隐藏时停止，打开期间定期复核权限。

## 自测

使用隔离的回环 API、PostgreSQL、Redis、私有 S3、ClamAV 和绑定撤权日志，打开现有附件开关及 `assistant.attachments.audio-enabled`。

```powershell
node qa/assistant-project-audio-smoke.mjs http://127.0.0.1:18137 normal
node qa/assistant-project-audio-smoke.mjs http://127.0.0.1:18137 restore $evidenceDirectory http://127.0.0.1:18138
node qa/assistant-project-audio-smoke.mjs http://127.0.0.1:18138 disabled
```

恢复模式在 `backup-ready.json` 后备份测试库，创建 `backup-done.json`。收到 `restore-ready.json` 后停止源实例，数据库恢复到独立空库后以同一撤权日志和测试桶启动，创建 `restore-done.json`。关闭模式保留对象存储、扫描器和私有附件开关，单独关闭音频上传。

## 已验证

2026 年 11 月 24 日，真实 Chrome 生产构建通过显式文件选择和确认、确认前零上传、超过 64 KiB 的代理传输、合成 WAV 格式检查、浏览器预览和精确下载。撤回后已打开的预览消失，原授权下载被拒绝。关闭音频接收开关后，新上传收到 403。 [Chrome](verify-results/project-audio-2026-11-24/browser-fixed.log) · [关闭模式](verify-results/project-audio-2026-11-24/disabled.log)

真实回环应用和 ClamAV 将合成 WAV 重建为 16,044 字节，原始元数据不在结果里。双会话、跨项目、跨类型、重复使用授权及已撤回源均拒绝。恢复到撤回前的 PostgreSQL 备份后，识别 144 个变更集并重放同一撤权日志。旧 WAV 和授权继续不可用，未撤回 WAV 和原 PNG 按原权限下载。MySQL 8.4 验证了既有 PNG 约束、WAV 格式与状态隔离，以及撤回后的格式元数据清理。 [恢复 HTTP](verify-results/project-audio-2026-11-24/restore-fixed/summary.json) · [PostgreSQL](verify-results/project-audio-2026-11-24/restore-fixed/postgresql-proof.json) · [MySQL](verify-results/organization-audio-mysql-2026-11-24/native.log)

Pixel Tablet Android 运行验证通过系统文件选择、显式确认、取消等待后沿用同键重试、真实扫描及 65,580 字节下载。设备本地拦截不合格 WAV，后台清除界面状态。权限在系统选择器打开期间被撤回时，应用获取授权和发起写入均被拦截。Android 和 iOS JavaScript 打包通过，设备验收使用 Android。 [移动端 WAV](../clients/mobile/README.md#项目音频-wav) · [Android 运行证据](../clients/mobile/.expo/project-wav-2026-11-24/android-results.json)

## Web 本机录音

用户点击开始录音后，浏览器才申请麦克风权限。前台录音最长 30 秒，压缩片段最多 1 MiB，只留在页面内存。停止后关闭麦克风，使用浏览器解码并生成 16 kHz、16 位、单声道 PCM WAV。试听在本机完成，点击上传后才进入既有隔离扫描流程。离开前台、关闭界面或权限撤回时清理录音，断网时终止录制并清空待上传录音。权限拒绝和浏览器不支持时仍可选 WAV 文件或继续文字聊天。 [浏览器录音](https://www.w3.org/TR/mediastream-recording/) · [Web Audio 解码与重采样](https://www.w3.org/TR/webaudio/#dom-baseaudiocontext-decodeaudiodata)

Windows Chrome 生产构建使用合成麦克风，通过真实的浏览器权限拒绝、录制中撤权、断网停止、试听时撤权、停止后释放音轨及关闭项目面板。撤权前的录音未发送；明确确认后只有一次上传，真实 ClamAV 扫描通过，下载结果含有效 PCM 样本及规范 WAV 头。既有 WAV 选取、下载和撤回用例同批通过。此验收范围为浏览器录音附件，实时听写、转录和双向语音另需验证。 [Chrome 2 项通过](verify-results/project-audio-recording-2026-11-24/browser.log)

Android 本机录音经单独授权后使用原生音频输入。Pixel Tablet 调试模拟器使用关闭宿主麦克风的低幅度虚拟输入，验证允许、拒绝、退后台、断网、切换项目、撤销系统权限、试听及明确上传。经过 30 秒自动停止及真实隔离扫描，下载得到 29.968 秒、959,020 字节的 16 kHz 单声道 PCM WAV。 [Android 本机录音](../clients/mobile/README.md#android-本机录音)
