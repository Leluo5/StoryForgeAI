import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentChannelRequest } from '@storyforge/contracts';
import { CozeChannel, type CozeChannelEnv } from './coze.channel';

function makeRequest(overrides: Partial<AgentChannelRequest> = {}): AgentChannelRequest {
  return {
    taskId: 'task-1',
    workId: 'work-1',
    channel: 'coze',
    instruction: '生成角色资料',
    roleContext: { name: '林默' },
    citations: [{ source_id: 's1', title: 't1', snippet: '片段' }],
    outputFields: ['identity', 'personality'],
    ...overrides
  };
}

const baseEnv: CozeChannelEnv = {
  COZE_API_BASE: 'https://api.coze.example.com',
  COZE_PAT: 'pat-secret',
  COZE_BOT_ID: 'bot-1',
  COLLAB_HTTP_TIMEOUT_MS: 10_000
};

describe('CozeChannel (T10)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to chat, polls retrieve, and returns assistant text', async () => {
    // 第一次调用 = chat 发起；后续调用 = retrieve 轮询
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { chat_id: 'chat-1', conversation_id: 'conv-1' } })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            status: 'completed',
            messages: [{ role: 'assistant', content: '{"fields":{"identity":"林默"}}', content_type: 'text' }]
          }
        })
      });

    const channel = new CozeChannel(baseEnv);
    const result = await channel.invoke(makeRequest());

    expect(result.rawText).toContain('"fields"');
    expect(result.model).toBe('coze');

    // 首个请求是 chat 发起
    const [chatUrl, chatInit] = fetchMock.mock.calls[0]!;
    expect(String(chatUrl)).toBe('https://api.coze.example.com/open_api/v3/chat');
    const chatBody = JSON.parse(String((chatInit as RequestInit).body));
    expect(chatBody.bot_id).toBe('bot-1');
    expect((chatInit as RequestInit).headers).toMatchObject({ Authorization: 'Bearer pat-secret' });

    // 第二个请求是 retrieve
    const [pollUrl] = fetchMock.mock.calls[1]!;
    expect(String(pollUrl)).toBe('https://api.coze.example.com/open_api/v3/chat/retrieve');
    const pollBody = JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body));
    expect(pollBody.chat_id).toBe('chat-1');
  });

  it('polls multiple times until completed', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { chat_id: 'chat-2', conversation_id: 'conv-2' } })
      })
      // 第一次轮询：in_progress，无消息
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { status: 'in_progress', messages: [] } })
      })
      // 第二次轮询：completed，有文本
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: {
            status: 'completed',
            messages: [{ role: 'assistant', content: '{"fields":{"personality":"冷静"}}' }]
          }
        })
      });

    // 缩短轮询间隔以加速测试
    const channel = new CozeChannel({ ...baseEnv, COLLAB_HTTP_TIMEOUT_MS: 2_000 });
    const result = await channel.invoke(makeRequest());
    expect(result.rawText).toContain('"fields"');
    // chat 1 次 + 轮询 2 次
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws COLLAB_CHANNEL_NOT_CONFIGURED when env missing', async () => {
    const channel = new CozeChannel({});
    await expect(channel.invoke(makeRequest())).rejects.toMatchObject({
      code: 'COLLAB_CHANNEL_NOT_CONFIGURED',
      retryable: false
    });
  });

  it('maps failed retrieve status to COLLAB_UPSTREAM_FAILED', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { chat_id: 'chat-3', conversation_id: 'conv-3' } })
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { status: 'failed', messages: [] } })
      });

    const channel = new CozeChannel(baseEnv);
    await expect(channel.invoke(makeRequest())).rejects.toMatchObject({
      code: 'COLLAB_UPSTREAM_FAILED'
    });
  });

  it('maps abort during polling to COLLAB_UPSTREAM_TIMEOUT', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { chat_id: 'chat-4', conversation_id: 'conv-4' } })
      })
      .mockImplementation((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          (init.signal as AbortSignal).addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      });

    const channel = new CozeChannel({ ...baseEnv, COLLAB_HTTP_TIMEOUT_MS: 100 });
    await expect(channel.invoke(makeRequest())).rejects.toMatchObject({
      code: 'COLLAB_UPSTREAM_TIMEOUT',
      retryable: true
    });
  });
});
