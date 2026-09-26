import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';

const CLI_PATH = join(__dirname, '..', 'src', 'index-botwx.ts');
const PROJECT_ROOT = join(__dirname, '..');
let stateDir: string;

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'botwx-cli-'));
});

afterAll(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function runCli(command: string) {
  const result = spawnSyncTsScript(CLI_PATH, [command], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, BOTWX_STATE_DIR: stateDir, BOTWX_WEIXIN_STATE_DIR: stateDir },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

describe('botwx CLI contract', () => {
  it('documents the WeChat lifecycle without exposing the legacy daemon CLI', () => {
    const result = runCli('--help');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('botwx — 微信 ↔ AI 编程 Agent');
    expect(result.stdout).toContain('botwx setup');
    expect(result.stdout).toContain('botwx login');
    expect(result.stdout).toContain('botwx start');
    expect(result.stdout).not.toContain('飞书');
  });

  it('reports a clean not-logged-in state', () => {
    const result = runCli('status');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('微信未登录');
  });

  it('fails closed for unknown commands', () => {
    const result = runCli('upgrade');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('未知命令: upgrade');
  });
});
