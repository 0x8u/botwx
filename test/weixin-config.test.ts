import { describe, expect, it } from 'vitest';
import { BOTWX_DEFAULT_API_PORT, readBotwxConfig } from '../src/im/weixin/config.js';

describe('readBotwxConfig', () => {
  it('builds isolated defaults', () => {
    const config = readBotwxConfig({}, { cwd: '/work/repo', homeDir: '/home/tester' });
    expect(config).toMatchObject({
      apiPort: BOTWX_DEFAULT_API_PORT,
      botId: 'local_botwx',
      cliId: 'codex-app',
      stateDir: '/home/tester/.botwx',
      engineStateDir: '/home/tester/.botwx/engine',
      weixinStateDir: '/home/tester/.botwx',
      workingDir: '/work/repo',
    });
  });

  it('rejects unsafe ids and invalid numeric inputs', () => {
    expect(() => readBotwxConfig({ BOTWX_BOT_ID: 'feishu-app' })).toThrow(/local_<slug>/);
    expect(() => readBotwxConfig({ BOTWX_API_PORT: '70000' })).toThrow(/BOTWX_API_PORT/);
    expect(() => readBotwxConfig({ BOTWX_TURN_TIMEOUT_MS: '0' })).toThrow(/BOTWX_TURN_TIMEOUT_MS/);
  });

  it('normalizes a relative working directory against the launch directory', () => {
    const config = readBotwxConfig(
      { BOTWX_WORKING_DIR: 'packages/service' },
      { cwd: '/work/repo', homeDir: '/home/tester' },
    );
    expect(config.workingDir).toBe('/work/repo/packages/service');
  });
});
