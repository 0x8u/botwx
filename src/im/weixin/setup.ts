import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { isLoggedIn, login } from 'weixin-agent-sdk';
import { readBotwxConfig } from './config.js';

type SetupBackend = 'tmux' | 'pty';

interface CliChoice {
  id: string;
  label: string;
  command: string;
}

const CLI_CHOICES: readonly CliChoice[] = [
  { id: 'codex-app', label: 'Codex App（推荐，结构化协议）', command: 'codex' },
  { id: 'codex', label: 'Codex CLI', command: 'codex' },
  { id: 'claude-code', label: 'Claude Code', command: 'claude' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini' },
];

export interface BotwxSetupOptions {
  backend?: SetupBackend;
  cliId?: string;
  skipLogin: boolean;
  workingDir?: string;
}

export interface SetupIo {
  question(prompt: string): Promise<string>;
  write(message: string): void;
  close?(): void;
}

export interface BotwxSetupDependencies {
  commandExists?: (command: string) => boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  io?: SetupIo;
  isLoggedIn?: () => boolean;
  login?: () => Promise<string>;
}

const SETUP_HELP = `botwx setup — 初始化微信 Agent

用法:
  botwx setup [--cli <id>] [--working-dir <path>] [--backend tmux|pty] [--skip-login]

选项:
  --cli           codex-app、codex、claude-code 或 gemini
  --working-dir   Agent 可以访问的项目目录
  --backend       tmux（可恢复）或 pty（无 tmux 时使用）
  --skip-login    只写配置，不启动微信扫码
`;

export function botwxSetupHelp(): string {
  return SETUP_HELP;
}

export function parseBotwxSetupArgs(argv: readonly string[]): BotwxSetupOptions & { help: boolean } {
  const options: BotwxSetupOptions & { help: boolean } = { help: false, skipLogin: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--skip-login') options.skipLogin = true;
    else if (argument === '--cli') options.cliId = requiredValue(argv, ++index, argument);
    else if (argument === '--working-dir') options.workingDir = requiredValue(argv, ++index, argument);
    else if (argument === '--backend') {
      const value = requiredValue(argv, ++index, argument);
      if (value !== 'tmux' && value !== 'pty') throw new Error(`--backend 仅支持 tmux 或 pty；收到 ${value}`);
      options.backend = value;
    } else {
      throw new Error(`未知 setup 参数: ${argument}\n\n${SETUP_HELP}`);
    }
  }
  return options;
}

function requiredValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index]?.trim();
  if (!value || value.startsWith('--')) throw new Error(`${flag} 缺少参数值`);
  return value;
}

function defaultCommandExists(command: string): boolean {
  const result = spawnSync('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command], {
    stdio: 'ignore',
  });
  return result.status === 0;
}

function environmentValue(value: string): string {
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) {
    throw new Error('配置值不能包含换行或 NUL 字符');
  }
  return JSON.stringify(value);
}

/** Update selected dotenv keys without discarding comments or unrelated settings. */
export function writeBotwxSetupEnv(filePath: string, updates: Readonly<Record<string, string>>): void {
  const parent = dirname(filePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const source = existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
  const pending = new Map(Object.entries(updates));
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const line of source.split(/\r?\n/)) {
    const match = /^([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    const key = match?.[1];
    if (!key || !pending.has(key)) {
      lines.push(line);
      continue;
    }
    if (!seen.has(key)) {
      lines.push(`${key}=${environmentValue(pending.get(key)!)}`);
      seen.add(key);
    }
  }
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  for (const [key, value] of pending) {
    if (!seen.has(key)) lines.push(`${key}=${environmentValue(value)}`);
  }

  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporary, filePath);
    try { chmodSync(filePath, 0o600); } catch { /* best effort on non-POSIX filesystems */ }
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch { /* preserve the original error */ }
    throw error;
  }
}

function validateCli(cliId: string, commandExists: (command: string) => boolean): CliChoice {
  const choice = CLI_CHOICES.find(candidate => candidate.id === cliId);
  if (!choice) throw new Error(`不支持的 CLI: ${cliId}；可选 ${CLI_CHOICES.map(item => item.id).join('、')}`);
  if (!commandExists(choice.command)) {
    throw new Error(`BOTWX_CLI=${cliId} 需要本机命令 \`${choice.command}\`，请先安装并完成登录`);
  }
  return choice;
}

