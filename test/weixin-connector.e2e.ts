import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { start } from 'weixin-agent-sdk';
import { BotwxWeixinAgent } from '../src/im/weixin/agent.js';
import { ConversationRegistry } from '../src/im/weixin/conversation-registry.js';
import { BotwxCoreClient } from '../src/im/weixin/core-client.js';

const roots: string[] = [];
const servers: Server[] = [];
const originalStateDir = process.env.OPENCLAW_STATE_DIR;

afterEach(async () => {
  process.env.OPENCLAW_STATE_DIR = originalStateDir;
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');
  return address.port;
}

async function bodyOf(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

describe('WeChat connector end to end', () => {
  it('long-polls with the real SDK, executes through the core API, and replies to WeChat', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botwx-e2e-'));
    roots.push(root);
    process.env.OPENCLAW_STATE_DIR = root;

    let updateDelivered = false;
    let coreRequest: Record<string, any> | undefined;
    let sentMessage: Record<string, any> | undefined;
    let resolveSent!: () => void;
    const sent = new Promise<void>(resolve => { resolveSent = resolve; });

    const server = createServer(async (request, response) => {
      const path = request.url ?? '';
      if (path === '/ilink/bot/getupdates') {
        await bodyOf(request);
        response.setHeader('content-type', 'application/json');
        if (!updateDelivered) {
          updateDelivered = true;
          response.end(JSON.stringify({
            ret: 0,
            get_updates_buf: 'cursor-1',
            msgs: [{
              from_user_id: 'wx-user-e2e',
              create_time_ms: Date.now(),
              context_token: 'ctx-e2e',
              item_list: [{ type: 1, text_item: { text: '请完成端到端测试' } }],
            }],
          }));
        } else {
          response.end(JSON.stringify({ ret: 0, get_updates_buf: 'cursor-1', msgs: [] }));
        }
        return;
      }
      if (path === '/ilink/bot/getconfig') {
        await bodyOf(request);
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ret: 0, typing_ticket: '' }));
        return;
      }
      if (path === '/api/trigger') {
        coreRequest = await bodyOf(request) as Record<string, any>;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ok: true, output: { content: '**Botwx E2E OK**' } }));
        return;
      }
      if (path === '/ilink/bot/sendmessage') {
        sentMessage = await bodyOf(request) as Record<string, any>;
        response.setHeader('content-type', 'application/json');
        response.end('{}');
        resolveSent();
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    servers.push(server);
    const port = await listen(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    const accountRoot = join(root, 'openclaw-weixin');
    mkdirSync(join(accountRoot, 'accounts'), { recursive: true });
    writeFileSync(join(accountRoot, 'accounts.json'), JSON.stringify(['e2e-account']));
    writeFileSync(join(accountRoot, 'accounts', 'e2e-account.json'), JSON.stringify({
      token: 'test-token',
      baseUrl,
      userId: 'wx-user-e2e',
    }));

    const core = new BotwxCoreClient({
      baseUrl,
      botId: 'local_botwx',
      timeoutMs: 5_000,
    });
    const agent = new BotwxWeixinAgent({
      core,
      conversations: new ConversationRegistry(join(root, 'conversations.json')),
    });
    const abortController = new AbortController();
    const bot = start(agent, {
      accountId: 'e2e-account',
      abortSignal: abortController.signal,
      log: () => undefined,
    });

    await Promise.race([
      sent,
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for outbound WeChat message')), 10_000)),
    ]);
    abortController.abort();
    await bot.wait();

    expect(coreRequest?.source).toMatchObject({
      type: 'headless',
      connectorId: 'weixin-agent-sdk',
    });
    expect(coreRequest?.source.requestId).toMatch(/^hl_wx_[A-Za-z0-9_-]{43}$/);
    expect(coreRequest?.envelope.rawText).toBe('请完成端到端测试');
    expect(sentMessage?.msg.to_user_id).toBe('wx-user-e2e');
    expect(sentMessage?.msg.context_token).toBe('ctx-e2e');
    expect(sentMessage?.msg.item_list[0].text_item.text).toBe('Botwx E2E OK');
  });
});
