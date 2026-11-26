# 私有演示稿与 PPTX 导出

在启用私有产物和独立删除日志的消费者后端设置 `assistant.artifacts.slides.enabled=true`。能力探测返回 `private_slides`。在本人项目中创建 `format: "slides"` 的产物，提交 `presentation: {slides: [{title, bullets}]}`。保存提交同一结构及当前 `baseVersionId`。 [私有文稿](assistant-private-artifacts.md)

- 每份演示稿有 1 至 12 张幻灯片，每张使用非空单行标题和零至六条非空单行要点。标题上限 60 个 UTF-16 单元，每条要点上限 96 个 UTF-16 单元。版本的标准化 UTF-8 演示内容最多 32 KiB。
- 保存追加不可变版本，回滚产生新版本。读取和下载校验本人项目与所选工作空间。旧版本仍按权限可读，个人数据导出携带结构化 `presentation`。关闭编辑后可继续读取、下载、导出和删除已保留的演示稿。 [个人数据导出](assistant-privacy-export.md)
- PPTX 下载采用固定名 `artifact-<版本号>.pptx`。Apache POI XSLF 生成 16:9 宽屏、可编辑标题和原生项目符号。网址样式的文字仍保留为普通文字。 [Apache POI XSLF 指南](https://poi.apache.org/components/slideshow/xslf-cookbook.html)

## 自测

使用启用私有产物、工作表、演示稿与项目发布的隔离后端。脚本通过回环创建合成账号，以 Python 3 标准库读取实际下载的 OOXML，检查内容、项目符号、样式、几何边界与关系。Windows 可用 `--wsl-python` 选择 WSL 中的 Python。

```powershell
node qa/assistant-presentation-smoke.mjs http://127.0.0.1:18135 --wsl-python
```

`--switch <隔离证据目录>` 可验证停用后的保留权限。看到 `slides-editing-switch-ready` 后，以同一个数据库、Redis 和独立日志启动同一包并关闭演示编辑。启动完成后在证据目录创建 `slides-editing-disabled`。需要用原生 PowerPoint 验收时，传入 `--native-evidence <隔离证据目录>` 保存这一个合成 PPTX。

MySQL 8.4.11 命名管道隔离库通过增量与约束验证。同一回滚事务可保存项目演示稿、工作表和原有会话来源 Markdown。伪造演示稿的来源回复触发 3819。原检索目录的三条记录保留，回滚后没有文稿测试数据。

2026 年 11 月 24 日，完整 Maven 验证通过 96 项助手测试。两项演示单测使用 Apache POI 打开实际生成的 PPTX，核对原生项目符号、文字和版式。隔离 PostgreSQL 从已应用的 115 项变更集增量执行 4 项，合计 119 项。HTTP 下载返回 26,386 字节，独立用 Python 3.12 标准库核对实际 OOXML 结构、16:9 画布、34 磅加粗标题、22 磅正文与版式范围。Microsoft PowerPoint 16.0 也在只读会话打开同一附件，验证两页内容、中文和 emoji、网址样式文字及原生列表样式。

生产构建的 Chrome 验证通过两页编辑、校验、历史版本回滚和实际 PPTX 下载。HTTP 自测使用同一数据库、Redis 和独立日志关闭演示编辑，重启再次应用零项变更。创建、编辑和回滚返回 403，原演示稿仍可读取、下载、携带及删除。工作表保留独立开关，普通文本与工作表的 API 兼容自测通过。 [Chrome 验收日志](verify-results/web-presentation-2026-11-24/browser.log)
