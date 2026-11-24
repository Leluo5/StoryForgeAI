// M3c-3 知识库 T22 关联 3 端点 · 接口层单测
// 验证：端点编排（service 透传 / 参数传递）+ ok() 包装。
// 守卫（SessionGuard/CsrfGuard）与路由前缀不在本单测覆盖（由 e2e/模块装配验证）。
// ZodValidationPipe 的 422 校验用真实 pipe 直测（TDD 铁律）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { KnowledgeLinksController } from './links.controller';
import { KnowledgeLinksService } from './links.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { knowledgeLinkCreateRequestSchema } from '@storyforge/contracts';
import type { AuthenticatedRequest } from '../common/http';

const AUTHOR_ID = randomUUID();

/** 已认证请求（绕 guard 直调方法，author 固定） */
function req(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    requestId: 'req-t22-links',
    cookies: {},
    get: () => undefined,
    author: { id: AUTHOR_ID, email: 'x@example.com', display_name: 'X', created_at: '', updated_at: '' },
    ...overrides
  } as unknown as AuthenticatedRequest;
}

describe('KnowledgeLinksController · T22 关联 3 端点编排', () => {
  let controller: KnowledgeLinksController;
  const links = {
    listLinks: vi.fn(),
    createLink: vi.fn(),
    deleteLink: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    links.listLinks.mockResolvedValue([
      {
        id: randomUUID(),
        source_entry_id: randomUUID(),
        target_entry_id: randomUUID(),
        kind: 'manual',
        source_title: 'A',
        target_title: 'B',
        created_at: new Date().toISOString()
      }
    ]);
    links.createLink.mockResolvedValue({
      id: randomUUID(),
      source_entry_id: randomUUID(),
      target_entry_id: randomUUID(),
      kind: 'manual',
      source_title: 'A',
      target_title: 'B',
      created_at: new Date().toISOString()
    });
    links.deleteLink.mockResolvedValue({ ok: true });

    controller = new KnowledgeLinksController(links as unknown as KnowledgeLinksService);
  });

  // ── GET /knowledge/entries/:entryId/links ──

  it('listLinks：透传 entryId（双向关联列表）', async () => {
    const id = randomUUID();
    const res = await controller.listLinks(req(), id);
    expect(links.listLinks).toHaveBeenCalledWith(AUTHOR_ID, id);
    expect(res.request_id).toBe('req-t22-links');
    expect(res.data[0]).toHaveProperty('source_title');
    expect(res.data[0]).toHaveProperty('target_title');
  });

  // ── POST /knowledge/links ──

  it('createLink：透传 { source_entry_id, target_entry_id }', async () => {
    const input = { source_entry_id: randomUUID(), target_entry_id: randomUUID() };
    const res = await controller.createLink(req(), input);
    expect(links.createLink).toHaveBeenCalledWith(AUTHOR_ID, input);
    expect(res.data.kind).toBe('manual');
  });

  // ── DELETE /knowledge/links/:linkId ──

  it('deleteLink：透传 linkId（幂等）', async () => {
    const id = randomUUID();
    const res = await controller.deleteLink(req(), id);
    expect(links.deleteLink).toHaveBeenCalledWith(AUTHOR_ID, id);
    expect(res.data).toEqual({ ok: true });
  });
});

describe('KnowledgeLinksController · ZodValidationPipe 422 校验', () => {
  it('createLink：缺 target_entry_id → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeLinkCreateRequestSchema);
    expect(() => pipe.transform({ source_entry_id: randomUUID() })).toThrow();
  });

  it('createLink：非 uuid → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeLinkCreateRequestSchema);
    expect(() => pipe.transform({ source_entry_id: 'x', target_entry_id: randomUUID() })).toThrow();
  });

  it('createLink：合法通过', () => {
    const pipe = new ZodValidationPipe(knowledgeLinkCreateRequestSchema);
    expect(() =>
      pipe.transform({ source_entry_id: randomUUID(), target_entry_id: randomUUID() })
    ).not.toThrow();
  });
});
