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
  defaultModel?: string;
  modelChoices?: readonly string[];
  scheduler?: BotwxScheduler;
}

/** weixin-agent-sdk adapter backed by one persistent Botmux headless session per user. */
export class BotwxWeixinAgent implements Agent {
  private readonly queue = new ConversationQueue();

  constructor(private readonly options: BotwxWeixinAgentOptions) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const conversationId = request.conversationId.trim();
    if (!conversationId) throw new Error('微信消息缺少 conversationId');
    const ownerKey = this.options.conversations.conversationKeyFor(conversationId);
    return this.queue.run(ownerKey, async () => {
      await this.options.scheduler?.noteInbound(ownerKey);
      const modelReply = this.handleModelCommand(conversationId, request.text);
      if (modelReply) return { text: modelReply };
      const scheduleReply = await this.options.scheduler?.handleMessage({
        ownerKey,
        text: request.text,
      });
      if (scheduleReply) return { text: scheduleReply };
      // Resolve after waiting for the owner queue: a preceding /model command
      // may have rotated the session while this message was queued.
      const sessionId = this.options.conversations.sessionIdFor(conversationId);
      const model = this.options.conversations.modelForOwnerKey(ownerKey)
        ?? this.options.defaultModel;
      const text = await this.options.core.chat(sessionId, request, { model });
      return { text };
    });
  }

  private handleModelCommand(conversationId: string, text: string): string | undefined {
    const match = text.trim().match(/^\/model(?:\s+([\s\S]*))?$/i);
    if (!match) return undefined;
    const argument = (match[1] ?? '').trim();
    const selected = this.options.conversations.modelFor(conversationId);
    const effective = selected ?? this.options.defaultModel;
    const choices = [...new Set(this.options.modelChoices ?? [])];
    const effectiveLabel = effective ?? 'Agent 默认';

    if (argument === '' || argument.toLowerCase() === 'current') {
      return [
        `当前模型：${effectiveLabel}${selected ? '（本对话选择）' : '（Botwx 默认）'}`,
        '查看可选模型：/model list',
        '切换模型：/model <模型名>',
        '恢复默认：/model default',
      ].join('\n');
    }
    if (argument.toLowerCase() === 'list') {
      if (choices.length === 0) {
        return `当前模型：${effectiveLabel}\n当前 Agent 没有提供可枚举的模型列表。`;
      }
      return [
        `当前模型：${effectiveLabel}`,
        '可选模型：',
        ...choices.map(model => `${model === effective ? '→' : '·'} ${model}`),
        '',
        '发送 /model <模型名> 切换。',
      ].join('\n');
    }
    if (argument.toLowerCase() === 'default') {
      if (selected === undefined) return `当前已经使用默认模型：${effectiveLabel}`;
      this.options.conversations.selectModel(conversationId, undefined);
      return `✅ 已恢复默认模型：${this.options.defaultModel ?? 'Agent 默认'}\n已自动创建新会话。`;
    }

    const requested = argument.replace(/^use\s+/i, '').trim();
    const resolved = choices.find(choice => choice.toLowerCase() === requested.toLowerCase());
    if (choices.length > 0 && !resolved) {
      return `❌ 当前 Agent 不支持或未列出模型：${requested}\n发送 /model list 查看可选模型。`;
    }
    const model = resolved ?? requested;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model)) {
      return '❌ 模型名格式无效。发送 /model list 查看可选模型。';
    }
    if (model === effective) return `当前已经使用模型：${model}`;
    this.options.conversations.selectModel(conversationId, model);
    return `✅ 已切换模型：${model}\n已自动创建新会话，下一条消息开始生效。`;
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
