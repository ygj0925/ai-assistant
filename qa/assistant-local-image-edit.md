# 项目 PNG 本地裁剪与旋转

项目所有者可选择当前仍获准的原始 PNG，核对原图预览、裁剪框和结果尺寸后明确提交。坐标原点为左上角，先按整数坐标裁剪，再顺时针旋转 0、90、180 或 270 度。输入和结果每边最多 480 像素，限单帧 RGB 或 RGBA PNG。操作保留裁剪区域的像素和透明度。

启用需要 `dev` 或 `test` 环境、`assistant.attachments.local-image-edits-enabled=true`、私有对象存储、回环扫描器和绑定撤权日志。默认关闭。CPU 渲染每个实例限制为一个并发请求，使用 JDK PNG 编解码和内存缓存。批准前重新隔离、扫描并检查完整结果。无效确认、越界坐标和资源繁忙在预留附件之前退出。请求键可安全重试，重复使用同一请求键提交另一来源或几何参数会被拒绝。错误结果可删除以释放附件限额。整个路径没有模型调用或费用记录。 [Java ImageReader](https://docs.oracle.com/en/java/javase/21/docs/api/java.desktop/javax/imageio/ImageReader.html) · [Java 内存输入缓存](https://docs.oracle.com/en/java/javase/21/docs/api/java.desktop/javax/imageio/stream/MemoryCacheImageInputStream.html)

每个结果只保存一份获准 PNG 及其来源、审阅坐标、算法版本和当时的工作空间成员代数。导出的 PNG 含固定的 `AssistantProvenance=local_image_edit_v1` 文本标记，给阅读者提示处理来源。该标记不包含账号、工作空间或原图 ID。普通上传会删除上传者提供的标记。所有者可将批准结果单独保存为资产、建立新版本或按已知版本回滚。获准的项目共享元数据只显示该结果是否经本地编辑。 [PNG 文本数据块](https://www.w3.org/TR/png-3/#11textinfo)

原图撤回或成员离开会阻断相关编辑结果及其资产版本、分享和旧下载授权。导出和读取均重新核对来源和成员代数。撤权回放移除派生记录的访问权和私有对象，未受影响的版本和附件保留。新媒体类型和持久状态使上一版本服务无法把衍生 PNG 当成普通 PNG 读取。

## 回归验收

```sh
node qa/assistant-local-image-edit-smoke.mjs --fixture-base64
node qa/assistant-local-image-edit-smoke.mjs http://127.0.0.1:18147 restore <证据目录> <独立测试桶目录> http://127.0.0.1:18148
```

使用合成测试账号、回环 API、独立 PostgreSQL、Redis、S3、ClamAV 和独立的撤权日志。收到 `membership-ready.json` 后为合成接收者添加测试空间成员关系，再创建 `membership-added.json`。收到 `backup-ready.json` 后备份数据库与原始、衍生的两个已批准对象，再创建 `backup-done.json`。收到 `restore-ready.json` 后在另一数据库恢复备份，通过 S3 接口恢复两个批准对象，使用同一撤权日志启动目标后端并创建 `restore-done.json`。服务应清除回放前真实可读的两份对象。

定向 Java 测试覆盖四种旋转的逐像素对照、透明度、确定性、非法或越界输入、标记约束和 480 × 480 高熵图像。生产构建 Chrome 验证受保护的原图预览、无效编辑无写入、3 × 2 派生图、另存资产及原图撤权后的清空。[Chrome 结果](verify-results/project-png-edit-chrome-2026-11-24/browser.log)

精确后端包 `local-image-edits` 使用 166 个 PostgreSQL 变更集完成恢复验收。备份中保留 115 字节原图、141 字节结果、精确输入摘要和三个未消费的下载授权。恢复时通过经认证的 S3 接口放回两份对象。回放后两条记录均撤回，旧授权和待清理对象均为零。保留版本仍能下载。HTTP 复核通过，覆盖直接附件、资产版本和项目共享。该测试账号未创建模型运行。 [HTTP 结果](verify-results/local-image-edit-1795515509973/restore-final/summary.json) · [备份数据库](verify-results/local-image-edit-1795515509973/restore-final/postgres-before.json) · [恢复的对象与授权](verify-results/local-image-edit-1795515509973/restore-final/restored-before-journal.json) · [回放后数据库与 S3](verify-results/local-image-edit-1795515509973/restore-final/postgres-after.json)

MySQL 8.4 允许同范围来源绑定，拒绝跨范围、同对象、自定义角度、越界、缺摘要和旧状态混用。先前 PNG、WAV 和 PDF 行保留，账号删除级联移除来源绑定。相同后端的既有 PNG/WAV 和私有 PDF 真实扫描、读取与撤回回归通过。 [MySQL 结果](verify-results/local-image-edit-1795515509973/mysql/summary.json) · [PNG/WAV 回归](verify-results/local-image-edit-1795515509973/legacy-audio/summary.json) · [PDF 回归](verify-results/local-image-edit-1795515509973/legacy-pdf/summary.json)

扫描器停止后，已审核原图仍可用于生成隔离记录。有限重试后派生记录报 `SCANNER_UNAVAILABLE`，无法获取授权，隔离对象被清除。项目达到八个附件后，新增编辑被拒绝。删除一个编辑后，原请求键可重新提交并获批准。 [扫描器离线](verify-results/local-image-edit-1795515509973/offline-scanner/summary.json) · [额度回归](verify-results/local-image-edit-1795515509973/quota/summary.json)

关闭编辑开关后，禁止新请求，同时仍允许读取来源有效的既有派生图。撤回原图仍立即阻止派生图访问。真实成员离开验证了旧工作空间请求被拦截并清除派生对象。使用新成员代数重新加入后，原图可继续使用，旧派生图、旧授权和旧请求键继续被拒绝。 [功能开关回归](verify-results/local-image-edit-1795515509973/toggle/summary.json) · [成员代数回归](verify-results/local-image-edit-1795515509973/membership/summary.json)

本次验收范围为本地确定性图像编辑。模型图像生成、线上审核与标记策略、用量结算和签名真机流程分别待验收。
