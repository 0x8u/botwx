# botwx

`botwx` connects WeChat to AI coding agents through
[`weixin-agent-sdk`](https://www.npmjs.com/package/weixin-agent-sdk). WeChat is
the only active messaging connector: no Feishu/Lark application, credentials,
event subscription, or WebSocket connection is required at runtime.

It retains the mature Botmux execution core: Claude Code, Codex, Gemini and
other CLI adapters; persistent sessions and crash recovery; PTY/tmux backends;
sandboxing; hooks; skills; usage accounting; workflows; and the local web
terminal.

## Architecture

```text
WeChat long polling + media
        │
        ▼
weixin-agent-sdk
        │ Agent.chat()
        ▼
BotwxWeixinAgent
        │ per-user FIFO + private stable session mapping
        ▼
Botmux core-only API on 127.0.0.1
        │
        ▼
Claude Code / Codex / Gemini / ...
```

The bridge uses Botmux's transport-neutral `apiOnly` boundary. It does not
simulate Lark messages. See [the architecture document](docs/BOTWX_ARCHITECTURE.md)
for the trust, persistence, and failure boundaries.

## One-line install

With Node.js 22+ and Bun 1.4.2 already installed:

```bash
curl -fsSL https://raw.githubusercontent.com/0x8u/botwx/main/install.sh | sh
~/.botwx/bin/botwx setup
~/.botwx/bin/botwx start
```

`setup` detects an installed agent CLI, selects the workspace and session
backend, writes `~/.botwx/.env`, and starts WeChat QR login. Open a new terminal
after installation to use the shorter `botwx` command directly.

## Source quick start

Node.js 22+, Bun 1.4.2, tmux, and one supported agent CLI are required. The
default CLI is `codex-app`. Set `BACKEND_TYPE=pty` only when tmux cannot be
installed; live PTY sessions cannot survive a process restart.

```bash
bun install --frozen-lockfile
bun run build
./dist/index-botwx.js setup
./dist/index-botwx.js start
```

During development:

```bash
bun run setup
bun run dev
```

Send `/clear` in WeChat to rotate to a fresh model session without deleting the
previous session's audit data.

Configuration is read from `~/.botwx/.env`, falling back to `.env` in the
current directory. See [.env.example](.env.example) for all supported options.

## Verification

```bash
bun run build
bun run test:unit:weixin
bun run test:e2e:weixin
```

The E2E test runs the published SDK's real long-poll and outbound-message code
against local protocol servers. It neither reads real WeChat credentials nor
uses the public network.

## License

MIT
