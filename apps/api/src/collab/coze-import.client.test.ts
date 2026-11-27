import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CozeImportClient, type CozeImportEnv } from './coze-import.client';

// F1 CozeImportClient：URL / 鉴权 / 错误映射（与 CozeChannel 同范式）

function okJson(data: unknown, code = 0, msg?: string) {
  return { ok: true, status: 200, json: async () => ({ code, msg, data }) };
}

const baseEnv: CozeImportEnv = {
  COZE_API_BASE: 'https://api.coze.example.com',
  COZE_PAT: 'pat-env',
  COLLAB_HTTP_TIMEOUT_MS: 10_000
};

describe('CozeImportClient (F1)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('listBots GETs /v1/bots with pagination & Bearer', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ bot_list: [{ bot_id: 'b1', name: '博文' }] }));
    const client = new CozeImportClient(baseEnv, undefined);
    const bots = await client.listBots('author-1', 'pat-req', 'ws-1');

    expect(bots).toEqual([{ bot_id: 'b1', name: '博文' }]);
    const [url, init] = fetchMock.mock.calls[0]!;
    const urlStr = String(url);
    expect(urlStr).toBe('https://api.coze.example.com/v1/bots?page_num=1&page_size=100&publish_status=all&workspace_id=ws-1');
    expect((init as RequestInit).method).toBe('GET');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer pat-req' });
  });

  it('request body PAT 优先于 site_config/env', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ bot_list: [] }));
    const client = new CozeImportClient(baseEnv, {
      getPlatformCredentials: async () => ({ coze: { pat: 'pat-site' } })
    } as never);
    await client.listBots('author-1', 'pat-req');
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer pat-req' });
  });

  it('site_config PAT 优先于 env 兜底', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ bot_list: [] }));
    const client = new CozeImportClient(baseEnv, {
      getPlatformCredentials: async () => ({ coze: { pat: 'pat-site' } })
    } as never);
    await client.listBots('author-1', undefined);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer pat-site' });
  });

  it('falls back to env PAT when no site_config & no explicit', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ bot_list: [] }));
    const client = new CozeImportClient(baseEnv, undefined);
    await client.listBots('author-1', undefined);
    const [, init] = fetchMock.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer pat-env' });
  });

  it('site_config base_url overrides env base', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ bot_list: [] }));
    const client = new CozeImportClient(baseEnv, {
      getPlatformCredentials: async () => ({ coze: { base_url: 'https://custom.coze.cn/' } })
    } as never);
    await client.listBots('author-1', 'pat');
    const [url] = fetchMock.mock.calls[0]!;
    // 尾斜杠应被去除
    expect(String(url)).toContain('https://custom.coze.cn/v1/bots?');
  });

  it('uses default base when nothing configured', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ bot_list: [] }));
    const client = new CozeImportClient({}, undefined);
    await client.listBots('author-1', 'pat');
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('https://api.coze.cn/v1/bots?');
  });

  it('getBotInfo GETs /v1/bots/{id}', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ bot_id: 'b1', name: '博文', model_name: 'gpt-4o' }));
    const client = new CozeImportClient(baseEnv, undefined);
    const bot = await client.getBotInfo('author-1', 'pat', 'b1');
    expect(bot.bot_id).toBe('b1');
    expect(bot.model_name).toBe('gpt-4o');
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.coze.example.com/v1/bots/b1');
  });

  it('listDatasets GETs /v1/datasets', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ dataset_list: [{ dataset_id: 'd1', name: '知识' }] }));
    const client = new CozeImportClient(baseEnv, undefined);
    const ds = await client.listDatasets('author-1', 'pat');
    expect(ds).toEqual([{ dataset_id: 'd1', name: '知识' }]);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.coze.example.com/v1/datasets?page=1&size=100');
  });

  // M4-T10 · Coze 工作流列表迁移（旧 coze_client.get_workflow_list → GET /v1/workflows）
  it('listWorkflows GETs /v1/workflows with pagination & Bearer', async () => {
    fetchMock.mockResolvedValueOnce(
      okJson({ has_more: false, items: [{ workflow_id: 'w1', workflow_name: '主线生成' }] })
    );
    const client = new CozeImportClient(baseEnv, undefined);
    const workflows = await client.get_workflows('author-1', 'pat-req', 'ws-1');

    expect(workflows).toEqual([{ workflow_id: 'w1', workflow_name: '主线生成' }]);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      'https://api.coze.example.com/v1/workflows?page_num=1&page_size=100&workspace_id=ws-1'
    );
    expect((init as RequestInit).method).toBe('GET');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer pat-req' });
  });

  it('listWorkflows omits workspace_id when not given', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ has_more: false, items: [] }));
    const client = new CozeImportClient(baseEnv, undefined);
    await client.get_workflows('author-1', 'pat');
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('https://api.coze.example.com/v1/workflows?page_num=1&page_size=100');
  });

  it('maps non-zero code to COLLAB_UPSTREAM_FAILED', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ bot_list: [] }, 4200, 'bad token'));
    const client = new CozeImportClient(baseEnv, undefined);
    await expect(client.listBots('author-1', 'pat')).rejects.toMatchObject({
      code: 'COLLAB_UPSTREAM_FAILED'
    });
  });

  it('maps HTTP error status to COLLAB_UPSTREAM_FAILED', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) });
    const client = new CozeImportClient(baseEnv, undefined);
    await expect(client.listBots('author-1', 'pat')).rejects.toMatchObject({
      code: 'COLLAB_UPSTREAM_FAILED'
    });
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
    const client = new CozeImportClient({ ...baseEnv, COLLAB_HTTP_TIMEOUT_MS: 50 }, undefined);
    await expect(client.listBots('author-1', 'pat')).rejects.toMatchObject({
      code: 'COLLAB_UPSTREAM_TIMEOUT',
      retryable: true
    });
  });

  it('testConnection returns ok:true on success and ok:false on upstream failure', async () => {
    fetchMock.mockResolvedValueOnce(okJson({ bot_list: [] }));
    const client = new CozeImportClient(baseEnv, undefined);
    await expect(client.testConnection('author-1', 'pat')).resolves.toEqual({ ok: true });

    fetchMock.mockResolvedValueOnce(okJson({ bot_list: [] }, 4200));
    await expect(client.testConnection('author-1', 'pat')).resolves.toEqual({ ok: false });
  });
});
