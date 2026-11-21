import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FastGptClient, type FastGptClientEnv } from './fastgpt.client';

const baseEnv: FastGptClientEnv = {
  FASTGPT_BASE_URL: 'https://fastgpt.example.com',
  FASTGPT_API_KEY: 'fg-secret',
  FASTGPT_DATASET_ID: 'ds-1',
  FASTGPT_SEARCH_PATH: '/api/core/dataset/searchTest',
  COLLAB_HTTP_TIMEOUT_MS: 5_000
};

describe('FastGptClient (T11)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs to searchTest and maps hits with score normalization', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          { id: 'doc-1', title: '资料一', content: '内容一', score: 0.95 },
          { id: 'doc-2', content: '内容二', score: '0.8' },
          // 上游新增字段应被容忍
          { id: 'doc-3', title: '资料三', content: '内容三', score: null, extra: 'ignored' }
        ]
      })
    });

    const client = new FastGptClient(baseEnv);
    const result = await client.search('林默', 8);

    expect(result.datasetId).toBe('ds-1');
    expect(result.hits).toHaveLength(3);
    expect(result.hits[0]).toEqual({ id: 'doc-1', title: '资料一', content: '内容一', score: 0.95 });
    expect(result.hits[1]!.score).toBe(0.8); // 字符串分数归一化为数字
    expect(result.hits[2]!.title).toBe('资料三');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://fastgpt.example.com/api/core/dataset/searchTest');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.datasetId).toBe('ds-1');
    expect(body.text).toBe('林默');
    expect(body.limit).toBe(8);
    expect(body.searchMode).toBe('hybrid');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer fg-secret' });
  });

  it('throws COLLAB_CHANNEL_NOT_CONFIGURED when env missing', async () => {
    const client = new FastGptClient({});
    await expect(client.search('x')).rejects.toMatchObject({
      code: 'COLLAB_CHANNEL_NOT_CONFIGURED',
      retryable: false
    });
  });

  it('maps non-ok response to COLLAB_UPSTREAM_FAILED', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const client = new FastGptClient(baseEnv);
    await expect(client.search('x')).rejects.toMatchObject({ code: 'COLLAB_UPSTREAM_FAILED' });
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
    const client = new FastGptClient({ ...baseEnv, COLLAB_HTTP_TIMEOUT_MS: 50 });
    await expect(client.search('x')).rejects.toMatchObject({
      code: 'COLLAB_UPSTREAM_TIMEOUT',
      retryable: true
    });
  });

  it('rejects a malformed response shape', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: 'not-array' }) });
    const client = new FastGptClient(baseEnv);
    await expect(client.search('x')).rejects.toBeInstanceOf(Error);
  });
});
