import type { ChatRequest } from 'weixin-agent-sdk';
import type { BotwxReasoningEffort } from './config.js';

interface TriggerResponse {
  ok?: boolean;
  output?: { content?: unknown };
  error?: unknown;
  errorCode?: unknown;
}
export interface BotwxCoreClientOptions {
  baseUrl: string;
  botId: string;
  model?: string;
  reasoningEffort?: BotwxReasoningEffort;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export interface BotwxTurnOptions {
  /** Per-conversation override. Omit to use the process-level default. */
  model?: string;
}

function mediaEnvelope(media: ChatRequest['media']): Record<string, string> | undefined {
  if (!media) return undefined;
  return {
    type: media.type,
    filePath: media.filePath,
    mimeType: media.mimeType,
    ...(media.fileName ? { fileName: media.fileName } : {}),
  };
}

function responseError(status: number, body: TriggerResponse): Error {
  const code = typeof body.errorCode === 'string' ? body.errorCode : 'trigger_failed';
  const message = typeof body.error === 'string' ? body.error : `Botwx core returned HTTP ${status}`;
  return new Error(`${code}: ${message}`);
}

/** Minimal, typed client for Botmux's no-transport core-only control plane. */
export class BotwxCoreClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: BotwxCoreClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(
    sessionId: string,
    request: ChatRequest,
    turnOptions: BotwxTurnOptions = {},
  ): Promise<string> {
    const controller = new AbortController();
    const clientTimeoutMs = this.options.timeoutMs + 10_000;
    const timeout = setTimeout(() => controller.abort(), clientTimeoutMs);
    try {
      const media = mediaEnvelope(request.media);
      const model = turnOptions.model ?? this.options.model;
      const response = await this.fetchImpl(new URL('/api/trigger', this.options.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          source: {
            type: 'headless',
            connectorId: 'weixin-agent-sdk',
            requestId: sessionId,
            receivedAt: new Date().toISOString(),
          },
          target: { kind: 'turn', botId: this.options.botId },
          envelope: {
            format: 'botwx.weixin.v1',
            sourceName: 'WeChat',
            trusted: false,
            headers: {
              channel: 'weixin-agent-sdk',
              ...(media ? { media } : {}),
            },
            rawText: request.text,
            ...(media ? { payload: { attachment: media } } : {}),
          },
          instruction: media
            ? 'Reply to the WeChat user. A decrypted local attachment is described in the event payload; inspect it when relevant to the request.'
            : 'Reply to the WeChat user directly and concisely.',
          presentation: { title: 'WeChat conversation', topicMessage: null },
          options: {
            waitForFinalOutput: true,
            timeoutMs: this.options.timeoutMs,
            ...(model ? { model } : {}),
            ...(this.options.reasoningEffort ? { reasoningEffort: this.options.reasoningEffort } : {}),
          },
        }),
      });
      const raw = await response.text();
      let body: TriggerResponse;
      try {
        body = raw ? JSON.parse(raw) as TriggerResponse : {};
      } catch {
        throw new Error(`Botwx core returned invalid JSON (HTTP ${response.status})`);
      }
      if (!response.ok || body.ok !== true) throw responseError(response.status, body);
      const content = body.output?.content;
      if (typeof content !== 'string') throw new Error('Botwx core completed without text output');
      return content;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Botwx core request timed out after ${clientTimeoutMs}ms`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async waitUntilReady(options: { timeoutMs?: number; intervalMs?: number } = {}): Promise<void> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const intervalMs = options.intervalMs ?? 200;
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        const response = await this.fetchImpl(new URL('/healthz', this.options.baseUrl));
        if (response.ok) return;
        lastError = new Error(`HTTP ${response.status}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    const suffix = lastError instanceof Error ? `: ${lastError.message}` : '';
    throw new Error(`Botwx core did not become ready within ${timeoutMs}ms${suffix}`);
  }
}
