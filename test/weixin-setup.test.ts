import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseBotwxSetupArgs,
  runBotwxSetup,
  type SetupIo,
  writeBotwxSetupEnv,
} from '../src/im/weixin/setup.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'botwx-setup-'));
  roots.push(root);
  return root;
}

function scriptedIo(answers: string[]): SetupIo & { output: string[] } {
  const output: string[] = [];
  return {
    output,
    question: async () => answers.shift() ?? '',
    write: message => output.push(message),
  };
}

describe('botwx setup', () => {
  it('parses automation flags and rejects unsafe backend values', () => {
    expect(parseBotwxSetupArgs([
      '--cli', 'claude-code',
      '--working-dir', '/srv/project',
      '--backend', 'pty',
      '--skip-login',
    ])).toEqual({
      backend: 'pty',
      cliId: 'claude-code',
      help: false,
      skipLogin: true,
      workingDir: '/srv/project',
    });
    expect(() => parseBotwxSetupArgs(['--backend', 'screen'])).toThrow(/tmux 或 pty/);
  });

  it('updates only owned dotenv keys atomically and keeps restrictive permissions', () => {
    const root = tempRoot();
    const filePath = join(root, '.botwx', '.env');
    writeFileSync(join(root, 'seed'), 'unused');
    writeBotwxSetupEnv(filePath, {
      BOTWX_CLI: 'codex-app',
      BOTWX_WORKING_DIR: '/srv/project with spaces',
      BACKEND_TYPE: 'tmux',
    });
    writeFileSync(filePath, `${readFileSync(filePath, 'utf8')}UNRELATED=value\nBOTWX_CLI=old\n`);

    writeBotwxSetupEnv(filePath, {
      BOTWX_CLI: 'claude-code',
      BOTWX_WORKING_DIR: '/srv/next',
      BACKEND_TYPE: 'pty',
    });
    const body = readFileSync(filePath, 'utf8');
    expect(body).toContain('UNRELATED=value');
    expect(body).toContain('BOTWX_CLI="claude-code"');
    expect(body.match(/^BOTWX_CLI=/gm)).toHaveLength(1);
    expect(body).toContain('BOTWX_WORKING_DIR="/srv/next"');
    expect(body).toContain('BACKEND_TYPE="pty"');
    if (process.platform !== 'win32') expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('detects a CLI, writes configuration, and performs first-time WeChat login', async () => {
    const root = tempRoot();
    const workspace = join(root, 'workspace');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(workspace);
    const io = scriptedIo(['', '', '']);
    const login = vi.fn(async () => 'wx-account');
    const env: NodeJS.ProcessEnv = {};

    await runBotwxSetup([], {
      commandExists: command => command === 'codex' || command === 'tmux',
      cwd: workspace,
      env,
      homeDir: root,
      io,
      isLoggedIn: () => false,
      login,
    });

    expect(login).toHaveBeenCalledOnce();
    expect(env.OPENCLAW_STATE_DIR).toBe(join(root, '.botwx'));
    const body = readFileSync(join(root, '.botwx', '.env'), 'utf8');
    expect(body).toContain('BOTWX_CLI="codex-app"');
    expect(body).toContain(`BOTWX_WORKING_DIR=${JSON.stringify(realpathSync(workspace))}`);
    expect(body).toContain('BACKEND_TYPE="tmux"');
    expect(io.output.join('')).toContain('设置完成');
  });

  it('falls back to PTY and skips duplicate login for an existing account', async () => {
    const root = tempRoot();
    const io = scriptedIo(['', '']);
    const login = vi.fn(async () => 'unexpected');

    await runBotwxSetup([], {
      commandExists: command => command === 'claude',
      cwd: root,
      env: {},
      homeDir: root,
      io,
      isLoggedIn: () => true,
      login,
    });

    expect(login).not.toHaveBeenCalled();
    expect(readFileSync(join(root, '.botwx', '.env'), 'utf8')).toContain('BACKEND_TYPE="pty"');
    expect(io.output.join('')).toContain('自动使用 PTY');
    expect(io.output.join('')).toContain('模型: claude-sonnet-5-5');
  });
});
