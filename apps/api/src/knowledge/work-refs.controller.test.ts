// M3c-3 知识库 T23 作品引用与副本 5 端点 · 接口层单测
// 验证：端点编排（service 透传 / 参数传递）+ ok() 包装。
// 守卫（SessionGuard/CsrfGuard）与路由前缀不在本单测覆盖（由 e2e/模块装配验证）。
// ZodValidationPipe 的 422 校验用真实 pipe 直测（TDD 铁律）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { KnowledgeWorkRefsController } from './work-refs.controller';
import { KnowledgeRefsService } from './refs.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  knowledgeRefCreateRequestSchema,
  knowledgeRefCopyRequestSchema,
  knowledgeFlagsRequestSchema
} from '@storyforge/contracts';
import type { AuthenticatedRequest } from '../common/http';

const AUTHOR_ID = randomUUID();

/** 已认证请求（绕 guard 直调方法，author 固定） */
function req(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    requestId: 'req-t23-work-refs',
    cookies: {},
    get: () => undefined,
    author: { id: AUTHOR_ID, email: 'x@example.com', display_name: 'X', created_at: '', updated_at: '' },
    ...overrides
  } as unknown as AuthenticatedRequest;
}

describe('KnowledgeWorkRefsController · T23 作品引用与副本 5 端点编排', () => {
  let controller: KnowledgeWorkRefsController;
  const refs = {
    listRefs: vi.fn(),
    createRefs: vi.fn(),
    removeRef: vi.fn(),
    setRefFlags: vi.fn(),
    copyRef: vi.fn()
  };

  beforeEach(() => {
    vi.clearAllMocks();
    refs.listRefs.mockResolvedValue([{ id: randomUUID(), kind: 'reference', ref_status: 'active' }]);
    refs.createRefs.mockResolvedValue([{ id: randomUUID(), kind: 'reference' }]);
    refs.removeRef.mockResolvedValue({ ok: true });
    refs.setRefFlags.mockResolvedValue({ favorite: true, pinned: false });
    refs.copyRef.mockResolvedValue({ id: randomUUID(), kind: 'entry' });

    controller = new KnowledgeWorkRefsController(refs as unknown as KnowledgeRefsService);
  });

  // ── GET /works/:workId/knowledge/refs ──

  it('listRefs：透传 workId，返回引用列表', async () => {
    const wid = randomUUID();
    const res = await controller.listRefs(req(), wid);
    expect(refs.listRefs).toHaveBeenCalledWith(AUTHOR_ID, wid);
    expect(res.request_id).toBe('req-t23-work-refs');
    expect(res.data[0]).toHaveProperty('ref_status');
  });

  // ── POST /works/:workId/knowledge/refs ──

  it('createRefs：透传 workId 与 entry_ids，返回 201 语义数据', async () => {
    const wid = randomUUID();
    const input = { entry_ids: [randomUUID(), randomUUID()] };
    const res = await controller.createRefs(req(), wid, input);
    expect(refs.createRefs).toHaveBeenCalledWith(AUTHOR_ID, wid, input.entry_ids);
    expect(res.data[0]).toHaveProperty('kind');
  });

  // ── DELETE /works/:workId/knowledge/refs/:refId ──

  it('removeRef：透传 workId 与 refId，返回 ok', async () => {
    const wid = randomUUID();
    const refId = randomUUID();
    const res = await controller.removeRef(req(), wid, refId);
    expect(refs.removeRef).toHaveBeenCalledWith(AUTHOR_ID, wid, refId);
    expect(res.data).toEqual({ ok: true });
  });

  // ── PUT /works/:workId/knowledge/refs/:refId/flags ──

  it('setRefFlags：透传 workId、refId 与 flags（含 pinned）', async () => {
    const wid = randomUUID();
    const refId = randomUUID();
    const res = await controller.setRefFlags(req(), wid, refId, { favorite: true, pinned: false });
    expect(refs.setRefFlags).toHaveBeenCalledWith(AUTHOR_ID, wid, refId, { favorite: true, pinned: false });
    expect(res.data).toEqual({ favorite: true, pinned: false });
  });

  it('setRefFlags：省略 favorite 时只透传 pinned（exactOptionalPropertyTypes）', async () => {
    const wid = randomUUID();
    const refId = randomUUID();
    await controller.setRefFlags(req(), wid, refId, { pinned: true });
    expect(refs.setRefFlags).toHaveBeenCalledWith(AUTHOR_ID, wid, refId, { pinned: true });
  });

  // ── POST /works/:workId/knowledge/refs/:refId/copy ──

  it('copyRef：透传 workId、refId 与 input（keep_ref+title）', async () => {
    const wid = randomUUID();
    const refId = randomUUID();
    const input = { keep_ref: true, title: '副本标题' };
    const res = await controller.copyRef(req(), wid, refId, input);
    expect(refs.copyRef).toHaveBeenCalledWith(AUTHOR_ID, wid, refId, input);
    expect(res.data).toHaveProperty('id');
  });

  it('copyRef：空 body 透传空对象', async () => {
    const wid = randomUUID();
    const refId = randomUUID();
    await controller.copyRef(req(), wid, refId, {});
    expect(refs.copyRef).toHaveBeenCalledWith(AUTHOR_ID, wid, refId, {});
  });
});

describe('KnowledgeWorkRefsController · ZodValidationPipe 422 校验', () => {
  it('createRefs：缺 entry_ids → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeRefCreateRequestSchema);
    expect(() => pipe.transform({})).toThrow();
  });

  it('createRefs：空数组 → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeRefCreateRequestSchema);
    expect(() => pipe.transform({ entry_ids: [] })).toThrow();
  });

  it('createRefs：超过 50 个 → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeRefCreateRequestSchema);
    expect(() => pipe.transform({ entry_ids: Array.from({ length: 51 }, () => randomUUID()) })).toThrow();
  });

  it('createRefs：strict 拒绝未知字段 → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeRefCreateRequestSchema);
    expect(() => pipe.transform({ entry_ids: [randomUUID()], bogus: 1 })).toThrow();
  });

  it('createRefs：合法 entry_ids 通过', () => {
    const pipe = new ZodValidationPipe(knowledgeRefCreateRequestSchema);
    expect(() => pipe.transform({ entry_ids: [randomUUID()] })).not.toThrow();
  });

  it('copyRef：title 超长 → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeRefCopyRequestSchema);
    expect(() => pipe.transform({ title: 'x'.repeat(201) })).toThrow();
  });

  it('copyRef：strict 拒绝未知字段 → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeRefCopyRequestSchema);
    expect(() => pipe.transform({ keep_ref: true, bogus: 1 })).toThrow();
  });

  it('copyRef：合法 body 通过', () => {
    const pipe = new ZodValidationPipe(knowledgeRefCopyRequestSchema);
    expect(() => pipe.transform({ keep_ref: false, title: '副本' })).not.toThrow();
  });

  it('flags：strict 拒绝未知字段 → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeFlagsRequestSchema);
    expect(() => pipe.transform({ favorite: true, bogus: 1 })).toThrow();
  });

  it('flags：合法 body 通过', () => {
    const pipe = new ZodValidationPipe(knowledgeFlagsRequestSchema);
    expect(() => pipe.transform({ pinned: true })).not.toThrow();
  });
});
