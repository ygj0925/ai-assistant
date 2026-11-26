# 私有项目与后台导出验收

私有项目按账号和工作空间隔离。项目说明可以编辑。新会话可直接归入项目，旧会话保留原 ID、分支和消息，可移入或移出项目。项目元数据和会话关联会出现在用户个人数据导出中。项目资料检索、分享链接和成员协作属于后续功能。

后台导出以用户选定的会话分支为输入。API 在同一事务创建任务和发件箱记录，Worker 在数据库中提交 `50%` 的检查点与内容摘要，之后完成任务。下载时重建选定分支并核对摘要。每个账号同时最多 8 个进行中的任务。产物大小上限为 2 MiB，包含最多 256 条消息，单条最多 16,000 个字符。用户可取消进行中的任务，已经完成的任务保留原状态。

## 运行用例

使用带注册、`local-echo` 和隔离 PostgreSQL、Redis 的后端。启动时添加 `--assistant.jobs.enabled=true --assistant.jobs.checkpoint-delay-ms=16000`。延迟参数用于稳定复现中途取消和重启窗口，默认延迟为 250 毫秒。脚本在回环服务中注册合成测试账号。

```powershell
node qa/assistant-projects-smoke.mjs http://127.0.0.1:18083
node qa/assistant-jobs-smoke.mjs http://127.0.0.1:18083
```

使用关闭后台任务能力的另一套回环服务验证授权顺序和能力错误。

```powershell
node qa/assistant-jobs-smoke.mjs http://127.0.0.1:18082 --disabled
```

重启测试接受第三个参数作为证据目录。脚本写入 `restart-ready.json` 时，停止该回环服务的 JVM，再用原数据库、Redis 和功能开关重新启动。脚本验证真实断连、原任务进度、同一幂等键、产物标识和重复下载字节，并将结果写入 `summary.json`。

```powershell
node qa/assistant-jobs-smoke.mjs http://127.0.0.1:18083 qa/verify-results/jobs-restart
```

工作空间撤权用例使用证据目录和第四个参数 `revoke`。隔离数据库夹具在 `revoke-ready.json` 出现后撤销其中合成成员的资格。HTTP 验证返回 403 后会写入 `revoke-checked.json`。确认数据库中任务已取消且发件箱无待处理记录后，恢复该合成成员的原权限。脚本会读取原任务以确认未产生可下载文件。

账号注销用例使用第四个参数 `erase`。该服务还需启用[独立删除日志](assistant-erasure.md)，任务检查点延迟可设为 3,500 毫秒。用合成账号创建项目、运行中的任务和已完成产物，执行注销后通过 HTTP 检查失效，再依据证据目录中的 `verify-database.json` 核对数据库清理。

```powershell
node qa/assistant-jobs-smoke.mjs http://127.0.0.1:18085 qa/verify-results/jobs-erasure erase
```

## 2026 年 11 月 22 日验证记录

- PostgreSQL 16.15 上的打包 API 通过项目权限、跨账号访问拒绝、分页、并发迁移、取消归类和个人数据导出测试。移入同一项目的会话仍保持各自的模型分支。
- 后台任务通过同键并发提交、同键请求冲突、账号和工作空间隔离、同时取消、完成后下载、分支内容核对、删除会话后访问阻断和游标自测。
- 在进度为 50% 时停止隔离 Java 进程。观察到 API 断连后重新启动，原任务推进到 100%。使用同一幂等键重试仍返回原任务，重复下载所得文件字节一致。
- 关闭任务能力时，匿名取得 401，已认证请求取得 `403 CAPABILITY_UNAVAILABLE`。任务进行至 50% 后撤销成员资格，原令牌请求返回 403，Worker 取消任务并清理发件箱。恢复合成成员资格后，原任务仍是取消状态，产物不可下载。
- 注销合成账号后，旧令牌和密码均无法访问项目与产物。PostgreSQL 核对项目说明和会话正文已擦除，会话已解除项目关联，两条任务及对应发件箱记录全部移除。
- 实际 Chrome 在 Web 生产构建中完成新建和编辑项目、移动并筛选会话、提交后台任务、重新打开任务面板及下载中文 Markdown。共享 SDK 的 15 项测试通过。
- Android API 36 模拟器通过移动端提交、途中取消、完成至 100% 和重新打开任务。移动端提示通过 Web 下载。Windows Electron 另外通过渲染沙箱中中文 Markdown 下载的文件名及字节核对。 [移动端](../clients/mobile/README.md#后台导出任务) · [桌面端](../clients/desktop/README.md#打包和自测)
- PostgreSQL 正式打包资源迁移记录为 `1 → 59 → 59`。独立 MySQL 8.4.11 验证旧会话保持未归类、项目和任务表增量兼容、任务锁与发件箱级联删除。 [迁移细节](assistant-run-storage.md)
