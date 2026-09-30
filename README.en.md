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

With Node.js 22+ installed (the installer bootstraps pinned Bun 1.4.2 when needed):

```bash
curl -fsSL https://raw.githubusercontent.com/0x8u/botwx/main/install.sh | sh
~/.botwx/bin/botwx setup
~/.botwx/bin/botwx start
```

The installer downloads and builds Botwx, bootstrapping Bun 1.4.2 first when it
is not already available. `setup` detects an installed agent CLI, selects the workspace and session
backend, writes `~/.botwx/.env`, and starts WeChat QR login. Open a new terminal
after installation to use the shorter `botwx` command directly.

The installer persists `~/.botwx/bin` in `PATH` and exports `BOTWX_HOME` and
`BOTWX_BIN`. It also creates a non-destructive `botwx` link in an already-active,
writable PATH directory when possible. Because `curl ... | sh` runs in a child
process, it cannot mutate the parent shell. If the current terminal still says
`command not found`, run:

```bash
export PATH="$HOME/.botwx/bin:$PATH"
rehash 2>/dev/null || true
```

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

### Claude Code and Sonnet 5.5

When `BOTWX_CLI=claude-code`, Botwx now passes
`--model claude-sonnet-5-5` by default. This prevents a persisted local
preference or an older Claude Code default from silently selecting Sonnet 5.
An explicit `BOTWX_MODEL` still takes precedence; set it to `sonnet` if you
prefer Claude Code's rolling latest-Sonnet alias.

After upgrading an existing installation, change any old explicit model value
in `~/.botwx/.env`, restart Botwx, and send `/clear` in WeChat:

```dotenv
BOTWX_CLI=claude-code
BOTWX_MODEL=claude-sonnet-5-5
```

Run `botwx status` to inspect the effective Agent and model configuration.
Asking a model to identify itself is not a reliable version check because that
answer is generated content and can use an outdated name.

### Switching models from WeChat

Botwx handles model selection as connector-native commands:

```text
/model
/model list
/model claude-sonnet-5-5
/model sonnet
/model opus
/model default
```

Selections are isolated and persisted per hashed WeChat conversation. A
successful switch automatically rotates to a fresh Agent session and applies
to the next message. Unknown models are rejected against the current CLI's
curated model list. `/model` shows the effective model for that conversation;
`botwx status` shows the process-level default. Model switching does not switch
the underlying CLI.

## WeChat schedules

Botwx owns WeChat schedules directly; they do not depend on the legacy Botmux
MCP or any Lark topic. Create and manage them from WeChat:

```text
/schedule 每天 23:00 Generate today's market review
/schedule add 0 23 * * * | Generate today's market review
/schedule list
/schedule run|pause|resume|remove <task-id>
```

Runs use a dedicated reusable Agent session and proactively return the final
text through WeChat. If the SDK's roughly 24-hour inbound `context_token` is
temporarily unavailable, the completed result is persisted with mode `0600`
and delivered after the next inbound message. Set `BOTWX_TIMEZONE` to an IANA
zone such as `Asia/Shanghai`; otherwise the host time zone is used.

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
