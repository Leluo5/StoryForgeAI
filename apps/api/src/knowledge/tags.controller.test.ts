// M3c-3 知识库 T22 标签 4 端点 · 接口层单测
// 验证：端点编排（service 透传 / 参数传递）+ ok() 包装。
// 守卫（SessionGuard/CsrfGuard）与路由前缀不在本单测覆盖（由 e2e/模块装配验证）。
// ZodValidationPipe 的 422 校验用真实 pipe 直测（TDD 铁律）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { KnowledgeTagsController } from './tags.controller';
import { KnowledgeTagsService } from './tags.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  knowledgeTagListQuerySchema,
  knowledgeTagRenameRequestSchema,
  knowledgeTagRequestSchema
} from '@storyforge/contracts';
import type { AuthenticatedRequest } from '../common/http';

const AUTHOR_ID = randomUUID();

/** 已认证请求（绕 guard 直调方法，author 固定） */
function req(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    requestId: 'req-t22-tags',
    cookies: {},
    get: () => undefined,
    author: { id: AUTHOR_ID, email: 'x@example.com', display_name: 'X', created_at: '', updated_at: '' },
    ...overrides
  } as unknown as AuthenticatedRequest;
}

describe('KnowledgeTagsController · T22 标签 4 端点编排', () => {
  let controller: KnowledgeTagsController;
  const tags = {
    listTags: vi.fn(),
    createTag: vi.fn(),
    renameTag: vi.fn(),
    deleteTag: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tags.listTags.mockResolvedValue([{ id: randomUUID(), name: '标签A', entry_count: 2 }]);
    tags.createTag.mockResolvedValue({ id: randomUUID(), name: '标签A', entry_count: 0 });
    tags.renameTag.mockResolvedValue({ id: randomUUID(), name: '标签B', entry_count: 3 });
    tags.deleteTag.mockResolvedValue({ ok: true });

    controller = new KnowledgeTagsController(tags as unknown as KnowledgeTagsService);
  });

  // ── GET /knowledge/tags ──

  it('listTags：透传 scope 与 work_id（含条目数）', async () => {
    const wid = randomUUID();
    const res = await controller.listTags(req(), { scope: 'work', work_id: wid });
    expect(tags.listTags).toHaveBeenCalledWith(AUTHOR_ID, 'work', wid);
    expect(res.request_id).toBe('req-t22-tags');
    expect(res.data[0]).toHaveProperty('entry_count');
  });

  it('listTags：global 无 work_id 透传 undefined', async () => {
    await controller.listTags(req(), { scope: 'global' });
    expect(tags.listTags).toHaveBeenCalledWith(AUTHOR_ID, 'global', undefined);
  });

  // ── POST /knowledge/tags ──

  it('createTag：透传 { scope, work_id?, name } 到 service', async () => {
    const input = { scope: 'global' as const, name: '新标签' };
    const res = await controller.createTag(req(), input);
    expect(tags.createTag).toHaveBeenCalledWith(AUTHOR_ID, input);
    expect(res.data).toHaveProperty('name');
  });

  it('createTag：作品库带 work_id 透传', async () => {
    const wid = randomUUID();
    const input = { scope: 'work' as const, work_id: wid, name: '作品标签' };
    await controller.createTag(req(), input);
    expect(tags.createTag).toHaveBeenCalledWith(AUTHOR_ID, input);
  });

  // ── PATCH /knowledge/tags/:tagId ──

  it('renameTag：透传 tagId 与新名称', async () => {
    const id = randomUUID();
    const res = await controller.renameTag(req(), id, { name: '改名后' });
    expect(tags.renameTag).toHaveBeenCalledWith(AUTHOR_ID, id, '改名后');
    expect(res.data.name).toBe('标签B');
  });

  // ── DELETE /knowledge/tags/:tagId ──

  it('deleteTag：透传 tagId，返回 ok', async () => {
    const id = randomUUID();
    const res = await controller.deleteTag(req(), id);
    expect(tags.deleteTag).toHaveBeenCalledWith(AUTHOR_ID, id);
    expect(res.data).toEqual({ ok: true });
  });
});

describe('KnowledgeTagsController · ZodValidationPipe 422 校验', () => {
  it('list query：缺 scope → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeTagListQuerySchema);
    expect(() => pipe.transform({})).toThrow();
  });

  it('list query：非法 scope → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeTagListQuerySchema);
    expect(() => pipe.transform({ scope: 'bogus' })).toThrow();
  });

  it('list query：非法 work_id → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeTagListQuerySchema);
    expect(() => pipe.transform({ scope: 'work', work_id: 'not-a-uuid' })).toThrow();
  });

  it('list query：合法 work 带 work_id 通过', () => {
    const pipe = new ZodValidationPipe(knowledgeTagListQuerySchema);
    expect(() => pipe.transform({ scope: 'work', work_id: randomUUID() })).not.toThrow();
  });

  it('create：strict 拒绝未知字段 → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeTagRequestSchema);
    expect(() => pipe.transform({ scope: 'global', name: 'x', bogus: 1 })).toThrow();
  });

  it('rename：缺 name → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeTagRenameRequestSchema);
    expect(() => pipe.transform({})).toThrow();
  });

  it('rename：name 超长 → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeTagRenameRequestSchema);
    expect(() => pipe.transform({ name: 'x'.repeat(41) })).toThrow();
  });

  it('rename：合法 name 通过', () => {
    const pipe = new ZodValidationPipe(knowledgeTagRenameRequestSchema);
    expect(() => pipe.transform({ name: '标签名' })).not.toThrow();
  });
});
