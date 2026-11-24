// M3c-3 知识库 T21 条目与库 10 端点 · 接口层单测
// 验证：端点编排（service 透传 / 可选入队 / scope 判定 / 引用只读检查 / 标志过滤）+ ok() 包装。
// 守卫（SessionGuard/CsrfGuard）与路由前缀不在本单测覆盖（由 e2e/T27 模块装配验证）。
// ZodValidationPipe 的 422 校验用真实 pipe 直测（RED→GREEN：TDD 铁律）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { KnowledgeEntriesController } from './entries.controller';
import { KnowledgeEntriesService } from './entries.service';
import { KnowledgeTrashService } from './trash.service';
import { KnowledgeIngestService } from './knowledge-ingest.service';
import { KnowledgeRefsService } from './refs.service';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  knowledgeEntryPurgeRequestSchema,
  knowledgeRestructureRequestSchema,
  knowledgeSummaryQuerySchema,
  knowledgeFlagsRequestSchema
} from '@storyforge/contracts';
import type { AuthenticatedRequest } from '../common/http';
import type { KnowledgeEntryCreateRequest } from '@storyforge/contracts';

const AUTHOR_ID = randomUUID();

/** 已认证请求（绕 guard 直调方法，author 固定） */
function req(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    requestId: 'req-t21',
    cookies: {},
    get: () => undefined,
    author: { id: AUTHOR_ID, email: 'x@example.com', display_name: 'X', created_at: '', updated_at: '' },
    ...overrides
  } as unknown as AuthenticatedRequest;
}

/** 合法粘贴录入请求体 */
function createInput(): KnowledgeEntryCreateRequest {
  return {
    scope: 'global',
    text: '这是一段测试知识条目原文，用于 T21 接口层单测。'
  };
}

