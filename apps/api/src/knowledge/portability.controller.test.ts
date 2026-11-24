// M3c-3 知识库 T25 导入导出 4 端点 · 接口层单测
// 验证：端点编排（service/jobs 透传 + 参数传递 + 下载流 header/content）+ ok() 包装。
// 守卫（SessionGuard/CsrfGuard）与路由前缀不在本单测覆盖（由 e2e/模块装配验证）。
// ZodValidationPipe 的 422 校验用真实 pipe 直测（TDD 铁律）。
// 注意：装饰器元数据（@UseGuards/@HttpCode）在单测环境不可靠，只测行为不测元数据。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { KnowledgePortabilityController } from './portability.controller';
import { KnowledgePortabilityService } from './knowledge-portability.service';
import { KnowledgeJobService } from './jobs.processor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  knowledgeExportRequestSchema,
  knowledgeImportCommitRequestSchema
} from '@storyforge/contracts';
import type { AuthenticatedRequest } from '../common/http';
import type { KnowledgeJobEntity } from '../database/knowledge-job.entity';

const AUTHOR_ID = randomUUID();

/** 已认证请求（绕 guard 直调方法，author 固定） */
function req(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    requestId: 'req-t25-portability',
    cookies: {},
    get: () => undefined,
    author: { id: AUTHOR_ID, email: 'x@example.com', display_name: 'X', created_at: '', updated_at: '' },
    ...overrides
  } as unknown as AuthenticatedRequest;
}

/** 构造最小导出作业实体（T12 getJob 返回，字段与 knowledge_jobs 表一致） */
function exportJob(overrides: Partial<KnowledgeJobEntity> = {}): KnowledgeJobEntity {
  return {
    id: randomUUID(),
    owner_id: AUTHOR_ID,
    library_scope: 'global',
    work_id: null,
    entry_id: null,
    kind: 'export_markdown',
    status: 'succeeded',
    progress: { stage: 'done', processed: 1, total: 1, percent: 100 },
    input: { scope: 'global' },
    result: { file_name: '知识库导出.md', entry_count: 1 },
    error: null,
    staging_path: '# 标题\n\n正文内容',
    artifact_path: '# 标题\n\n正文内容',
    artifact_size: 20,
    artifact_hash: 'abc',
    idempotency_key: null,
    event_seq: 0,
    created_by: AUTHOR_ID,
    created_at: new Date(),
    started_at: new Date(),
    finished_at: new Date(),
    ...overrides
  } as KnowledgeJobEntity;
}

/** 模拟 express Response（setHeader 记录 header，send 记录 body） */
function mockResponse() {
  const headers: Record<string, string> = {};
  let body: unknown;
  const response = {
    setHeader: vi.fn((name: string, value: string) => { headers[name] = value; }),
    send: vi.fn((data: unknown) => { body = data; }),
    end: vi.fn(),
    flushHeaders: vi.fn(),
    _headers: headers,
    _body: () => body
  };
  return response;
}

