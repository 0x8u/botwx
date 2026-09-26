import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotwxWeixinAgent } from '../src/im/weixin/agent.js';
import { ConversationRegistry } from '../src/im/weixin/conversation-registry.js';
import type { BotwxCoreClient } from '../src/im/weixin/core-client.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('BotwxWeixinAgent', () => {
  it('keeps conversation continuity and rotates on /clear', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botwx-agent-'));
    roots.push(root);
    const seen: string[] = [];
    const core = {
      chat: vi.fn(async (sessionId: string) => {
        seen.push(sessionId);
        return `reply-${seen.length}`;
      }),
    } as unknown as BotwxCoreClient;
    const conversations = new ConversationRegistry(join(root, 'conversations.json'));
    const agent = new BotwxWeixinAgent({ core, conversations });

    await expect(agent.chat({ conversationId: 'u1', text: 'one' })).resolves.toEqual({ text: 'reply-1' });
    await expect(agent.chat({ conversationId: 'u1', text: 'two' })).resolves.toEqual({ text: 'reply-2' });
    expect(seen[1]).toBe(seen[0]);

    agent.clearSession('u1');
    await agent.chat({ conversationId: 'u1', text: 'fresh' });
    expect(seen[2]).not.toBe(seen[0]);
  });

  it('serializes concurrent turns for the same WeChat user', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botwx-agent-'));
    roots.push(root);
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const core = {
      chat: vi.fn(async (_sessionId: string, request: { text: string }) => {
        order.push(`start:${request.text}`);
        if (request.text === 'one') await firstGate;
        order.push(`end:${request.text}`);
        return request.text;
      }),
    } as unknown as BotwxCoreClient;
    const agent = new BotwxWeixinAgent({
      core,
      conversations: new ConversationRegistry(join(root, 'conversations.json')),
    });

    const first = agent.chat({ conversationId: 'same', text: 'one' });
    const second = agent.chat({ conversationId: 'same', text: 'two' });
    await vi.waitFor(() => expect(order).toEqual(['start:one']));
    expect(order).toEqual(['start:one']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
  });
});
