# DeepSeek 接入

## 使用

1. 运行 `npm start`（Node.js 20+），打开 http://127.0.0.1:8765/connect.html 。原 Python 静态服务器需要退出，新版服务同时提供页面和 API。
2. 在密码框输入 API Key；默认模型 `deepseek-flash`，可填写账号支持的其他模型 ID。
3. 点击“加密保存到本机内存”：只保存，不发模型请求。
4. 点击“验证连接”：发送一句简短测试，有少量 API 消耗。成功后显示“已验证连接”。
5. 返回原训练场刷新，打开小芽提问。回答下方区分本地/DeepSeek，并保留规则证据。

密钥不需要发给助手。后端重启后须重新录入。只要沿用相同浏览器与 http://127.0.0.1:8765 地址，原成长和本机记忆仍在。

## 通道边界

浏览器 WebCrypto RSA-OAEP（SHA-256）加密 `key + 一次性 nonce`，后端在启动时生成的 RSA 私钥解密。密钥和私钥只在当前服务进程内存中，不写入磁盘；响应、日志不会返回密钥。浏览器密码框提交后清空，密钥不进入 localStorage、聊天或 URL。

页面在本机 HTTP 回环地址提供，只有密钥提交字段使用额外加密。这不是远程 HTTPS 站点，也不能抵御已经控制本机或网页运行环境的攻击者。模型请求由后端发往固定的 `https://api.deepseek.com/chat/completions`，禁止重定向，没有任意代理地址配置。

服务仅绑定 127.0.0.1。接口检查 Host、Origin、会话 Cookie、CSRF 标记及一次性 nonce。静态文件使用白名单，后端代码、测试和其他项目文件不可通过服务下载。所有响应禁用缓存，配置页不含第三方脚本。凭据被移除或替换后，旧请求结果不会被接受。

## API

- `GET /api/bootstrap`：建立本机会话，返回公钥、nonce、CSRF 和无密钥的状态。Cookie 为 HttpOnly / SameSite=Strict。
- `POST /api/connect`：接收 `{encryptedKey, model}`；需同源会话与 `X-Coach-CSRF`。
- `POST /api/verify`：短模型调用，成功后标记 verified。
- `POST /api/disconnect`：清除内存凭据，恢复本地模式。
- `POST /api/coach`：接收 `{message, role, context, memory, conversation, stateToken}`；运行本地事实模块，再由 DeepSeek 表达。未配置时使用本地表达。

一次最多一个外部请求，不自动重试；后端超时 35 秒，前端 40 秒。上下文变化时丢弃旧建议；新回合播放中不接受战术请求。预制体验的聊天不会带回真实会话。

## 发往 DeepSeek 的数据

当前玩家问题、至多六条近期聊天（每条上限 1200 字符）、明确交流偏好，以及本地模块产生的建议与游戏证据。不会发送全部存档、API 私钥或随机种子。主动提示先由本地规则计算；连接模型后，开局与关键风险解释：适度模式每局最多3次、带我练模式最多6次，结算时另有一次整局分析。显式静默不发起这些主动请求。主动短提示与手动聊天都会显示实际回答来源，降级说明原因。

当前是本地 PVE 沙盒，客户端上传的战况并非服务端权威游戏状态；PVP mode 检查不能代替联网游戏权限控制。语言模型输出并未逐句自动验证，事实依据可以展开核对，不能宣称所有生成建议已被程序证明。

## 验证

服务测试使用模拟响应与专门的假密钥，不触及真实账户。覆盖浏览器加密兼容、nonce 重放拒绝、跨域/CSRF/Host 拦截、源代码不可下载、鉴权错误脱敏、连接验证、配置清除、本地/模型切换、PVP 限制及网络异常。实际 API 鉴权与模型可用性以用户完成“验证连接”为准。

官方文档：https://api-docs.deepseek.com/quick_start/pricing/ ，https://api-docs.deepseek.com/api/create-chat-completion/ 。模型 ID 可随平台更新，应以账号可用模型为准。