async function chooseCli(
  requested: string | undefined,
  io: SetupIo,
  commandExists: (command: string) => boolean,
): Promise<CliChoice> {
  if (requested) return validateCli(requested, commandExists);
  const available = CLI_CHOICES.filter(choice => commandExists(choice.command));
  if (available.length === 0) {
    throw new Error('未检测到可用 Agent CLI；请先安装并登录 codex、claude 或 gemini');
  }
  io.write('\n选择 Agent CLI：\n');
  available.forEach((choice, index) => io.write(`  ${index + 1}. ${choice.label} [${choice.id}]\n`));
  for (;;) {
    const answer = (await io.question(`选择 [1]: `)).trim();
    const selected = answer === '' ? 0 : Number(answer) - 1;
    if (Number.isInteger(selected) && selected >= 0 && selected < available.length) return available[selected];
    io.write(`请输入 1-${available.length}。\n`);
  }
}

function existingDirectory(value: string, cwd: string): string | undefined {
  const candidate = resolve(cwd, value);
  try {
    if (!statSync(candidate).isDirectory()) return undefined;
    return realpathSync(candidate);
  } catch {
    return undefined;
  }
}

async function chooseWorkingDir(requested: string | undefined, cwd: string, io: SetupIo): Promise<string> {
  if (requested) {
    const valid = existingDirectory(requested, cwd);
    if (!valid) throw new Error(`工作目录不存在或不是目录: ${resolve(cwd, requested)}`);
    return valid;
  }
  for (;;) {
    const answer = (await io.question(`Agent 工作目录 [${cwd}]: `)).trim() || cwd;
    const valid = existingDirectory(answer, cwd);
    if (valid) return valid;
    io.write(`目录不存在或不是目录: ${resolve(cwd, answer)}\n`);
  }
}

async function chooseBackend(
  requested: SetupBackend | undefined,
  io: SetupIo,
  commandExists: (command: string) => boolean,
): Promise<SetupBackend> {
  const tmuxAvailable = commandExists('tmux');
  if (requested) {
    if (requested === 'tmux' && !tmuxAvailable) {
      throw new Error('选择了 tmux 后端，但本机未找到 tmux；请安装 tmux 或使用 --backend pty');
    }
    return requested;
  }
  if (!tmuxAvailable) {
    io.write('⚠️  未检测到 tmux，自动使用 PTY；进程重启后无法恢复运行中的会话。\n');
    return 'pty';
  }
  for (;;) {
    const answer = (await io.question('会话后端：1) tmux（推荐，可恢复）  2) PTY [1]: ')).trim();
    if (answer === '' || answer === '1') return 'tmux';
    if (answer === '2') return 'pty';
    io.write('请输入 1 或 2。\n');
  }
}

function defaultIo(): SetupIo {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  return {
    question: prompt => readline.question(prompt),
    write: message => process.stdout.write(message),
    close: () => readline.close(),
  };
}

export async function runBotwxSetup(
  argv: readonly string[],
  dependencies: BotwxSetupDependencies = {},
): Promise<void> {
  const options = parseBotwxSetupArgs(argv);
  if (options.help) {
    (dependencies.io ?? { question: async () => '', write: message => process.stdout.write(message) }).write(SETUP_HELP);
    return;
  }

  const io = dependencies.io ?? defaultIo();
  const commandExists = dependencies.commandExists ?? defaultCommandExists;
  const cwd = resolve(dependencies.cwd ?? process.cwd());
  const home = dependencies.homeDir ?? homedir();
  const env = dependencies.env ?? process.env;
  const checkLogin = dependencies.isLoggedIn ?? isLoggedIn;
  const loginWeixin = dependencies.login ?? (() => login());

  io.write('Botwx 初始化：选择 Agent、工作目录并连接微信。\n');
  try {
    const cli = await chooseCli(options.cliId ?? env.BOTWX_CLI, io, commandExists);
    const workingDir = await chooseWorkingDir(options.workingDir ?? env.BOTWX_WORKING_DIR, cwd, io);
    const backend = await chooseBackend(options.backend, io, commandExists);
    const envPath = join(home, '.botwx', '.env');
    const updates = {
      BOTWX_CLI: cli.id,
      BOTWX_WORKING_DIR: workingDir,
      BACKEND_TYPE: backend,
    };
    writeBotwxSetupEnv(envPath, updates);
    Object.assign(env, updates);

    const config = readBotwxConfig(env, { cwd, homeDir: home });
    mkdirSync(config.weixinStateDir, { recursive: true, mode: 0o700 });
    env.OPENCLAW_STATE_DIR = config.weixinStateDir;

    io.write(`\n✅ 配置已写入 ${envPath}\n`);
    io.write(`   CLI: ${cli.id}\n   工作目录: ${workingDir}\n   后端: ${backend}\n`);

    if (options.skipLogin) {
      io.write('   已跳过微信扫码；稍后运行 `botwx login`。\n');
    } else if (checkLogin()) {
      io.write('✅ 已检测到微信登录，跳过重复扫码。\n');
    } else {
      io.write('\n下一步：使用微信扫描终端二维码。\n');
      await loginWeixin();
    }
    io.write('\n设置完成。运行 `botwx start` 启动服务。\n');
  } finally {
    io.close?.();
  }
}
