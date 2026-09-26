# Botwx 架构设计

## 目标与边界

Botwx 把“IM 接入”与“Agent 执行”拆成两个明确边界：

1. `weixin-agent-sdk` 是唯一运行中的 IM connector，负责扫码登录、长轮询、`context_token`、媒体 CDN 和微信回复。
2. Botmux core-only 是执行内核，只在 `127.0.0.1` 上接受受限 HTTP 请求，负责会话、CLI、后端、沙箱、恢复和 Web Terminal。

它不通过伪造飞书事件复用 daemon，而是走内核已有的无传输 `apiOnly` 合约。

## 启动序列

1. CLI 加载 `~/.botwx/.env` 并校验所有 `BOTWX_*` 配置。
2. `prepareBotwxCoreEnvironment()` 在导入任何 daemon/config 模块前冻结环境：
   - `BOTMUX_CORE_ONLY=1`
   - 删除 `BOTS_CONFIG` 和会话/工作流遗留环境
   - 强制 core API、worker HTTP、Web Terminal 代理绑定 loopback
   - 把执行状态锁定到 `BOTWX_ENGINE_STATE_DIR`
3. 内核合成一个 `apiOnly` bot，不构造 Lark Client，不执行 open_id/scope 探测，不启动 Lark WSClient。
4. 内核完成持久会话恢复后开放 `/healthz` 和受限的 core-only API。
5. 只有在内核 ready 之后才启动 `weixin-agent-sdk` 长轮询，避免首条微信消息与恢复过程竞态。

## 会话模型

WeChat `conversationId` 不直接持久化。`ConversationRegistry` 存储它的 SHA-256 摘要和 reset generation，并派生符合内核约束的 `hl_wx_*` headless id。

- 同一微信用户的后续消息稳定命中同一个 CLI session。
- 不同用户的摘要与 session 完全隔离。
- `/clear` 只递增 generation，新消息进入新 session，旧历史不被破坏性删除。
- 每个 conversation 有独立 FIFO，同用户并发消息不会争抢同一 CLI 轮次；不同用户仍可并行。

## 消息与信任

微信正文、引用内容、附件元数据和本地文件路径全部放在 `envelope.trusted=false` 中。只有 connector 固定的任务描述位于 trusted instruction。这保留了内核对外部消息的 prompt-injection 边界。

SDK 负责附件下载和解密。Botwx 只传递解密后路径，不传递带凭据的上游 CDN URL。

## 无飞书运行保证

Botwx 的执行入口只启动 core-only：

- 忽略并删除环境中的 `BOTS_CONFIG`，防止意外读取现有飞书 fleet。
- 合成 bot 强制 `apiOnly: true`，`registerBot()` 不构造飞书 SDK Client。
- daemon 跳过 open_id 探测、scope 校验、事件订阅和 WSClient。
- core-only 仅开放 `trigger` / `trigger-result` / `insight` / 精确 turn interrupt 端点，其他控制面仍需本机 HMAC。
- 真实对话的 `chatId` / `rootMessageId` 在 apiOnly 边界会 fail closed，只允许 HTTP virtual/headless session。

上游内核的一些飞书兼容模块仍保留在源码树中，因为共享类型与卡片渲染仍被多个执行特性编译依赖；它们不是 Botwx 的 connector，也不在 Botwx 入口的可达运行路径上。这个选择避免为了“看起来删干净”而分叉和降级经过大量回归验证的执行内核。

## 故障语义

- 内核未 ready：不启动微信 monitor。
- 单轮超时：SDK 将错误提示回给当前微信用户，不吞消息。
- 内核结构化失败：保留 `errorCode` 进入运行日志和用户可见错误。
- SDK monitor 不可恢复失败：顶层进程返回非零状态，交由外部 supervisor 重启。
