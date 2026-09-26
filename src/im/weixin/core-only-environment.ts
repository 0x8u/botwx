import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { config as dotenvConfig } from 'dotenv';
import {
  scrubClaudeSessionMarkerEnv,
  scrubInvokerTerminalEnv,
  scrubSessionCliHomeEnv,
  scrubSessionTurnMarkerEnv,
  scrubWorkflowWorkerEnv,
  stripCompanionStartupEnv,
  stripDashboardH5Env,
} from '../../utils/child-env.js';
import { installStdioEpipeGuard } from '../../utils/stdio-epipe-guard.js';
import type { BotwxConfig } from './config.js';

let prepared = false;

/** Load Botwx's own dotenv file without consulting the legacy Botmux location. */
export function loadBotwxDotenv(): void {
  const userEnv = join(homedir(), '.botwx', '.env');
  dotenvConfig({ path: existsSync(userEnv) ? userEnv : '.env', quiet: true });
}
/**
 * Freeze the inherited process environment before any Botmux module is loaded.
 * This makes the execution core an apiOnly bot with no Feishu credentials,
 * subscriptions, client construction, or outbound delivery path.
 */
export function prepareBotwxCoreEnvironment(config: BotwxConfig): void {
  if (prepared) return;
  prepared = true;
  installStdioEpipeGuard();

  stripDashboardH5Env(process.env);
  stripCompanionStartupEnv(process.env);
  scrubSessionTurnMarkerEnv(process.env);
  scrubSessionCliHomeEnv(process.env);
  scrubClaudeSessionMarkerEnv(process.env);
  scrubWorkflowWorkerEnv(process.env);
  scrubInvokerTerminalEnv(process.env);

  process.env.TERM = 'xterm-256color';
  process.env.BOTMUX_CORE_ONLY = '1';
  process.env.BOTMUX_API_PORT = String(config.apiPort);
  process.env.BOTMUX_API_ONLY_BOT = config.botId;
  process.env.BOTMUX_CORE_CLI = config.cliId;
  process.env.BOTMUX_CORE_WORKING_DIR = config.workingDir;
  process.env.BOTMUX_CORE_STATE_DIR = config.engineStateDir;
  process.env.SESSION_DATA_DIR = config.engineStateDir;
  process.env.BOTMUX_WORKER_HTTP_HOST = '127.0.0.1';
  process.env.WEB_EXTERNAL_HOST = '127.0.0.1';
  process.env.OPENCLAW_STATE_DIR = config.weixinStateDir;
  if (config.model) process.env.BOTMUX_CORE_MODEL = config.model;
  else delete process.env.BOTMUX_CORE_MODEL;

  // Core-only identity and storage are authoritative. Ambient fleet values
  // must never redirect this process to real connector credentials or state.
  delete process.env.BOTS_CONFIG;
  delete process.env.BOTMUX_WORKER_HOST;

  mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  mkdirSync(config.engineStateDir, { recursive: true, mode: 0o700 });
  mkdirSync(config.weixinStateDir, { recursive: true, mode: 0o700 });
}
