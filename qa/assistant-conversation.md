# 会话目录和历史验证

消费者可以新建、重命名、置顶、归档和删除会话。目录按置顶状态、更新时间和会话 ID 分页。搜索匹配标题及已存消息正文，简体与繁体按原字形匹配，百分号和下划线按字面字符处理。

目录和消息读取均使用当前账号及所选工作空间限定查询。删除会话后会撤除在线访问并清空标题。历史接口按时间与消息 ID 升序返回，保留消息的父节点标识。

按[消费者账号验证](assistant-account.md)启动回环测试服务。先在 [共享契约包](../packages/contracts/README.md)运行 `npm test` 生成 SDK。给历史自测设置 `QA_POSTGRES_URL`、`DB_USER` 和 `DB_PWD`，连接服务当前使用的隔离 PostgreSQL 测试库。

```powershell
node qa/assistant-conversation-smoke.mjs
node qa/assistant-history-smoke.mjs
```

第一个脚本通过 HTTP 验证会话管理、目录分页及越权拦截。第二个脚本用[测试夹具](AssistantMessageFixture.java)在专用测试会话中放入同毫秒的父子消息，验证游标不重复、不漏读、正文可检索以及删除后无法读取历史。

2026 年 11 月 22 日，新增会话和消息表后，测试数据库从 17 个变更集增量升级至 21 个。后端 Maven `verify` 通过，两个脚本均在 PostgreSQL 16.15 上通过。
