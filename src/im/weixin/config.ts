import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export const BOTWX_DEFAULT_API_PORT = 7960;
export const BOTWX_MIN_TURN_TIMEOUT_MS = 1_000;
export const BOTWX_MAX_TURN_TIMEOUT_MS = 300_000;
export const BOTWX_DEFAULT_TURN_TIMEOUT_MS = BOTWX_MAX_TURN_TIMEOUT_MS;

export type BotwxReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export interface BotwxConfig {
  accountId?: string;
  apiPort: number;
  botId: string;
  cliId: string;
  engineStateDir: string;
  model?: string;
  reasoningEffort?: BotwxReasoningEffort;
  stateDir: string;
  turnTimeoutMs: number;
  weixinStateDir: string;
  workingDir: string;
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  max = Number.MAX_SAFE_INTEGER,
  min = 1,
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}; got ${value}`);
  }
  return parsed;
}

function absolutePath(value: string | undefined, fallback: string, cwd: string): string {
  const selected = nonBlank(value) ?? fallback;
  return isAbsolute(selected) ? resolve(selected) : resolve(cwd, selected);
}

function reasoningEffort(value: string | undefined): BotwxReasoningEffort | undefined {
  const normalized = nonBlank(value);
  if (!normalized) return undefined;
  if (['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(normalized)) {
    return normalized as BotwxReasoningEffort;
  }
  throw new Error(`BOTWX_REASONING_EFFORT is invalid: ${normalized}`);
}

/** Read and validate the connector's complete process-level configuration. */
export function readBotwxConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: { cwd?: string; homeDir?: string } = {},
): BotwxConfig {
  const cwd = options.cwd ?? process.cwd();
  const stateDir = absolutePath(
    env.BOTWX_STATE_DIR,
    join(options.homeDir ?? homedir(), '.botwx'),
    cwd,
  );
  const botId = nonBlank(env.BOTWX_BOT_ID) ?? 'local_botwx';
  if (!/^local_[A-Za-z0-9._-]+$/.test(botId)) {
    throw new Error(`BOTWX_BOT_ID must match local_<slug>; got ${botId}`);
  }

  return {
    accountId: nonBlank(env.BOTWX_ACCOUNT_ID),
    apiPort: positiveInteger(env.BOTWX_API_PORT, BOTWX_DEFAULT_API_PORT, 'BOTWX_API_PORT', 65_535),
    botId,
    cliId: nonBlank(env.BOTWX_CLI) ?? 'codex-app',
    engineStateDir: absolutePath(env.BOTWX_ENGINE_STATE_DIR, join(stateDir, 'engine'), cwd),
    model: nonBlank(env.BOTWX_MODEL),
    reasoningEffort: reasoningEffort(env.BOTWX_REASONING_EFFORT),
    stateDir,
    turnTimeoutMs: positiveInteger(
      env.BOTWX_TURN_TIMEOUT_MS,
      BOTWX_DEFAULT_TURN_TIMEOUT_MS,
      'BOTWX_TURN_TIMEOUT_MS',
      BOTWX_MAX_TURN_TIMEOUT_MS,
      BOTWX_MIN_TURN_TIMEOUT_MS,
    ),
    weixinStateDir: absolutePath(env.BOTWX_WEIXIN_STATE_DIR, stateDir, cwd),
    workingDir: absolutePath(env.BOTWX_WORKING_DIR, cwd, cwd),
  };
}
