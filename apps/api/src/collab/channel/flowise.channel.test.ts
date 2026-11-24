import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentChannelRequest } from '@storyforge/contracts';
import { FlowiseChannel, type FlowiseChannelEnv } from './flowise.channel';
import { CollabUpstreamError } from './collab-upstream.error';

function makeRequest(overrides: Partial<AgentChannelRequest> = {}): AgentChannelRequest {
  return {
    taskId: 'task-1',
    workId: 'work-1',
    author_id: 'author-1',
    channel: 'flowise',
    chatflowId: 'cf-abc',
    instruction: '生成角色资料',
    roleContext: { name: '林默' },
    citations: [{ source_id: 's1', title: 't1', snippet: '片段' }],
    outputFields: ['identity', 'personality'],
    ...overrides
  };
}

const baseEnv: FlowiseChannelEnv = {
  FLOWISE_BASE_URL: 'https://flowise.example.com',
  FLOWISE_API_KEY: 'secret-key',
  COLLAB_HTTP_TIMEOUT_MS: 5_000
};

describe('FlowiseChannel (T10)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to prediction endpoint with Bearer and reads text', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: '{"fields":{"identity":"林默","personality":"坚韧"}}' })
    });
    const channel = new FlowiseChannel(baseEnv);
    const result = await channel.invoke(makeRequest());

    expect(result.rawText).toContain('"fields"');
    expect(result.model).toBe('flowise');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://flowise.example.com/api/v1/prediction/cf-abc');
    expect((init as RequestInit).method).toBe('POST');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer secret-key');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.question).toBe('生成角色资料');
    expect(body.overrideConfig.sessionId).toBe('task-1');
  });

  it('injects role context under the node parameter name systemMessagePrompt (regression)', async () => {
    // Flowise 2.x 的 overrideConfig 覆盖键必须是「节点参数名」。
    // 历史 BUG：曾以 systemMessage 发送，被 Flowise isParameterEnabled 静默跳过，角色上下文全部丢失。
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ text: '{"fields":{}}' })
    });
    const channel = new FlowiseChannel(baseEnv);
    await channel.invoke(makeRequest());

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.overrideConfig).not.toHaveProperty('systemMessage');
    expect(typeof body.overrideConfig.systemMessagePrompt).toBe('string');

    const injected = JSON.parse(body.overrideConfig.systemMessagePrompt);
    expect(injected.workId).toBe('work-1');
    expect(injected.roleContext).toEqual({ name: '林默' });
    expect(injected.citations).toEqual([{ source_id: 's1', title: 't1', snippet: '片段' }]);
    expect(injected.outputFields).toEqual(['identity', 'personality']);
    expect(body.overrideConfig.sessionId).toBe('task-1');
  });

  it('throws COLLAB_CHANNEL_NOT_CONFIGURED when env missing', async () => {
    const channel = new FlowiseChannel({});
    await expect(channel.invoke(makeRequest())).rejects.toMatchObject({
      code: 'COLLAB_CHANNEL_NOT_CONFIGURED',
      retryable: false
    });
  });

  it('throws COLLAB_CHANNEL_NOT_CONFIGURED when chatflowId missing', async () => {
    const channel = new FlowiseChannel(baseEnv);
    const { chatflowId: _omit, ...rest } = makeRequest();
    void _omit;
    await expect(channel.invoke(rest as AgentChannelRequest)).rejects.toMatchObject({
      code: 'COLLAB_CHANNEL_NOT_CONFIGURED'
    });
  });

  it('maps non-ok response to COLLAB_UPSTREAM_FAILED', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
    const channel = new FlowiseChannel(baseEnv);
    await expect(channel.invoke(makeRequest())).rejects.toBeInstanceOf(CollabUpstreamError);
    await expect(channel.invoke(makeRequest())).rejects.toMatchObject({ code: 'COLLAB_UPSTREAM_FAILED' });
  });

  it('maps abort to COLLAB_UPSTREAM_TIMEOUT', async () => {
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        (init.signal as AbortSignal).addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    const channel = new FlowiseChannel({ ...baseEnv, COLLAB_HTTP_TIMEOUT_MS: 50 });
    await expect(channel.invoke(makeRequest())).rejects.toMatchObject({
      code: 'COLLAB_UPSTREAM_TIMEOUT',
      retryable: true
    });
  });

  it('maps network error to COLLAB_UPSTREAM_FAILED', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const channel = new FlowiseChannel(baseEnv);
    await expect(channel.invoke(makeRequest())).rejects.toMatchObject({
      code: 'COLLAB_UPSTREAM_FAILED'
    });
  });
});
