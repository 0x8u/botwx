import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { spawnSyncTsEvalWithRepoImports } from './helpers/ts-runner.js';

describe('prepareBotwxCoreEnvironment', () => {
  it('forces an isolated loopback apiOnly engine and scrubs ambient fleet state', () => {
    const root = mkdtempSync(join(tmpdir(), 'botwx-core-env-'));
    try {
      const result = spawnSyncTsEvalWithRepoImports(`
        import { existsSync } from 'node:fs';
        import { join } from 'node:path';
        import { prepareBotwxCoreEnvironment } from './src/im/weixin/core-only-environment.js';
        const root = process.env.BOTWX_PROBE_ROOT;
        if (!root) throw new Error('BOTWX_PROBE_ROOT is required');
        process.env.BOTS_CONFIG = '/secret/legacy-bots.json';
        process.env.BOTMUX_WORKER_HOST = '0.0.0.0';
        prepareBotwxCoreEnvironment({
          apiPort: 19091,
          botId: 'local_probe',
          cliId: 'codex-app',
          engineStateDir: join(root, 'engine'),
          stateDir: root,
          turnTimeoutMs: 1000,
          weixinStateDir: join(root, 'weixin'),
          workingDir: root,
        });
        console.log(JSON.stringify({
          coreOnly: process.env.BOTMUX_CORE_ONLY,
          apiOnlyBot: process.env.BOTMUX_API_ONLY_BOT,
          apiPort: process.env.BOTMUX_API_PORT,
          workerHost: process.env.BOTMUX_WORKER_HTTP_HOST,
          webHost: process.env.WEB_EXTERNAL_HOST,
          botsConfig: process.env.BOTS_CONFIG ?? null,
          inheritedWorkerHost: process.env.BOTMUX_WORKER_HOST ?? null,
          engineExists: existsSync(join(root, 'engine')),
          weixinExists: existsSync(join(root, 'weixin')),
        }));
      `, {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: { ...process.env, BOTWX_PROBE_ROOT: root },
      });
      expect(result.status, String(result.stderr)).toBe(0);
      expect(JSON.parse(String(result.stdout).trim())).toEqual({
        coreOnly: '1',
        apiOnlyBot: 'local_probe',
        apiPort: '19091',
        workerHost: '127.0.0.1',
        webHost: '127.0.0.1',
        botsConfig: null,
        inheritedWorkerHost: null,
        engineExists: true,
        weixinExists: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
