# 消费者账号接口验证

消费者账号使用独立的 `/api/assistant/v1` 路由、数据库表和不透明令牌。注册创建个人工作空间和首个设备会话。登录可建立多个设备会话，服务端在每次鉴权时检查令牌有效期和所选工作空间的成员关系。退出和撤销设备会使该令牌立即失效。账号接口响应禁止缓存，数据库只保存密码散列和令牌摘要。

消费者接口与注册分别用 `assistant.enabled` 和 `assistant.auth.registration-enabled` 控制，默认关闭。下面的命令用于隔离 PostgreSQL 和 Redis 上的回环测试。数据库及缓存连接变量见[后端基线](m0-backend-baseline.md)。

```powershell
Push-Location services/api
.\mvnw.cmd -B -pl :continew-server -am verify
Push-Location continew-server/target/app
java -jar bin/continew-admin.jar --spring.profiles.active=dev,postgres --server.address=127.0.0.1 --server.port=18090 --assistant.enabled=true --assistant.auth.registration-enabled=true
Pop-Location
Pop-Location
```

在另一终端从项目根目录运行[自测](assistant-account-smoke.mjs)。脚本每次在测试库创建两个独立账号，验证资料隔离、设备撤销、工作空间访问检查和后台路由拒绝消费者令牌。若测试环境已有有效的后台令牌，可通过 `ASSISTANT_TEST_ADMIN_TOKEN` 验证相反方向的隔离。

```powershell
node qa/assistant-account-smoke.mjs
```

## 实测结果

2026 年 11 月 22 日，ContiNew 后端及依赖模块的 Maven `verify` 通过。打包产物在 PostgreSQL 16.15 与 Redis 7.0.15 上运行了 HTTP 自测，验证游客发现能力、大小写重复注册、非 ASCII 用户名拒绝、错误密码、偏好、跨账号限制、设备撤销与注销，并使用实际后台测试会话验证双向令牌隔离。共享 SDK 的账号切换测试验证取消旧请求、等待应用清理旧数据，再启用新账号。 [共享 SDK](../packages/contracts/README.md)
