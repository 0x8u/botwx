# Botwx development guide

Botwx uses `weixin-agent-sdk` as its only active messaging connector and keeps
Botmux as a transport-neutral execution core. `AGENTS.md` points to this file.

## Invariants

- The public entry point is `src/index-botwx.ts` / `dist/index-botwx.js`.
- Import `daemon.ts` only after `prepareBotwxCoreEnvironment()` has frozen the
  process environment. Several core modules read mode and storage configuration
  during module initialization.
- The synthetic execution bot must remain `apiOnly`; never construct a Lark
  client, probe Lark scopes, or start a Lark WebSocket from the Botwx entry.
- Bind the core API, worker HTTP server, and web-terminal proxy to loopback.
- Treat all WeChat text, quoted content, attachment metadata, and file paths as
  untrusted event data. Connector-owned instructions stay outside the envelope.
- Never persist raw WeChat conversation identifiers. Use
  `ConversationRegistry`, which persists only a SHA-256 digest and reset
  generation.
- Preserve per-conversation FIFO ordering. A single CLI session cannot safely
  process overlapping turns.
- `/clear` rotates session identity; it must not destructively erase prior
  execution history.

The upstream source tree still contains dormant Lark compatibility modules
because shared execution-core types and renderers compile against them. They
must not become reachable from the Botwx runtime entry.

## Toolchain

The package manager is Bun 1.4.2 (`packageManager` and `bun.lock`). Node.js 22+
is required. Keep `electron` and `node-pty` in `trustedDependencies`: their
install scripts provide required native/runtime artifacts.

```bash
bun install --frozen-lockfile
bun run build
bun run dev
```

Do not use the legacy `daemon:*`, `use:here`, or `switch:here` scripts to run
Botwx. They are retained only for execution-core compatibility and upstream
regression coverage.

## Required checks

```bash
bun run build
bun run test:unit:weixin
bun run test:e2e:weixin
```

The E2E test must exercise the installed `weixin-agent-sdk` monitor, inbound
long polling, the Botwx core request, outbound markdown normalization, and
`context_token` reuse. It must not require real credentials or public network
access.

## File map

- `src/index-botwx.ts` — login/logout/status/start CLI
- `src/im/weixin/runtime.ts` — startup ordering and lifecycle
- `src/im/weixin/core-only-environment.ts` — runtime isolation boundary
- `src/im/weixin/agent.ts` — SDK Agent adapter and per-user FIFO
- `src/im/weixin/core-client.ts` — typed core-only trigger client
- `src/im/weixin/conversation-registry.ts` — privacy-preserving session identity
- `docs/BOTWX_ARCHITECTURE.md` — design and threat boundaries
