# 本机 PDF 文本解析服务

该服务在独立回环端口接收通过应用隔离扫描的 PDF。支持 1–8 页未加密的内嵌文本 PDF，包括压缩文本流。单个 PDF 上限 32 KiB，返回的 UTF-8 纯文本上限 4 KiB。超过上限或已检测到脚本的文件拒绝处理。文档内的链接和动作不会被执行。单页扫描件可使用单独启用的本机 OCR。

解析分两次启动独立 Poppler 进程，先检查页数和加密状态，再提取文本。标准输入和输出通过管道发送，临时文件中不保存 PDF 原件。文本使用 NFC，CRLF 和 CR 统一为 LF，水平制表符转为一个空格。禁用其他控制字符、格式控制字符及额外 Unicode 行分隔符。保留正文和内部换行，始终以一个 LF 结尾。

进入解析前，服务检查终止标记和 `startxref` 是否指向交叉引用表或压缩交叉引用流。被移除或错误指向的交叉引用会被拒绝。解析器报告的语法错误和警告同样拒绝。终止标记检查覆盖这两种静默修复样例，其他 PDF 结构仍由沙箱内的解析器处理。

## 运行边界

目前支持 Ubuntu 24.04 x86-64 和具有相同内核隔离能力的 WSL2 环境。调用方和服务须处于受信任私有主机。服务只绑定 IPv4 回环地址，使用单独随机令牌并且每次只处理一个请求。服务每次构建无网络、挂载、用户和 PID 命名空间，通过只读根目录限制文件访问，在关闭无关描述符并丢弃能力后运行。seccomp 拒绝网络套接字、生成子进程及改变隔离范围的系统调用。每个解析进程有 128 MiB 地址空间和 1 秒 CPU 上限。两次解析共享 2.5 秒的墙钟上限。

运行时需要普通 Linux 用户、Python 3、`unshare`、`libseccomp.so.2` 和可创建非特权用户命名空间的内核。运行时准备脚本根据本机 Ubuntu 软件包索引下载并核对 SHA-256，在独立私有目录展开 Poppler。该脚本不需要管理员权限。已有的 Ubuntu 依赖、来源和本地副本必须由运行人员控制。每次重新准备运行时前，应使用可信软件源的当前安全更新索引。

```bash
cd services/document-worker
runtime=$(bash prepare-runtime.sh)
read -rs ASSISTANT_DOCUMENT_WORKER_TOKEN
export ASSISTANT_DOCUMENT_WORKER_TOKEN
python3 -B worker.py --port 18217 --runtime-root "$runtime"
```

从调用应用所在的私有主机注入同一令牌。令牌使用 32–128 个 URL 安全字符。服务主动清空解析进程继承的环境，不记录请求、正文、Poppler 输出或令牌。

## 单页扫描识别

默认使用内嵌文本解析。OCR 启动选项固定为一个模型，中文使用 `chi_sim`，英文使用 `eng`。OCR 只处理通过常规校验、无可提取内嵌文本的未加密单页，页面旋转值为零。页内需要一张近似覆盖满页的灰度或 RGB 图像。OCR 进程从内存管道读取经过尺寸校验的 8 位灰度图，最长边为 1024 像素。额外的 Poppler 检查、栅格化和 Tesseract 继续使用同一隔离配置与共享的 2.5 秒总时限。

```bash
runtime=$(bash prepare-runtime.sh --ocr-language chi_sim)
python3 -B worker.py --port 18218 --runtime-root "$runtime" --ocr-language chi_sim
```

启用 OCR 的调用方每次在请求中明确发送 `X-Assistant-Allow-OCR: true`。缺少该头或值不匹配时沿用内嵌文本路径。重复请求头按通用规则返回 400。OCR 成功响应带 `X-Assistant-Text-Source: ocr`，供调用方标示识别来源，并在使用文本前请求用户确认。OCR 结果可能有错字。识别不出文字时返回 422，模型或沙箱运行时无法启动时返回 503。

## 请求与响应

调用 `POST http://127.0.0.1:<port>/extract`。请求使用 HTTP/1.1、固定匹配的 `Host`、`Authorization: Bearer <token>`、`Content-Type: application/pdf` 和明确的 `Content-Length`。分块传输、重复报头、压缩请求、路径参数和 multipart 均拒绝处理。

| 状态 | 含义 |
| --- | --- |
| 200 | `text/plain; charset=UTF-8`，返回明确长度的已规范化文本 |
| 401 | 令牌缺失或无效 |
| 413 | PDF 请求体超出限制 |
| 422 | PDF 无有效嵌入文本、无法解析或超过资源限制 |
| 503 | 无法启动隔离进程或其解析运行时 |

## 测试

```bash
cd services/document-worker
runtime=$(bash prepare-runtime.sh)
ASSISTANT_DOCUMENT_TEST_RUNTIME="$runtime" python3 -B -m unittest discover -s tests -v
```

测试只使用自建 PDF 和临时文件。实际 Poppler 验证压缩多页文本、缺文本、解析限制及故障关闭。真实 Linux 进程验证宿主文件不可读、只读根、IPv4 和 Unix 套接字禁用、无令牌环境、禁止派生进程、内存限制、CPU 限制、输出上限与超时回收。

本机 WSL2 Ubuntu 24.04 通过 9 项独立测试。真实压缩 ToUnicode 样本提取出中文和组合字符规范化后的重音字符。Windows JDK 使用同一回环端口完成认证请求，得到准确的 57 字节文本、明确的内容类型和长度。 [Linux 测试日志](../../qa/verify-results/document-worker-2026-11-24/native-unittest.log) · [Windows JDK 结果](../../qa/verify-results/document-worker-2026-11-24/windows-jdk-wsl-loopback.json) · [交叉引用回归](../../qa/verify-results/document-worker-2026-11-24/hardened-broker.json)

OCR 测试通过 Python Pillow 和指定字体生成无文本层的合成扫描件。设置 `ASSISTANT_DOCUMENT_TEST_OCR_RUNTIME` 为准备好的运行时路径，`ASSISTANT_DOCUMENT_TEST_OCR_FONT` 为测试字体路径。测试默认使用 `chi_sim`，英文可设置 `ASSISTANT_DOCUMENT_TEST_OCR_LANGUAGE=eng`。已在 WSL2 分别通过中文模型的 13 项合并测试和英文模型的 3 项 OCR 测试。Windows JDK 到独立 OCR 端口的合成中英文样本返回准确的 44 字节及来源头，重复使用旧解析端口仍只支持内嵌文本。真实移除或损坏临时模型时，扫描件返回 503，内嵌文本仍可读取。
