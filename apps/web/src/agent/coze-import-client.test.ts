import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testCoze, listCozeResources, importCozeResources } from './coze-import-client';

// F1 Coze 导入客户端：请求路径 / 方法 / body / 响应提取

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> | undefined };

const calls: Call[] = [];
let responses: Record<string, unknown> = {};

vi.mock('../api/client', () => ({
  apiRequest: async (path: string, schema: { parse?: (data: unknown) => unknown }, init: RequestInit = {}): Promise<unknown> => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({
      url: path,
      method,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: init.headers as Record<string, string> | undefined
    });
    const raw = responses[path];
    // 模拟契约解析（apiRequest 实际会解析 json.data）
    return schema.parse ? schema.parse(raw) : raw;
  }
}));

beforeEach(() => {
  calls.length = 0;
  responses = {};
});

describe('coze-import-client（F1）', () => {
  it('testCoze POST /api/v1/admin/coze/test 带 pat_token', async () => {
    responses['/api/v1/admin/coze/test'] = { ok: true };
    await expect(testCoze('pat-1')).resolves.toEqual({ ok: true });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/admin/coze/test',
      body: { pat_token: 'pat-1' }
    });
  });

  it('listCozeResources 不带 workspace_id 时省略该字段', async () => {
    responses['/api/v1/admin/coze/list'] = { resources: [] };
    await listCozeResources('pat-1');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/admin/coze/list',
      body: { pat_token: 'pat-1' }
    });
    expect(calls[0]!.body).not.toHaveProperty('workspace_id');
  });

  it('listCozeResources 带 workspace_id 时透传', async () => {
    responses['/api/v1/admin/coze/list'] = { resources: [] };
    await listCozeResources('pat-1', 'ws-9');
    expect(calls[0]!.body).toEqual({ pat_token: 'pat-1', workspace_id: 'ws-9' });
  });

  it('importCozeResources POST /import 透传 items', async () => {
    const input = {
      pat_token: 'pat-1',
      items: [
        { id: 'b1', type: 'bot' as const },
        { id: 'd1', type: 'dataset' as const }
      ]
    };
    responses['/api/v1/admin/coze/import'] = { total: 2, imported: 2, results: [] };
    await importCozeResources(input);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: '/api/v1/admin/coze/import',
      body: input
    });
  });

  it('importCozeResources 透传 work_id', async () => {
    const input = {
      pat_token: 'pat-1',
      items: [{ id: 'b1', type: 'bot' as const }],
      work_id: '11111111-1111-4111-8111-111111111111'
    };
    responses['/api/v1/admin/coze/import'] = { total: 1, imported: 1, results: [] };
    await importCozeResources(input);
    expect(calls[0]!.body).toMatchObject({ work_id: input.work_id });
  });
});
