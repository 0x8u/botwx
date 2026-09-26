# Contributing to Botwx

## Development setup

Botwx requires Node.js 22+, Bun 1.4.2, and at least one supported Agent CLI.

```bash
git clone https://github.com/0x8u/botwx.git
cd botwx
bun install --frozen-lockfile
bun run build
bun run test:unit:weixin
bun run test:e2e:weixin
```

Run the interactive setup and foreground connector from source:

```bash
bun run setup
bun run dev
```

## Pull requests

- Keep `weixin-agent-sdk` as the only active public messaging connector.
- Preserve the `BOTMUX_CORE_ONLY=1` boundary; do not translate WeChat messages
  into synthetic Feishu/Lark events.
- Treat message text, quoted content, and media metadata as untrusted input.
- Add focused unit tests for connector behavior and extend the SDK protocol E2E
  when changing long polling, session mapping, or outbound delivery.
- Run the build, connector unit suite, and connector E2E before opening a PR.

See [docs/BOTWX_ARCHITECTURE.md](docs/BOTWX_ARCHITECTURE.md) for the runtime and
trust boundaries.
