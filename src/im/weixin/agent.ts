import type { Agent, ChatRequest, ChatResponse } from 'weixin-agent-sdk';
import { BotwxCoreClient } from './core-client.js';
import { ConversationRegistry } from './conversation-registry.js';
import type { BotwxScheduler } from './scheduler.js';

/** Per-conversation FIFO: protects a single CLI session from concurrent turns. */
class ConversationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const predecessor = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = predecessor.catch(() => undefined).then(() => current);
    this.tails.set(key, tail);
    await predecessor.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
export interface BotwxWeixinAgentOptions {
  core: BotwxCoreClient;
  conversations: ConversationRegistry;
  scheduler?: BotwxScheduler;
}

/** weixin-agent-sdk adapter backed by one persistent Botmux headless session per user. */
export class BotwxWeixinAgent implements Agent {
  private readonly queue = new ConversationQueue();

  constructor(private readonly options: BotwxWeixinAgentOptions) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const conversationId = request.conversationId.trim();
    if (!conversationId) throw new Error('微信消息缺少 conversationId');
    const sessionId = this.options.conversations.sessionIdFor(conversationId);
    const ownerKey = this.options.conversations.conversationKeyFor(conversationId);
    return this.queue.run(sessionId, async () => {
      await this.options.scheduler?.noteInbound(ownerKey);
      const scheduleReply = await this.options.scheduler?.handleMessage({
        ownerKey,
        text: request.text,
      });
      if (scheduleReply) return { text: scheduleReply };
      const text = await this.options.core.chat(sessionId, request);
      return { text };
    });
  }

  /** Execute one connector-owned schedule in its isolated, reusable session. */
  async runScheduled(sessionId: string, prompt: string): Promise<string> {
    return this.queue.run(sessionId, () => this.options.core.chat(sessionId, {
      conversationId: sessionId,
      text: [
        '这是由 Botwx 微信连接器按用户已确认的计划触发的定时任务。',
        '请直接执行下面的任务并返回完整最终报告；宿主会自动把最终文本发送到微信。',
        '不要尝试再次创建定时任务，也不要调用 botmux schedule、botmux send 或飞书/Lark 工具。',
        '',
        prompt,
      ].join('\n'),
    }));
  }

  clearSession(conversationId: string): void {
    this.options.conversations.rotate(conversationId);
  }
}
