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

const chatOk = {
  ok: true,
  status: 200,
  json: async () => ({ code: 0, data: { id: 'chat-1', conversation_id: 'conv-1' } })
};

const retrieveOk = (status: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ code: 0, data: { status } })
});

const answerOk = (content: string) => ({
  ok: true,
  status: 200,
  json: async () => ({
    code: 0,
    data: [{ role: 'assistant', type: 'answer', content, content_type: 'text' }]
  })
});

describe('CozeChannel (T10)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs /v3/chat, polls GET retrieve, then reads message/list', async () => {
    fetchMock
      .mockResolvedValueOnce(chatOk)
      .mockResolvedValueOnce(retrieveOk('completed'))
      .mockResolvedValueOnce(answerOk('{"fields":{"identity":"林默"}}'));

    const channel = new CozeChannel(baseEnv);
    const result = await channel.invoke(makeRequest());

    expect(result.rawText).toContain('"fields"');
    expect(result.model).toBe('coze');

    // 1) 发起：POST /v3/chat（真实路径，非 /open_api/v3）
    const [chatUrl, chatInit] = fetchMock.mock.calls[0]!;
    expect(String(chatUrl)).toBe('https://api.coze.example.com/v3/chat');
    expect((chatInit as RequestInit).method).toBe('POST');
    const chatBody = JSON.parse(String((chatInit as RequestInit).body));
    expect(chatBody.bot_id).toBe('bot-1');
    // auto_save_history=false 会强制要求 stream=true，必须不传该字段
    expect(chatBody).not.toHaveProperty('auto_save_history');
    expect((chatInit as RequestInit).headers).toMatchObject({ Authorization: 'Bearer pat-secret' });

    // 2) 轮询：GET /v3/chat/retrieve + query 参数（无 body）
    const [pollUrl, pollInit] = fetchMock.mock.calls[1]!;
    const pollUrlStr = String(pollUrl);
    expect(pollUrlStr).toContain('/v3/chat/retrieve?');
    expect(pollUrlStr).toContain('chat_id=chat-1');
    expect(pollUrlStr).toContain('conversation_id=conv-1');
    expect((pollInit as RequestInit).method).toBe('GET');
    expect((pollInit as RequestInit).body).toBeUndefined();

    // 3) 取消息：GET /v3/chat/message/list
    const [listUrl] = fetchMock.mock.calls[2]!;
    expect(String(listUrl)).toContain('/v3/chat/message/list?');
  });

  it('polls multiple times until completed', async () => {
    fetchMock
      .mockResolvedValueOnce(chatOk)
      .mockResolvedValueOnce(retrieveOk('in_progress'))
      .mockResolvedValueOnce(retrieveOk('completed'))
      .mockResolvedValueOnce(answerOk('{"fields":{"personality":"冷静"}}'));

    const channel = new CozeChannel({ ...baseEnv, COLLAB_HTTP_TIMEOUT_MS: 5_000 });
    const result = await channel.invoke(makeRequest());
    expect(result.rawText).toContain('"fields"');
    // chat 1 + 轮询 2 + 消息列表 1
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('ignores non-answer messages and throws when no answer text', async () => {
    fetchMock
      .mockResolvedValueOnce(chatOk)
      .mockResolvedValueOnce(retrieveOk('completed'))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          code: 0,
          data: [
            { role: 'assistant', type: 'verbose', content: '思考中' },
            { role: 'assistant', type: 'answer', content: '   ' }
          ]
        })
      });

    const channel = new CozeChannel(baseEnv);
    await expect(channel.invoke(makeRequest())).rejects.toMatchObject({
      code: 'COLLAB_UPSTREAM_FAILED'
    });
  });

  it('throws COLLAB_CHANNEL_NOT_CONFIGURED when env missing', async () => {
    const channel = new CozeChannel({});
    await expect(channel.invoke(makeRequest())).rejects.toMatchObject({
      code: 'COLLAB_CHANNEL_NOT_CONFIGURED',
      retryable: false
    });
  });

  it('maps non-zero retrieve code to COLLAB_UPSTREAM_FAILED', async () => {
    fetchMock
      .mockResolvedValueOnce(chatOk)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ code: 4200, msg: 'bot not found' })
      });

    const channel = new CozeChannel(baseEnv);
    await expect(channel.invoke(makeRequest())).rejects.toMatchObject({
      code: 'COLLAB_UPSTREAM_FAILED'
    });
  });

  it('maps failed retrieve status to COLLAB_UPSTREAM_FAILED', async () => {
    fetchMock.mockResolvedValueOnce(chatOk).mockResolvedValueOnce(retrieveOk('failed'));

    const channel = new CozeChannel(baseEnv);
    await expect(channel.invoke(makeRequest())).rejects.toMatchObject({
      code: 'COLLAB_UPSTREAM_FAILED'
    });
  });

  it('maps abort during polling to COLLAB_UPSTREAM_TIMEOUT', async () => {
    fetchMock
      .mockResolvedValueOnce(chatOk)
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