describe('KnowledgeEntriesController · T21 10 端点编排', () => {
  let controller: KnowledgeEntriesController;
  const entries = {
    summary: vi.fn(),
    listEntries: vi.fn(),
    createEntry: vi.fn(),
    getEntry: vi.fn(),
    updateEntry: vi.fn(),
    softDelete: vi.fn(),
    setFlags: vi.fn()
  };
  const trash = { restore: vi.fn(), purge: vi.fn() };
  const ingest = { enqueueRestructure: vi.fn() };
  const refs = { assertNotReadonly: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    entries.summary.mockResolvedValue({ global: { entries: 1, trash: 0, references: 0 }, work: null });
    entries.listEntries.mockResolvedValue({ items: [], total: 0, next_cursor: null });
    entries.createEntry.mockResolvedValue({ id: randomUUID(), title: '测试条目' });
    entries.getEntry.mockResolvedValue({ id: randomUUID(), title: '测试条目' });
    entries.updateEntry.mockResolvedValue({ id: randomUUID(), title: '测试条目' });
    entries.softDelete.mockResolvedValue({ id: randomUUID(), deleted_at: new Date().toISOString(), referenced_by: [] });
    entries.setFlags.mockResolvedValue({ favorite: true, pinned: false });
    trash.restore.mockResolvedValue({ ok: true });
    trash.purge.mockResolvedValue({ id: randomUUID(), purged_at: new Date().toISOString(), referenced_by: [] });
    ingest.enqueueRestructure.mockResolvedValue({ job_id: randomUUID(), status: 'queued' });
    refs.assertNotReadonly.mockResolvedValue(undefined);

    controller = new KnowledgeEntriesController(
      entries as unknown as KnowledgeEntriesService,
      trash as unknown as KnowledgeTrashService,
      ingest as unknown as KnowledgeIngestService,
      refs as unknown as KnowledgeRefsService
    );
  });

  // ── 4.1.1 summary ──

  it('summary 无 work_id：透传空 opts，返回 ok 包装', async () => {
    const res = await controller.summary(req(), {});
    expect(entries.summary).toHaveBeenCalledWith(AUTHOR_ID, {});
    expect(res).toMatchObject({ request_id: 'req-t21' });
    expect(res.data).toHaveProperty('global');
    expect(res.data.work).toBeNull();
  });

  it('summary 带 work_id：透传 work_id', async () => {
    const wid = randomUUID();
    await controller.summary(req(), { work_id: wid });
    expect(entries.summary).toHaveBeenCalledWith(AUTHOR_ID, { work_id: wid });
  });

  // ── 4.1.2 listEntries ──

  it('listEntries：透传检索 query 到 service', async () => {
    const query = { scope: 'global' as const, keyword: '测试', limit: 50, time_field: 'created_at' as const };
    await controller.listEntries(req(), query);
    expect(entries.listEntries).toHaveBeenCalledWith(AUTHOR_ID, query);
  });

  // ── 4.1.3 createEntry ──

  it('createEntry：建条目后默认入队结构化（allow_structure 缺省）', async () => {
    const input = createInput();
    const res = await controller.createEntry(req(), input);
    expect(entries.createEntry).toHaveBeenCalledWith(AUTHOR_ID, input);
    expect(ingest.enqueueRestructure).toHaveBeenCalledWith(AUTHOR_ID, expect.any(String), { scope: 'global' });
    expect(res.request_id).toBe('req-t21');
  });

  it('createEntry：allow_structure=false 不入队', async () => {
    const input = { ...createInput(), allow_structure: false };
    await controller.createEntry(req(), input);
    expect(ingest.enqueueRestructure).not.toHaveBeenCalled();
  });

  // ── 4.1.4 getEntry ──

  it('getEntry 无 work_id：scope=global', async () => {
    const id = randomUUID();
    await controller.getEntry(req(), id, undefined);
    expect(entries.getEntry).toHaveBeenCalledWith(AUTHOR_ID, id, { scope: 'global' });
  });

  it('getEntry 带 work_id：scope=work', async () => {
    const id = randomUUID();
    const wid = randomUUID();
    await controller.getEntry(req(), id, wid);
    expect(entries.getEntry).toHaveBeenCalledWith(AUTHOR_ID, id, { scope: 'work' });
  });

  // ── 4.1.5 updateEntry ──

  it('updateEntry 带 context_work_id：先做引用只读检查再更新', async () => {
    const id = randomUUID();
    const wid = randomUUID();
    const patch = { title: '新标题', expected_version: 1, context_work_id: wid };
    await controller.updateEntry(req(), id, patch);
    expect(refs.assertNotReadonly).toHaveBeenCalledWith(AUTHOR_ID, wid, id);
    expect(entries.updateEntry).toHaveBeenCalledWith(AUTHOR_ID, id, patch);
  });

  it('updateEntry 无 context_work_id：不做引用只读检查', async () => {
    const id = randomUUID();
    const patch = { title: '新标题', expected_version: 1 };
    await controller.updateEntry(req(), id, patch);
    expect(refs.assertNotReadonly).not.toHaveBeenCalled();
  });

  // ── 4.1.6 deleteEntry ──

  it('deleteEntry：软删并透传 entryId', async () => {
    const id = randomUUID();
    const res = await controller.deleteEntry(req(), id);
    expect(entries.softDelete).toHaveBeenCalledWith(AUTHOR_ID, id);
    expect(res.data).toHaveProperty('referenced_by');
  });

  // ── 4.1.7 restoreEntry ──

  it('restoreEntry：走 trash.restore（幂等）', async () => {
    const id = randomUUID();
    await controller.restoreEntry(req(), id);
    expect(trash.restore).toHaveBeenCalledWith(AUTHOR_ID, id);
  });

  // ── 4.1.8 purgeEntry ──

  it('purgeEntry：confirm body 透传 trash.purge', async () => {
    const id = randomUUID();
    await controller.purgeEntry(req(), id, { confirm: true });
    expect(trash.purge).toHaveBeenCalledWith(AUTHOR_ID, id, { confirm: true });
  });

  // ── 4.1.9 restructureEntry ──

  it('restructureEntry 无 entry_type：仅入队重建，不更新类型', async () => {
    const id = randomUUID();
    const res = await controller.restructureEntry(req(), id, {});
    expect(entries.updateEntry).not.toHaveBeenCalled();
    expect(ingest.enqueueRestructure).toHaveBeenCalledWith(AUTHOR_ID, id, { scope: 'global' });
    expect(res.data).toHaveProperty('job_id');
  });

  it('restructureEntry 带 entry_type：先改判类型再入队', async () => {
    const id = randomUUID();
    await controller.restructureEntry(req(), id, { entry_type: 'article' });
    expect(entries.updateEntry).toHaveBeenCalledWith(AUTHOR_ID, id, { entry_type: 'article' });
    expect(ingest.enqueueRestructure).toHaveBeenCalledWith(AUTHOR_ID, id, { scope: 'global' });
  });

  // ── 4.1.10 setFlags ──

  it('setFlags：过滤 undefined 后透传（exactOptionalPropertyTypes）', async () => {
    const id = randomUUID();
    await controller.setFlags(req(), id, { favorite: true });
    expect(entries.setFlags).toHaveBeenCalledWith(AUTHOR_ID, id, { favorite: true });
  });

  it('setFlags：两者均传透传', async () => {
    const id = randomUUID();
    await controller.setFlags(req(), id, { favorite: true, pinned: false });
    expect(entries.setFlags).toHaveBeenCalledWith(AUTHOR_ID, id, { favorite: true, pinned: false });
  });
});

describe('KnowledgeEntriesController · ZodValidationPipe 422 校验', () => {
  it('purge：confirm 非 literal true → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeEntryPurgeRequestSchema);
    expect(() => pipe.transform({ confirm: false })).toThrow();
    expect(() => pipe.transform({ confirm: true })).not.toThrow();
  });

  it('restructure：非法 entry_type → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeRestructureRequestSchema);
    expect(() => pipe.transform({ entry_type: 'bogus' })).toThrow();
    expect(() => pipe.transform({ entry_type: 'article' })).not.toThrow();
  });

  it('summary：非法 work_id → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeSummaryQuerySchema);
    expect(() => pipe.transform({ work_id: 'not-a-uuid' })).toThrow();
    expect(() => pipe.transform({})).not.toThrow();
  });

  it('flags：strict 拒绝未知字段（context_work_id）→ 422', () => {
    const pipe = new ZodValidationPipe(knowledgeFlagsRequestSchema);
    expect(() => pipe.transform({ favorite: true, context_work_id: randomUUID() })).toThrow();
  });
});
