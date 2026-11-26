# 桌面接续验收

本地接续只在显式开启 `assistant.companion.local.enabled=true` 的 `dev` 或 `test` 实例可用。API 必须显式绑定本机回环，客户端直接访问回环服务。Windows 开发环境中，Android 调试模拟器可用已经授权的 `adb reverse` 连接同一实例。正式环境关闭该能力。浏览器渲染进程只取得配对状态、当前修订摘要和可见审批记录，桌面登录令牌只保存在 Electron 主进程内。桌面接续的本机请求使用独立的 HTTP Agent，拒绝重定向。 [Node.js HTTP Agent](https://nodejs.org/download/release/v24.22.1/docs/api/http.html)

两个会话需属于同一账号、个人工作空间和当前权限。配对码两分钟内单次有效，服务端保存其 SHA-256，每个账号每分钟最多尝试六次。手机提交配对请求后，桌面还需明确确认。配对最多八分钟，任务默认九十秒。桌面连续十八秒未续期时，手机无法继续处理当前任务。审批和记录仅在该服务进程内保留。重启要求重新配对。

桌面端提交的任务包括目录授权标识、当前修订号和源码 SHA-256。手机可批准或拒绝匹配的修订。验证仍由电脑本地明确触发，领取授权后再次核对当前目录和修订，并且只执行固定的 JavaScript 语法检查。源码、目录路径和验证产物都留在电脑上。改选目录、保存新修订、撤销目录授权时撤回旧任务。手机或桌面解除配对，或任一设备会话被撤销后，旧任务无法继续使用。 [本地代码工作台验收](assistant-local-code-workbench.md) · [PostgreSQL 事务隔离](https://www.postgresql.org/docs/16/transaction-iso.html)

## 复跑

以隔离数据库和合成账号启动回环服务，从项目根目录运行 HTTP 测试。桌面源码竞态、回环源和单次领取可通过 `clients/desktop` 的 `npm test` 复测。

```powershell
node qa/assistant-desktop-companion-smoke.mjs http://127.0.0.1:18136
```

## 2026 年 11 月 24 日结果

Windows Electron 45.4.1 和 Android Pixel Tablet API 36 调试模拟器使用同一合成账号分别登录。手机读取并批准了第一版的准确摘要，桌面保持等待本地操作。保存第二版撤回了旧批准，手机重新回到前台时显示空任务。手机批准第二版后，桌面点击指定按钮完成验证。导出的 973 字节 JSON 与第二版源码哈希一致，再次使用旧批准失败。手机解除配对并退出，桌面收到完整审批记录。测试只用了预设的本地样例。 [Android 结果](verify-results/desktop-companion-2026-11-24/android-results.json) · [第二版手机核对](verify-results/desktop-companion-2026-11-24/android-current-task.png) · [桌面流程结果](verify-results/desktop-companion-2026-11-24/electron-results.json) · [解除配对后的桌面](verify-results/desktop-companion-2026-11-24/desktop-after-mobile-unpair.png)

隔离 PostgreSQL 完成 163 个 Liquibase 变更集。HTTP 验收覆盖同一账号的不同会话、代理转发拒绝、配对码重放和尝试上限、错误目录或修订的拒绝、一次性领取、桌面离线超时和设备会话撤销。单独用被锁定的合成会话行复现了撤销竞态，提交删除后等待中的审批返回 404，同一旧令牌再次请求返回 401。桌面记录了设备失效，审批没有成立。六个 Java 回归用例、十一个桌面 Node 测试、Windows x64 打包与启动、移动端 TypeScript 以及 Android 和 iOS Hermes 导出通过。设备交互验收覆盖 Windows 和 Android 模拟器。 [数据库迁移](verify-results/desktop-companion-2026-11-24/postgres-migration.log) · [HTTP 结果](verify-results/desktop-companion-2026-11-24/http-results.json) · [撤销竞态](verify-results/desktop-companion-2026-11-24/revoke-race.json) · [构建记录](verify-results/desktop-companion-2026-11-24/client-builds.json)

另用同一隔离数据库和删除日志实际重启了 JVM。两端原会话仍能通过认证，配对和审批记录均已清空，尝试领取重启前批准的任务返回 404。 [进程重启结果](verify-results/desktop-companion-2026-11-24/restart-results.json)