describe('KnowledgePortabilityController · T25 导入导出 4 端点编排', () => {
  let controller: KnowledgePortabilityController;
  const portability = {
    exportMarkdown: vi.fn(),
    previewImport: vi.fn(),
    commitImport: vi.fn()
  };
  const jobs = { getJob: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    portability.exportMarkdown.mockResolvedValue({
      job_id: randomUUID(),
      status: 'succeeded',
      file_name: 'knowledge-global-2026-11-24.md',
      entry_count: 3
    });
    portability.previewImport.mockResolvedValue({
      preview_id: randomUUID(),
      files: [{ file_name: 'a.md', title: 'A', entry_type: 'article', excerpt: 'x', size: 10, conflict: 'new' }],
      conflicts: [],
      summary: { total: 1, duplicate: 0, name_collision: 0, new: 1, failed: 0 }
    });
    portability.commitImport.mockResolvedValue({
      job_id: randomUUID(),
      status: 'succeeded',
      result: { created: 1, skipped: 0, overwritten: 0 }
    });
    jobs.getJob.mockResolvedValue(exportJob());

    controller = new KnowledgePortabilityController(
      portability as unknown as KnowledgePortabilityService,
      jobs as unknown as KnowledgeJobService
    );
  });

  // ── POST /knowledge/exports ──

  it('exportMarkdown：global 无 work_id 透传 {scope}', async () => {
    const res = await controller.exportMarkdown(req(), { scope: 'global', format: 'markdown' });
    expect(portability.exportMarkdown).toHaveBeenCalledWith(AUTHOR_ID, { scope: 'global' });
    expect(res.request_id).toBe('req-t25-portability');
    expect(res.data).toHaveProperty('job_id');
    expect(res.data).toHaveProperty('entry_count');
  });

  it('exportMarkdown：work 带 work_id 透传 {scope, work_id}', async () => {
    const wid = randomUUID();
    await controller.exportMarkdown(req(), { scope: 'work', work_id: wid, format: 'markdown' });
    expect(portability.exportMarkdown).toHaveBeenCalledWith(AUTHOR_ID, { scope: 'work', work_id: wid });
  });

  // ── GET /knowledge/exports/:jobId/download ──

  it('downloadExport：设置 markdown header 并 send 内容', async () => {
    const res = mockResponse();
    await controller.downloadExport(req(), randomUUID(), res as never);

    expect(jobs.getJob).toHaveBeenCalledTimes(1);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/markdown; charset=utf-8');
    // 中文文件名经 encodeURIComponent
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent('知识库导出.md')}"`
    );
    expect(res.setHeader).toHaveBeenCalledWith('Content-Length', String(Buffer.byteLength('# 标题\n\n正文内容', 'utf8')));
    expect(res.send).toHaveBeenCalledWith('# 标题\n\n正文内容');
  });

  it('downloadExport：result.file_name 缺失时兜底默认名', async () => {
    jobs.getJob.mockResolvedValue(exportJob({ result: {} }));
    const res = mockResponse();
    await controller.downloadExport(req(), randomUUID(), res as never);
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent('knowledge-export.md')}"`
    );
  });

  it('downloadExport：非本人作业 → 404（不泄露存在性）', async () => {
    const otherId = randomUUID();
    jobs.getJob.mockResolvedValue(exportJob({ owner_id: otherId }));
    const res = mockResponse();
    await expect(controller.downloadExport(req(), randomUUID(), res as never))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(res.send).not.toHaveBeenCalled();
  });

  it('downloadExport：非 export_markdown 作业 → 409', async () => {
    jobs.getJob.mockResolvedValue(exportJob({ kind: 'import_markdown' }));
    const res = mockResponse();
    await expect(controller.downloadExport(req(), randomUUID(), res as never))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('downloadExport：job 不存在 → getJob 抛 404 透传', async () => {
    jobs.getJob.mockRejectedValue(new NotFoundException({ code: 'KNOWLEDGE_JOB_NOT_FOUND', message: '作业不存在' }));
    const res = mockResponse();
    await expect(controller.downloadExport(req(), randomUUID(), res as never))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  // ── POST /knowledge/imports/preview ──

  it('previewImport：映射文件并透传 authorId 与 files', async () => {
    const files = [
      { originalname: 'a.md', buffer: Buffer.from('# A'), mimetype: 'text/markdown' },
      { originalname: 'b.md', buffer: Buffer.from('# B'), mimetype: 'text/markdown' }
    ];
    const res = await controller.previewImport(req(), files as never);
    expect(portability.previewImport).toHaveBeenCalledWith(AUTHOR_ID, [
      { originalname: 'a.md', buffer: Buffer.from('# A'), mimetype: 'text/markdown' },
      { originalname: 'b.md', buffer: Buffer.from('# B'), mimetype: 'text/markdown' }
    ]);
    expect(res.data).toHaveProperty('preview_id');
    expect(res.data.summary.total).toBe(1);
  });

  it('previewImport：空文件透传（service 抛 KNOWLEDGE_FILE_MISSING）', async () => {
    portability.previewImport.mockRejectedValue(
      new NotFoundException({ code: 'KNOWLEDGE_FILE_MISSING', message: '未收到任何文件' })
    );
    await expect(controller.previewImport(req(), [] as never))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  // ── POST /knowledge/imports/commit ──

  it('commitImport：透传 preview_id + policy（无 resolutions）', async () => {
    const res = await controller.commitImport(req(), { preview_id: randomUUID(), policy: 'skip' });
    expect(portability.commitImport).toHaveBeenCalledWith(AUTHOR_ID, {
      preview_id: expect.any(String),
      policy: 'skip'
    });
    expect(res.data.result).toEqual({ created: 1, skipped: 0, overwritten: 0 });
  });

  it('commitImport：透传 resolutions（exactOptionalPropertyTypes）', async () => {
    const pid = randomUUID();
    const resolutions = [{ file_index: 0, action: 'rename' as const }, { file_index: 1, action: 'overwrite' as const }];
    await controller.commitImport(req(), { preview_id: pid, policy: 'skip', resolutions });
    expect(portability.commitImport).toHaveBeenCalledWith(AUTHOR_ID, { preview_id: pid, policy: 'skip', resolutions });
  });
});

describe('KnowledgePortabilityController · ZodValidationPipe 422 校验', () => {
  it('export：缺 scope → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeExportRequestSchema);
    expect(() => pipe.transform({ format: 'markdown' })).toThrow();
  });

  it('export：缺 format → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeExportRequestSchema);
    expect(() => pipe.transform({ scope: 'global' })).toThrow();
  });

  it('export：非法 scope → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeExportRequestSchema);
    expect(() => pipe.transform({ scope: 'bogus', format: 'markdown' })).toThrow();
  });

  it('export：非法 work_id → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeExportRequestSchema);
    expect(() => pipe.transform({ scope: 'work', work_id: 'not-a-uuid', format: 'markdown' })).toThrow();
  });

  it('export：strict 拒绝未知字段 → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeExportRequestSchema);
    expect(() => pipe.transform({ scope: 'global', format: 'markdown', bogus: 1 })).toThrow();
  });

  it('export：合法 global 通过', () => {
    const pipe = new ZodValidationPipe(knowledgeExportRequestSchema);
    expect(() => pipe.transform({ scope: 'global', format: 'markdown' })).not.toThrow();
  });

  it('export：合法 work 带 work_id 通过', () => {
    const pipe = new ZodValidationPipe(knowledgeExportRequestSchema);
    expect(() => pipe.transform({ scope: 'work', work_id: randomUUID(), format: 'markdown' })).not.toThrow();
  });

  it('commit：缺 preview_id → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeImportCommitRequestSchema);
    expect(() => pipe.transform({ policy: 'skip' })).toThrow();
  });

  it('commit：缺 policy → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeImportCommitRequestSchema);
    expect(() => pipe.transform({ preview_id: randomUUID() })).toThrow();
  });

  it('commit：非法 policy → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeImportCommitRequestSchema);
    expect(() => pipe.transform({ preview_id: randomUUID(), policy: 'bogus' })).toThrow();
  });

  it('commit：strict 拒绝未知字段 → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeImportCommitRequestSchema);
    expect(() => pipe.transform({ preview_id: randomUUID(), policy: 'skip', bogus: 1 })).toThrow();
  });

  it('commit：合法 body 通过', () => {
    const pipe = new ZodValidationPipe(knowledgeImportCommitRequestSchema);
    expect(() => pipe.transform({ preview_id: randomUUID(), policy: 'overwrite' })).not.toThrow();
  });
});
