# 响应式 Web 跨端自测

2026 年 11 月 24 日，在 Windows 与 Android 模拟器验证同一份 Web 生产构建 `P4sQigaB6-p3gV3MtAvDX`。独立的本地模拟 API 在两段流式消息间等待 12 秒，用于在回复中途断网。测试使用合成账号和消息。 [现有 Playwright 用例](../clients/web/tests/workspace.spec.ts)

| 场景 | Windows Chrome 157 | Android 36 x86_64 模拟器，Chrome 133.0.6943.137 |
| --- | --- | --- |
| 中文输入和发送 | 使用中文草稿模拟组合输入时的 Enter，浏览器键盘事件验证 Shift+Enter 换行及 Enter 发送一次 | Fcitx5 Android 0.1.3 拼音实时显示「你好」候选。候选提交后，Enter 只发送一条保留三行的消息。Android Shift+Enter 仅换行 |
| 页面缩放 | Chrome 外观设置改为 125%。视口及文档宽度均为 1003 CSS 像素，设备像素比为 1.25，输入区仍在视口内 | Chrome 无障碍设置改为 125%。对话内容、输入区和操作菜单仍可用 |
| 断网与恢复 | 收到第一段后用浏览器上下文断网，确认提示和保留文本。通过浏览器 CDP 冻结页面、恢复联网、激活页面后，收到完整回复且没有重复消息 | 收到第一段后开启 Android 飞行模式并关闭 Wi-Fi，确认提示和保留文本。按 Home 将 Chrome 退到后台，恢复联网，再从启动器回到 Chrome。回复自动补全且没有重复消息 |
| 下载 | 在 125% 缩放下下载 `新对话.md`，按严格 UTF-8 解码，中文消息和回复各出现一次 | 在 125% 缩放下下载 `新对话.md`。本机 HTTP 来源触发 Chrome 下载确认。保存后，从 Android Download 目录取出的 255 字节文件按严格 UTF-8 解码，三行原始消息与完整回复各出现一次，并保留 Markdown 表格及代码块 |

桌面端使用无头的系统 Chrome 和独立浏览器配置。Android 使用实际 Chrome 应用和输入法，设备为模拟器。Windows 的系统中文输入法和系统窗口切换、物理手机、Safari 与生产 HTTPS 下载均需相应环境验证。 [Chrome Android 页面缩放](https://support.google.com/chrome/answer/96810?co=GENIE.Platform%3DAndroid&hl=en) · [Fcitx5 Android 发布包](https://github.com/fcitx5-android/fcitx5-android/releases/tag/0.1.3)

## 本机证据

- [Windows 浏览器结果](verify-results/android-browser-2026-11-24/desktop-browser-results.json) · [125% 缩放截图](verify-results/android-browser-2026-11-24/desktop-at-125-percent.png) · [下载文件](verify-results/android-browser-2026-11-24/downloaded-desktop-conversation.md)
- [Android 浏览器结果](verify-results/android-browser-2026-11-24/android-browser-results.json) · [中文拼音候选](verify-results/android-browser-2026-11-24/fcitx-candidate-live.png) · [断网提示](verify-results/android-browser-2026-11-24/offline-banner.png) · [恢复后的回复](verify-results/android-browser-2026-11-24/reply-after-foreground.png) · [125% 缩放截图](verify-results/android-browser-2026-11-24/response-at-125-percent.png) · [下载文件](verify-results/android-browser-2026-11-24/downloaded-conversation.md)
