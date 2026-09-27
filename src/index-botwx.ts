#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { isLoggedIn, login, logout } from 'weixin-agent-sdk';
import { readBotwxConfig } from './im/weixin/config.js';
import { loadBotwxDotenv } from './im/weixin/core-only-environment.js';

const HELP = `botwx — 微信 ↔ AI 编程 Agent

用法:
  botwx setup     选择 Agent/工作目录并扫码连接微信
  botwx login     扫码登录微信
  botwx start     前台启动微信连接器与 Agent 内核
  botwx status    检查微信登录状态
  botwx logout    删除 weixin-agent-sdk 登录凭据

常用环境变量:
  BOTWX_CLI                 Agent 适配器，默认 codex-app
  BOTWX_WORKING_DIR         Agent 工作目录，默认当前目录
  BOTWX_MODEL               可选模型覆盖
  BOTWX_REASONING_EFFORT    low|medium|high|xhigh|max|ultra
  BOTWX_TURN_TIMEOUT_MS     单轮超时，范围 1000–300000，默认 300000
  BOTWX_TIMEZONE            微信定时任务时区，默认跟随系统
  BOTWX_STATE_DIR           状态目录，默认 ~/.botwx
  BOTWX_ACCOUNT_ID          多账号时显式选择账号
`;

async function main(argv = process.argv.slice(2)): Promise<void> {
  loadBotwxDotenv();
  const command = argv[0] ?? 'start';
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(HELP);
    return;
  }

  if (command === 'setup') {
    const { runBotwxSetup } = await import('./im/weixin/setup.js');
    await runBotwxSetup(argv.slice(1));
    return;
  }

  const config = readBotwxConfig();
  process.env.OPENCLAW_STATE_DIR = config.weixinStateDir;
  mkdirSync(config.weixinStateDir, { recursive: true, mode: 0o700 });

  if (command === 'login') {
    await login();
    return;
  }
  if (command === 'logout') {
    logout();
    return;
  }
  if (command === 'status') {
    console.log(isLoggedIn() ? '✅ 微信已登录' : '❌ 微信未登录');
    process.exitCode = isLoggedIn() ? 0 : 1;
    return;
  }
  if (command !== 'start') {
    throw new Error(`未知命令: ${command}\n\n${HELP}`);
  }

  const { startBotwx } = await import('./im/weixin/runtime.js');
  const { bot } = await startBotwx(config);
  console.log(`✅ botwx 已启动（${config.cliId} · 127.0.0.1:${config.apiPort}）`);
  await bot.wait();
}

main().catch(error => {
  console.error(`botwx: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
