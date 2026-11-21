import { beforeEach, describe, expect, it, vi } from 'vitest';
import { collabClient } from './collab-client';

// T20 Mock 客户端：请求路径 / 方法 / body / headers / 响应提取

type Call = { url: string; method: string; body: unknown; headers: Record<string, string> | undefined };

const calls: Call[] = [];
let responses: Record<string, unknown> = {};

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {
    constructor(public status: number, public code: string, message: string, public details: unknown, public requestId: string) {
      super(message); this.name = 'ApiError';
    }
  },
  apiRequest: async (path: string, schema: { parse?: (data: unknown) => unknown; nullable?: () => unknown }, init: RequestInit = {}): Promise<unknown> => {
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({
      url: path,
      method,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: init.headers as Record<string, string> | undefined
    });
    // 有 schema 则模拟 parse；否则原样返回（listWritebacks 返回 items）
    return responses[path] ?? { __placeholder: true };
  }
}));

vi.mock('../character/character-client', () => ({
  characterClient: {
    listCharacters: vi.fn().mockResolvedValue({
      items: [{ id: 'char-1', name: '测试角色' }]
    })
  }
}));

vi.mock('../agent/agent-client', () => ({
  listAgents: async () => ({
    agents: [
      { id: 'a1', name: 'Flowise Agent', platform: 'flowise' },
      { id: 'a2', name: 'Coze Agent', platform: 'coze' },
      { id: 'a3', name: 'Other Agent', platform: 'custom' }
    ]
  })
}));

vi.mock('../ai/ai-client', () => ({
  subscribeTaskEvents: vi.fn().mockReturnValue({ close: vi.fn() })
}));

const workId = '11111111-1111-4111-8111-111111111111';
const characterId = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';
const writebackId = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  calls.length = 0;
  responses = {};
});

describe('collabClient（T20 Mock 客户端）', () => {
  it('createRoleProfileTask 发 POST 到 role-profile/tasks，透传 idempotency-key header', async () => {
    responses[`/api/v1/works/${workId}/role-profile/tasks`] = {
      task: { id: taskId, status: 'queued', channel: 'flowise', error: null }
    };
    await collabClient.createRoleProfileTask(workId, {
      character_id: characterId, fields: ['identity', 'personality'], instruction: '补充身份'
    }, 'idem-1');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `/api/v1/works/${workId}/role-profile/tasks`,
      body: { character_id: characterId, fields: ['identity', 'personality'], instruction: '补充身份' },
      headers: { 'idempotency-key': 'idem-1' }
    });
  });

  it('createRoleProfileTask 不带幂等键时不发送 header', async () => {
    responses[`/api/v1/works/${workId}/role-profile/tasks`] = {
      task: { id: taskId, status: 'queued', channel: 'flowise', error: null }
    };
    await collabClient.createRoleProfileTask(workId, {
      character_id: characterId, fields: ['identity', 'personality'], instruction: 'x'
    });
    expect(calls[0]!.headers).toBeUndefined();
  });

  it('listWritebacks 带 character_id query 并返回 items', async () => {
    responses[`/api/v1/works/${workId}/role-profile/writebacks?character_id=${encodeURIComponent(characterId)}`] = {
      items: [{ id: writebackId, task_id: taskId }]
    };
    const items = await collabClient.listWritebacks(workId, characterId);
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `/api/v1/works/${workId}/role-profile/writebacks?character_id=${encodeURIComponent(characterId)}`
    });
    expect(items).toEqual([{ id: writebackId, task_id: taskId }]);
  });

  it('revertWritebackField 发 POST 到字段撤销端点', async () => {
    responses[`/api/v1/works/${workId}/role-profile/writebacks/${writebackId}/fields/identity/revert`] = {
      field_key: 'identity', status: 'reverted', reverted_at: null, reverted_by: null
    };
    await collabClient.revertWritebackField(workId, writebackId, 'identity');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `/api/v1/works/${workId}/role-profile/writebacks/${writebackId}/fields/identity/revert`
    });
  });

  it('listCollabAgents 仅返回 flowise/coze', async () => {
    const agents = await collabClient.listCollabAgents();
    expect(agents.map((a) => a.platform).sort()).toEqual(['coze', 'flowise']);
  });
});
