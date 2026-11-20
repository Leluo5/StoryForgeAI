import { beforeEach, describe, expect, it, vi } from 'vitest';
import { characterAnchorClient } from './character-anchor-client';

// Mock api/client：只记录请求，不做真实 fetch / Zod 校验
const calls: Array<{ url: string; method: string; body: unknown }> = [];
vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
      public details: unknown,
      public requestId: string
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
  apiRequest: async (path: string, _schema: unknown, init: RequestInit = {}): Promise<unknown> => {
    calls.push({
      url: path,
      method: (init.method ?? 'GET').toUpperCase(),
      body: init.body ? JSON.parse(String(init.body)) : undefined
    });
    return { __placeholder: true };
  }
}));

const workId = '11111111-1111-4111-8111-111111111111';
const chapterId = '22222222-2222-4222-8222-222222222222';
const characterId = '33333333-3333-4333-8333-333333333333';
const anchorA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const anchorB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

beforeEach(() => {
  calls.length = 0;
});

describe('character-anchor-client T38', () => {
  it('读取章节命中段落走 GET role-marks', async () => {
    await characterAnchorClient.getChapterRoleMarks(workId, chapterId);
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `/api/v1/works/${workId}/chapters/${chapterId}/role-marks`
    });
  });

  it('单条剔除带可选 reason', async () => {
    await characterAnchorClient.dismissAnchor(workId, chapterId, anchorA, '误报');
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `/api/v1/works/${workId}/chapters/${chapterId}/role-marks/${anchorA}/dismiss`,
      body: { reason: '误报' }
    });
  });

  it('单条剔除不传 reason 时 body 为空对象', async () => {
    await characterAnchorClient.dismissAnchor(workId, chapterId, anchorA);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `/api/v1/works/${workId}/chapters/${chapterId}/role-marks/${anchorA}/dismiss`,
      body: {}
    });
  });

  it('批量剔除提交 anchor_ids', async () => {
    await characterAnchorClient.dismissAnchorsBatch(workId, chapterId, [anchorA, anchorB]);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `/api/v1/works/${workId}/chapters/${chapterId}/role-marks/dismiss-batch`,
      body: { anchor_ids: [anchorA, anchorB] }
    });
  });

  it('重新扫描走 POST archive-scans', async () => {
    await characterAnchorClient.rescanArchive(workId, characterId);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `/api/v1/works/${workId}/characters/${characterId}/archive-scans`
    });
  });
});
