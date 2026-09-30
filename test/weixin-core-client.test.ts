import { describe, expect, it, vi } from 'vitest';
import { BotwxCoreClient } from '../src/im/weixin/core-client.js';

describe('BotwxCoreClient', () => {
  it('renders a core-only headless request including attachment metadata', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.source).toMatchObject({
        type: 'headless',
        connectorId: 'weixin-agent-sdk',
        requestId: 'hl_wx_12345678',
      });
      expect(request.target).toEqual({ kind: 'turn', botId: 'local_botwx' });
      expect(request.envelope.payload.attachment).toEqual({
        type: 'image',
        filePath: '/tmp/photo.png',
        mimeType: 'image/png',
        fileName: 'photo.png',
      });
      expect(request.options).toMatchObject({
        waitForFinalOutput: true,
        timeoutMs: 5_000,
        model: 'gpt-test',
        reasoningEffort: 'high',
      });
      return new Response(JSON.stringify({ ok: true, output: { content: 'done' } }));
    });
    const client = new BotwxCoreClient({
      baseUrl: 'http://127.0.0.1:7960',
      botId: 'local_botwx',
      model: 'gpt-test',
      reasoningEffort: 'high',
      timeoutMs: 5_000,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(client.chat('hl_wx_12345678', {
      conversationId: 'user',
      text: '看看这张图',
      media: {
        type: 'image',
        filePath: '/tmp/photo.png',
        mimeType: 'image/png',
        fileName: 'photo.png',
      },
    })).resolves.toBe('done');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('surfaces structured core failures', async () => {
    const client = new BotwxCoreClient({
      baseUrl: 'http://127.0.0.1:7960',
      botId: 'local_botwx',
      timeoutMs: 1_000,
      fetchImpl: (async () => new Response(
        JSON.stringify({ ok: false, errorCode: 'wait_timeout', error: 'too slow' }),
        { status: 504 },
      )) as typeof fetch,
    });
    await expect(client.chat('hl_wx_12345678', {
      conversationId: 'user',
      text: 'hello',
    })).rejects.toThrow('wait_timeout: too slow');
  });

  it('lets a conversation override the process-level model', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request.options.model).toBe('sonnet');
      return new Response(JSON.stringify({ ok: true, output: { content: 'done' } }));
    });
    const client = new BotwxCoreClient({
      baseUrl: 'http://127.0.0.1:7960',
      botId: 'local_botwx',
      model: 'claude-sonnet-5-5',
      timeoutMs: 5_000,
      fetchImpl: fetchImpl as typeof fetch,
    });
    await client.chat('hl_wx_12345678', { conversationId: 'user', text: 'hello' }, { model: 'sonnet' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
