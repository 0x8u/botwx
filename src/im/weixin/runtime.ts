import { join } from 'node:path';
import {
  isLoggedIn,
  start as startWeixin,
  type Bot,
} from 'weixin-agent-sdk';
import { BotwxWeixinAgent } from './agent.js';
import { readBotwxConfig, type BotwxConfig } from './config.js';
import { ConversationRegistry } from './conversation-registry.js';
import { BotwxCoreClient } from './core-client.js';
import { prepareBotwxCoreEnvironment } from './core-only-environment.js';

export interface RunningBotwx {
  bot: Bot;
  config: BotwxConfig;
}
export async function startBotwx(config = readBotwxConfig()): Promise<RunningBotwx> {
  prepareBotwxCoreEnvironment(config);
  if (!isLoggedIn()) {
    throw new Error('微信尚未登录。请先运行 `botwx login` 扫码登录。');
  }

  // Dynamic import is security-significant: daemon/config modules read their
  // transport and storage mode at module initialization time.
  const { startDaemon } = await import('../../daemon.js');
  await startDaemon();

  const core = new BotwxCoreClient({
    baseUrl: `http://127.0.0.1:${config.apiPort}`,
    botId: config.botId,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    timeoutMs: config.turnTimeoutMs,
  });
  await core.waitUntilReady();

  const conversations = new ConversationRegistry(join(config.stateDir, 'conversations.json'));
  const agent = new BotwxWeixinAgent({ core, conversations });
  const abortController = new AbortController();
  const stopMonitor = () => abortController.abort();
  process.once('SIGTERM', stopMonitor);
  process.once('SIGINT', stopMonitor);

  const bot = startWeixin(agent, {
    accountId: config.accountId,
    abortSignal: abortController.signal,
    log: message => console.log(message),
  });
  return { bot, config };
}
