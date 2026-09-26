# botwx

`botwx` 是一个以 [`weixin-agent-sdk`](https://www.npmjs.com/package/weixin-agent-sdk) 作为唯一前置消息连接器的 AI 编程 Agent。它保留 Botmux 成熟的执行内核，但运行时不需要任何飞书应用、密钥、事件订阅或 WebSocket 连接。

保留的核心能力包括：

- Claude Code、Codex、Gemini 等多 CLI 适配器
- 持久会话、崩溃恢复、轮次串行化与幂等控制
- tmux/zellij/zmx/PTY 后端与只读 Web Terminal
- 沙箱、技能注入、hooks、用量/成本记录、工作流等内核能力
- 微信文本、图片、语音、视频、文件与引用消息入站
- 每个微信用户独立、可恢复的多轮 Agent 会话

## 架构

```text
微信
  │  长轮询 / context_token / 媒体 CDN
  ▼
weixin-agent-sdk
  │  Agent.chat(ChatRequest)
  ▼
BotwxWeixinAgent
  │  会话 FIFO + 脱敏的稳定 session 映射
  ▼
Botmux core-only API (127.0.0.1 only)
  │  会话、CLI、后端、沙箱、工具、恢复
  ▼
Claude Code / Codex / Gemini / ...
```

详细设计与安全边界见 [docs/BOTWX_ARCHITECTURE.md](docs/BOTWX_ARCHITECTURE.md)。

## 一句话安装

机器上先准备好 Node.js 22+ 和 Bun 1.4.2，然后执行：

```bash
curl -fsSL https://raw.githubusercontent.com/0x8u/botwx/main/install.sh | sh
~/.botwx/bin/botwx setup   # 选 CLI → 选工作目录/后端 → 微信扫码
~/.botwx/bin/botwx start   # 前台启动微信连接器和 Agent 内核
```

安装器会下载 GitHub 源码快照、按 `bun.lock` 安装依赖、完成构建，并把
`~/.botwx/bin` 写入 shell 的 PATH。新开终端后可以直接使用短命令：

```bash
botwx setup
botwx start
```

如果使用 fork，可以通过环境变量覆盖仓库和分支：
让用户这样安装：

```bash
curl -fsSL https://raw.githubusercontent.com/your-name/botwx/main/install.sh \
  | BOTWX_REPO=your-name/botwx BOTWX_REF=main sh
```

安装器不会覆盖 `~/.botwx/openclaw-weixin/` 中的微信凭据或已有会话状态；升级时
旧程序保留在 `~/.botwx/app.previous`，便于回退。

## 5 分钟接入手册

下面从一台已经安装 Node.js 的电脑开始。首次下载依赖、微信扫码和模型响应所需的
时间不计入 5 分钟。

### 第 1 步：确认运行环境（约 30 秒）

需要 Node.js 22+、Bun 1.4.2、tmux，以及至少一个已经登录的 Agent CLI。默认使用
`codex-app`，它仍然要求本机的 `codex` 命令已经安装并完成登录。

```bash
node --version       # 应为 v22 或更高
bun --version        # 推荐 1.4.2
tmux -V              # 推荐安装，用于持久会话与崩溃恢复
codex --version      # 使用默认 codex-app 时必须可执行
```

请先在终端独立运行一次所选 Agent CLI，完成它自己的登录或 API Key 配置，并确认能
正常回答问题。常用选择如下：

| `BOTWX_CLI` | 本机要求 |
|---|---|
| `codex-app`（默认） | `codex` 命令可用且已登录；使用结构化 App Server 协议 |
| `codex` | `codex` 命令可用且已登录 |
| `claude-code` | `claude` 命令可用且已登录 |
| `gemini` | `gemini` 命令可用且已完成认证 |

没有 tmux 时可以使用 `BACKEND_TYPE=pty`，但运行中的会话不能在 Botwx 进程重启后
继续恢复。

### 第 2 步：安装（约 1 分钟）

推荐使用上面的一句话安装。要从本地源码开发，则执行：

```bash
git clone https://github.com/0x8u/botwx.git
cd botwx
bun install --frozen-lockfile
bun run build
./dist/index-botwx.js --help
```

最后一条命令能显示 `login`、`start`、`status`、`logout` 即表示产物可用。

### 第 3 步：运行初始化向导（约 1 分钟）

通过安装器安装后，新开一个终端并运行：

```bash
botwx setup
```

向导会依次完成：

1. 检测并选择已经安装的 Codex、Claude Code 或 Gemini CLI；
2. 选择 Agent 可以读写的工作目录；
3. 优先选择可恢复的 tmux 后端，没有 tmux 时自动使用 PTY；
4. 原子写入权限为 `0600` 的 `~/.botwx/.env`；
5. 在尚未登录时显示微信二维码并等待扫码。

也可以无交互配置，适合服务器安装脚本：

```bash
botwx setup \
  --cli codex-app \
  --working-dir /absolute/path/to/your/project \
  --backend tmux \
  --skip-login
botwx login
```

以下是需要手动调整配置时的说明。Botwx 优先读取 `~/.botwx/.env`；该文件不
存在时才读取启动目录下的 `.env`。

编辑 `~/.botwx/.env` 时，至少确认下面两项：

```dotenv
# 默认通过已登录的 codex 命令执行；也可改为 claude-code、gemini 等
BOTWX_CLI=codex-app

# 必须替换成希望 Agent 读写的真实项目绝对路径
BOTWX_WORKING_DIR=/absolute/path/to/your/project
```

`BOTWX_WORKING_DIR` 是微信用户能够让 Agent 操作的目录。建议先使用单独的测试项目，
不要直接指向包含私人文件或生产密钥的目录。没有 tmux 时，再取消下面一行的注释：

```dotenv
BACKEND_TYPE=pty
```

### 第 4 步：确认微信连接（约 1 分钟）

`setup` 在首次运行时已经启动扫码。只有跳过登录、扫码超时或需要重新绑定时，才
需要单独执行：

```bash
botwx login
```

终端会打印二维码。使用微信扫码并在手机上确认；二维码会话大约 8 分钟后超时，
超时后重新执行 `login` 即可。成功时终端显示：

```text
✅ 与微信连接成功！
```

检查登录状态：

```bash
botwx status
# ✅ 微信已登录
```

凭据默认保存在 `~/.botwx/openclaw-weixin/`，不要提交到 Git、发送给他人或复制到
不受信任的机器。

### 第 5 步：启动并发送第一条消息（约 1 分钟）

```bash
botwx start
```

看到下面两类日志就表示连接器和执行内核都已就绪：

```text
[weixin] 启动 bot, account=...
✅ botwx 已启动（codex-app · 127.0.0.1:7960）
```

保持这个终端运行。在扫码后微信打开或创建的连接会话中发送：

```text
只回复：BOTWX_OK
```

收到 `BOTWX_OK` 后即可发送真实任务，例如：

```text
阅读当前项目，解释它的目录结构，不要修改文件。
```

每个微信会话会映射到独立且可恢复的 Agent 会话。同一会话继续发消息会保留上下文；
发送 `/clear` 会切换到全新会话，旧历史不会被破坏性删除。按 `Ctrl+C` 可以安全停止
Botwx，再次执行 `start` 即可恢复服务。

### 日常命令

```bash
botwx setup    # 重新选择 CLI、工作目录和后端
botwx status   # 检查微信登录状态
botwx start    # 前台启动服务
botwx logout   # 删除全部微信登录凭据
```

源码开发时可以使用：

```bash
bun run setup
bun run dev
```

### 5 分钟内没有跑通？

| 现象 | 处理方式 |
|---|---|
| `微信尚未登录` | 重新执行 `botwx login` 并扫码，再用 `botwx status` 确认 |
| `codex` / `claude` / `gemini` 找不到 | 安装对应 CLI，并在普通终端中先完成一次登录和问答 |
| 首条消息进入后没有回复 | 查看启动终端中的 Agent 登录、模型额度或目录权限错误；先直接运行该 CLI 验证 |
| 提示找不到 tmux | 安装 tmux，或在 `~/.botwx/.env` 中设置 `BACKEND_TYPE=pty` |
| `EADDRINUSE` 或 7960 被占用 | 设置一个空闲端口，例如 `BOTWX_API_PORT=17960`，然后重启 |
| Agent 看不到项目 | 确认 `BOTWX_WORKING_DIR` 是存在的绝对路径，并重启 Botwx |
| 想重新绑定微信 | 依次执行 `logout`、`login`，然后重新启动 |

## 配置

`botwx` 会读取 `~/.botwx/.env`（不存在时读取当前目录 `.env`）。

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `BOTWX_CLI` | `codex-app` | 执行内核的 CLI 适配器 |
| `BOTWX_WORKING_DIR` | 当前目录 | Agent 工作目录 |
| `BOTWX_MODEL` | Agent 默认 | 模型覆盖 |
| `BOTWX_REASONING_EFFORT` | 未设置 | `low` / `medium` / `high` / `xhigh` / `max` / `ultra` |
| `BOTWX_TURN_TIMEOUT_MS` | `1800000` | 微信单轮请求超时 |
| `BOTWX_STATE_DIR` | `~/.botwx` | 对话映射与 SDK 凭据根目录 |
| `BOTWX_ENGINE_STATE_DIR` | `<state>/engine` | 执行内核持久化目录 |
| `BOTWX_WEIXIN_STATE_DIR` | `<state>` | `weixin-agent-sdk` 凭据与同步游标目录 |
| `BOTWX_ACCOUNT_ID` | SDK 第一个账号 | 多账号时选择账号 |
| `BOTWX_API_PORT` | `7960` | 本机 core-only API 端口 |

## 媒体消息

`weixin-agent-sdk` 会完成微信 CDN 下载、AES 解密和语音转码，然后把受控的本地文件路径作为不可信事件数据交给 Agent。引用文本会被合并进用户消息；引用媒体作为附件传入。

## 测试

```bash
# 新增连接器单测
bun run test:unit:weixin

# 真实 weixin-agent-sdk 长轮询 → core API → 微信回复的本地 E2E
bun run test:e2e:weixin
```

E2E 使用本地协议服务器，不读取真实微信凭据，也不访问外网。

## 平台差异

`weixin-agent-sdk` 当前是单账号、直聊模型，因此飞书的话题群、互动卡片、群成员权限、文档评论、会议事件等平台专属能力不会在 Botwx 运行时启动。其他执行层能力保留。

## License

MIT
