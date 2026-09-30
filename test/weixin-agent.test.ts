import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotwxWeixinAgent } from '../src/im/weixin/agent.js';
import { ConversationRegistry } from '../src/im/weixin/conversation-registry.js';
import type { BotwxCoreClient } from '../src/im/weixin/core-client.js';
import type { BotwxScheduler } from '../src/im/weixin/scheduler.js';

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

  it('handles connector-native schedules without asking the Agent CLI', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botwx-agent-'));
    roots.push(root);
    const core = { chat: vi.fn() } as unknown as BotwxCoreClient;
    const scheduler = {
      noteInbound: vi.fn(async () => undefined),
      handleMessage: vi.fn(async () => '✅ 已创建微信定时任务 [1234abcd]'),
    } as unknown as BotwxScheduler;
    const agent = new BotwxWeixinAgent({
      core,
      scheduler,
      conversations: new ConversationRegistry(join(root, 'conversations.json')),
    });

    await expect(agent.chat({
      conversationId: 'wx-user',
      text: '帮我写一个定时任务，每天晚上11点执行，生成市场复盘',
    })).resolves.toEqual({ text: '✅ 已创建微信定时任务 [1234abcd]' });
    expect(scheduler.noteInbound).toHaveBeenCalledOnce();
    expect(scheduler.handleMessage).toHaveBeenCalledOnce();
    expect(core.chat).not.toHaveBeenCalled();
  });

  it('lists, switches, persists, and resets models from WeChat commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botwx-agent-'));
    roots.push(root);
    const file = join(root, 'conversations.json');
    const calls: Array<{ sessionId: string; model?: string }> = [];
    const core = {
      chat: vi.fn(async (sessionId: string, _request: unknown, options?: { model?: string }) => {
        calls.push({ sessionId, model: options?.model });
        return 'agent reply';
      }),
    } as unknown as BotwxCoreClient;
    const agent = new BotwxWeixinAgent({
      core,
      conversations: new ConversationRegistry(file),
      defaultModel: 'claude-sonnet-5-5',
      modelChoices: ['claude-sonnet-5-5', 'sonnet', 'opus'],
    });

    await expect(agent.chat({ conversationId: 'wx-user', text: '/model list' }))
      .resolves.toMatchObject({ text: expect.stringContaining('claude-sonnet-5-5') });
    expect(core.chat).not.toHaveBeenCalled();

    const switchModel = agent.chat({ conversationId: 'wx-user', text: '/model sonnet' });
    const firstSonnetTurn = agent.chat({ conversationId: 'wx-user', text: 'hello' });
    await expect(switchModel)
      .resolves.toEqual({ text: '✅ 已切换模型：sonnet\n已自动创建新会话，下一条消息开始生效。' });
    await expect(firstSonnetTurn)
      .resolves.toEqual({ text: 'agent reply' });
    expect(calls[0]?.model).toBe('sonnet');
    expect(new ConversationRegistry(file).modelFor('wx-user')).toBe('sonnet');

    await expect(agent.chat({ conversationId: 'wx-user', text: '/model default' }))
      .resolves.toEqual({ text: '✅ 已恢复默认模型：claude-sonnet-5-5\n已自动创建新会话。' });
    await agent.chat({ conversationId: 'wx-user', text: 'again' });
    expect(calls[1]?.model).toBe('claude-sonnet-5-5');
    expect(calls[1]?.sessionId).not.toBe(calls[0]?.sessionId);
  });

  it('rejects unknown models without changing the session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botwx-agent-'));
    roots.push(root);
    const conversations = new ConversationRegistry(join(root, 'conversations.json'));
    const sessionId = conversations.sessionIdFor('wx-user');
    const core = { chat: vi.fn() } as unknown as BotwxCoreClient;
    const agent = new BotwxWeixinAgent({
      core,
      conversations,
      defaultModel: 'claude-sonnet-5-5',
      modelChoices: ['claude-sonnet-5-5', 'sonnet'],
    });

    await expect(agent.chat({ conversationId: 'wx-user', text: '/model imaginary-model' }))
      .resolves.toMatchObject({ text: expect.stringContaining('不支持或未列出模型') });
    expect(conversations.sessionIdFor('wx-user')).toBe(sessionId);
    expect(core.chat).not.toHaveBeenCalled();
  });
});
