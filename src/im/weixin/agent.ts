import type { Agent, ChatRequest, ChatResponse } from 'weixin-agent-sdk';
import { BotwxCoreClient } from './core-client.js';
import { ConversationRegistry } from './conversation-registry.js';

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
}

/** weixin-agent-sdk adapter backed by one persistent Botmux headless session per user. */
export class BotwxWeixinAgent implements Agent {
  private readonly queue = new ConversationQueue();

  constructor(private readonly options: BotwxWeixinAgentOptions) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const conversationId = request.conversationId.trim();
    if (!conversationId) throw new Error('微信消息缺少 conversationId');
    return this.queue.run(conversationId, async () => {
      const sessionId = this.options.conversations.sessionIdFor(conversationId);
      const text = await this.options.core.chat(sessionId, request);
      return { text };
    });
  }

  clearSession(conversationId: string): void {
    this.options.conversations.rotate(conversationId);
  }
}
