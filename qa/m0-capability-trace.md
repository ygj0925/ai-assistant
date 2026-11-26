# 功能追踪与验收基线

登记日期为 2026 年 11 月 22 日。公开证据逐项见[功能对标与跨端矩阵](../docs/research/功能对标与跨端矩阵.md)。本表对应 [OpenSpec 规范](../openspec/changes/build-cross-platform-ai-assistant/proposal.md#new-capabilities)和[实施任务](../openspec/changes/build-cross-platform-ai-assistant/tasks.md)。

本轮账号、地区、套餐、应用版本和管理员授权的实际样本均待登记。各条目的公开证据为官方资料，账号实测为待测。复验记录包含日期、观察账号代号、地区、套餐、设备和系统、应用版本、角色和权限、操作、预期、实际结果以及脱敏证据位置。能力列省略规范名的 `assistant-` 前缀。

| 目录条目 | 能力与阶段 | 成功和失败的首个验证用例 | 用例所需身份与权限 |
| --- | --- | --- | --- |
| 登录与账户 | chat-and-account M1，workspace-governance M4 | 登录并切换账号，撤销后旧设备令牌失效、当地缓存不串号 | 两个消费者账号及两台设备 |
| 文本对话 | chat-and-account M1，platform-delivery M1 | 保留编辑分支，另一端接续同一运行，没有重复回复和计量 | 同一消费者的两个受支持端 |
| 模型与推理档位 | chat-and-account M1，multimodal-tools M2 | 核查实际模型、退役回退和限流提示，禁止越区回退 | 有及没有相应模型权益的账号 |
| 查找历史与内容 | chat-and-account M1，projects-and-privacy M2 | 中英文和繁简搜索定位会话，撤权后结果不可读 | 资源所有者及被撤权成员 |
| 数据控制与隐私 | projects-and-privacy M1–M2 | 删除并从旧快照恢复，重放撤权。临时会话不进入普通历史或记忆 | 资源所有者和隔离恢复环境 |
| 套餐与账单 | chat-and-account M1，workspace-governance M4 | 重复及乱序退款回调仍产生一致权益，跨端可核对 | 消费者、账单管理员及渠道沙箱 |
| 搜索与引用 | multimodal-tools M2 | 每条引用定位原始证据，部分来源失效时有提示 | 已启用联网的测试账号 |
| 文件、视觉和音频输入 | multimodal-tools M2 | 文档可解析，超限或错误类型不得进入索引 | 附件所有者及有权限的设备 |
| 数据与代码分析 | multimodal-tools M2 | 固定数据集生成计算和图表，非授权会话不能下载 | 两个账号和隔离执行环境 |
| 图片生成与编辑 | multimodal-tools M2 | 编辑保留版本与标识，源图撤权后停止读取 | 生成权益及来源素材访问权 |
| 语音与屏幕 | multimodal-tools M2–M3，platform-delivery M3 | 发送前纠正听写，通话撤权立即停止采集 | 已授权和撤权的真机或浏览器 |
| 持久记忆与偏好 | projects-and-privacy M2 | 显示可用来源，关闭或撤权后停止引用 | 项目成员与个人记忆权限 |
| 项目与分享 | projects-and-privacy M2–M3 | 显示受众，撤销后链接不可读，独立副本遵循自身规则 | 所有者、成员、组织外访客 |
| 学习与交互展示 | collaborative-artifacts M3 | 不支持组件的端仍能答题并收到反馈 | 支持端与仅文本端 |
| 深度研究 | research-and-automation M3 | 修改来源限制，重启 Worker 后保留进度和引用 | 研究权益及来源权限 |
| Work 与通用任务 | research-and-automation M3，advanced-domains M4 | 跨端查看同一任务，外部动作经过审批，未知结果可核对 | 任务所有者、已批准工具 |
| 提醒与自动化 | research-and-automation M3 | 重复投递只触发一次，接收者套用后使用自身配额和授权 | 发布者、接收者、沙箱连接器 |
| 自定义助手与生态 | research-and-automation M3–M4 | 私有知识隔离，公开版本可审核、举报和撤回 | 创建者、普通成员、审核者 |
| 插件与企业数据 | research-and-automation M3，workspace-governance M4 | 尊重管理策略及源系统撤权，禁止沿用失效审批 | 应用授权者和组织管理员 |
| Canvas、Space 与资产 | collaborative-artifacts M3–M4 | 共编后可回退，撤权后无法继续读写，导出文件可打开 | 编辑者、阅读者和撤权成员 |
| Sites | collaborative-artifacts M3–M4 | 私有预览、授权发布和撤回独立，撤回后公共入口失效 | 项目编辑者和站点发布者 |
| Codex 类工作台与 Remote | advanced-domains M4 | 授权样例可编辑和构建，解绑后不能观察或批准任务 | 已配对设备和授权目录 |
| 主动助手与个性化扩展 | advanced-domains M4 | 静默期间无额外推送，关闭后停止新任务 | 已选择启用的测试账号 |
| 商业、购物与支付 | advanced-domains M4 | 确认金额、商家及结果，重复回调不重复扣款 | 地区符合且使用商家沙箱 |
| 健康、财务和未成年人 | advanced-domains M4 | 用途隔离，地区、年龄或监护条件不满足时限制入口 | 合成数据、专项授权测试账号 |
| 组织与管理治理 | workspace-governance M4 | 目录停用及角色变更阻断访问，审计不可跨租户查询 | 两个组织、目录及管理员账号 |

## 产品参考

- Claude Projects 提供项目知识和项目指令。项目权限以成员和资源为准，回归验证项目之间无法读取彼此资料。 [Claude Projects](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects)
- Gemini Notebook 以来源材料组织内容。检索和研究共享引用契约，用户能从主张回到对应证据并识别失效来源。 [Gemini Notebook](https://blog.google/innovation-and-ai/products/gemini-notebook/notebooklm-gemini-notebook/)
- ChatGPT 的聊天历史搜索和分享用于比较跨端接续、资源检索及受众预览。 [历史搜索](https://help.openai.com/en/articles/10056348-finding-your-chats-projects-and-files-in-chatgpt) · [分享](https://help.openai.com/en/articles/7925741-sharing-conversations-and-scheduled-tasks-in-chatgpt)
