# Web 本机朗读验收

普通对话的已完成助手回复提供「本机朗读」。浏览器需要报告至少一个 `localService === true` 的语音。用户主动点击后，Web 重新检查并显式选定本机语音。关闭对话、退出账号、打开弹窗、页面转入后台或本机语音不可用时停止朗读。回复仍可阅读、选择和复制。[Web Speech API 规范](https://wicg.github.io/speech-api/#dom-speechsynthesisvoice-localservice)

在 `clients/web` 运行 `npm run typecheck` 和 `npm test -- tests/read-aloud.spec.ts`。默认测试使用回环 API 和模拟语音设备覆盖远端语音过滤、键盘启动、完成、手动停止、引擎错误、本机语音变化、后台、弹窗和会话退出。可在安装本机语音的 Windows Chrome 上设置 `ASSISTANT_WEB_TEST_BROWSER=chrome` 与 `ASSISTANT_WEB_TEST_NATIVE_SPEECH=true`，额外检查 Web 选中真实本机语音及通过按钮启动、停止朗读。

2026-11-24 在 Windows Chrome 157.0.8103.79 运行 Playwright，3 项通过。原生用例确认页面选择了浏览器提供的本机语音、收到开始事件，并可通过按钮停止。独立引擎探测枚举到 3 个本机语音，其中包含中文语音，并对合成文本发出开始和结束事件。4.5 中的听写、实时语音、音频路由、转录及其他客户端仍需另外验证。

在 Windows Chrome 157 的隔离无头浏览器中查询本机听写。回环来源为安全上下文，浏览器暴露 `SpeechRecognition`、`processLocally`、`available` 和 `install`。要求本机处理和听写质量时，`zh-CN` 与 `en-US` 均报告 `unavailable`。该测试配置无法完成听写模型验收，现有本机录音附件可以用于明确确认的文件上传。 [Web Speech 本机识别](https://webaudio.github.io/web-speech-api/#dom-speechrecognition-processlocally) · [本机录音](assistant-project-audio.md)
