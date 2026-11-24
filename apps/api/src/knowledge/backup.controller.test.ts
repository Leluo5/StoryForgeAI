// M3c-3 知识库 T26 整库备份恢复 4 端点 · 接口层单测
// 验证：端点编排（service/jobs 透传 + 参数传递 + 下载流 header/Buffer）+ ok() 包装。
// 守卫（SessionGuard/CsrfGuard）与路由前缀不在本单测覆盖（由 e2e/模块装配验证）。
// ZodValidationPipe 的 422 校验用真实 pipe 直测（TDD 铁律）。
// 注意：装饰器元数据（@UseGuards/@HttpCode）在单测环境不可靠，只测行为不测元数据。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotFoundException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { KnowledgeBackupController } from './backup.controller';
import { KnowledgeBackupService } from './knowledge-backup.service';
import { KnowledgeJobService } from './jobs.processor';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  knowledgeBackupCreateRequestSchema,
  knowledgeRestoreCommitRequestSchema
} from '@storyforge/contracts';
import type { AuthenticatedRequest } from '../common/http';
import type { KnowledgeJobEntity } from '../database/knowledge-job.entity';

const AUTHOR_ID = randomUUID();

/** 已认证请求（绕 guard 直调方法，author 固定） */
function req(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    requestId: 'req-t26-backup',
    cookies: {},
    get: () => undefined,
    author: { id: AUTHOR_ID, email: 'x@example.com', display_name: 'X', created_at: '', updated_at: '' },
    ...overrides
  } as unknown as AuthenticatedRequest;
}

/** 构造最小备份导出作业实体（T12 getJob 返回，字段与 knowledge_jobs 表一致） */
function backupJob(overrides: Partial<KnowledgeJobEntity> = {}): KnowledgeJobEntity {
  return {
    id: randomUUID(),
    owner_id: AUTHOR_ID,
    library_scope: 'global',
    work_id: null,
    entry_id: null,
    kind: 'export_backup',
    status: 'succeeded',
    progress: { stage: 'done', processed: 1, total: 1, percent: 100 },
    input: { scope: 'global' },
    result: { file_name: 'knowledge-global-2026-11-24.kb.gz', entry_count: 1 },
    error: null,
    staging_path: null,
    artifact_path: '/tmp/x.kb.gz',
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

describe('KnowledgeBackupController · T26 整库备份恢复 4 端点编排', () => {
  let controller: KnowledgeBackupController;
  const backup = {
    createBackup: vi.fn(),
    restorePreview: vi.fn(),
    restoreCommit: vi.fn()
  };
  const jobs = { getJob: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    backup.createBackup.mockResolvedValue({
      job_id: randomUUID(),
      status: 'succeeded',
      file_name: 'knowledge-global-2026-11-24.kb.gz',
      entry_count: 3
    });
    backup.restorePreview.mockResolvedValue({
      preview_id: randomUUID(),
      file_name: 'backup.kb.gz',
      uncompressed_bytes: 100,
      summary: { total: 1, same_content: 0, same_title_diff_content: 0, new: 1 },
      conflicts: []
    });
    backup.restoreCommit.mockResolvedValue({
      job_id: randomUUID(),
      status: 'succeeded',
      result: { succeeded: 1, failed: 0, skipped: 0 }
    });
    jobs.getJob.mockResolvedValue(backupJob());

    controller = new KnowledgeBackupController(
      backup as unknown as KnowledgeBackupService,
      jobs as unknown as KnowledgeJobService
    );
  });

  // ── POST /knowledge/backups ──

  it('createBackup：global 透传 {scope}', async () => {
    const res = await controller.createBackup(req(), { scope: 'global' });
    expect(backup.createBackup).toHaveBeenCalledWith(AUTHOR_ID, { scope: 'global' });
    expect(res.request_id).toBe('req-t26-backup');
    expect(res.data).toHaveProperty('job_id');
    expect(res.data).toHaveProperty('entry_count');
  });

  it('createBackup：work 带 work_id 透传 {scope, work_id}', async () => {
    const wid = randomUUID();
    await controller.createBackup(req(), { scope: 'work', work_id: wid });
    expect(backup.createBackup).toHaveBeenCalledWith(AUTHOR_ID, { scope: 'work', work_id: wid });
  });

  // ── GET /knowledge/backups/:jobId/download ──

  it('downloadBackup：读磁盘产物，设置 gzip header 并 send Buffer', async () => {
    const tmpFile = join(tmpdir(), `${randomUUID()}.kb.gz`);
    const payload = Buffer.from('gzip-bytes', 'utf8');
    await writeFile(tmpFile, payload);
    jobs.getJob.mockResolvedValue(backupJob({ artifact_path: tmpFile }));

    const res = mockResponse();
    try {
      await controller.downloadBackup(req(), randomUUID(), res as never);

      expect(jobs.getJob).toHaveBeenCalledTimes(1);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/gzip');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent('knowledge-global-2026-11-24.kb.gz')}"`
      );
      expect(res.setHeader).toHaveBeenCalledWith('Content-Length', String(payload.length));
      expect(res.send).toHaveBeenCalledWith(payload);
    } finally {
      await rm(tmpFile, { force: true });
    }
  });

  it('downloadBackup：result.file_name 缺失时兜底默认名', async () => {
    const tmpFile = join(tmpdir(), `${randomUUID()}.kb.gz`);
    await writeFile(tmpFile, Buffer.from('x'));
    jobs.getJob.mockResolvedValue(backupJob({ artifact_path: tmpFile, result: {} }));
    const res = mockResponse();
    try {
      await controller.downloadBackup(req(), randomUUID(), res as never);
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent('knowledge-backup.kb.gz')}"`
      );
    } finally {
      await rm(tmpFile, { force: true });
    }
  });

  it('downloadBackup：非本人作业 → 404（不泄露存在性）', async () => {
    const otherId = randomUUID();
    jobs.getJob.mockResolvedValue(backupJob({ owner_id: otherId }));
    const res = mockResponse();
    await expect(controller.downloadBackup(req(), randomUUID(), res as never))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(res.send).not.toHaveBeenCalled();
  });

  it('downloadBackup：非 export_backup 作业 → 409', async () => {
    jobs.getJob.mockResolvedValue(backupJob({ kind: 'restore_backup' }));
    const res = mockResponse();
    await expect(controller.downloadBackup(req(), randomUUID(), res as never))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('downloadBackup：artifact_path 为 null → 404', async () => {
    jobs.getJob.mockResolvedValue(backupJob({ artifact_path: null }));
    const res = mockResponse();
    await expect(controller.downloadBackup(req(), randomUUID(), res as never))
      .rejects.toMatchObject({ response: { code: 'KNOWLEDGE_ARTIFACT_NOT_FOUND' } });
    expect(res.send).not.toHaveBeenCalled();
  });

  it('downloadBackup：磁盘文件不存在 → 404', async () => {
    jobs.getJob.mockResolvedValue(backupJob({ artifact_path: join(tmpdir(), `${randomUUID()}.missing.kb.gz`) }));
    const res = mockResponse();
    await expect(controller.downloadBackup(req(), randomUUID(), res as never))
      .rejects.toMatchObject({ response: { code: 'KNOWLEDGE_ARTIFACT_NOT_FOUND' } });
    expect(res.send).not.toHaveBeenCalled();
  });

  it('downloadBackup：job 不存在 → getJob 抛 404 透传', async () => {
    jobs.getJob.mockRejectedValue(new NotFoundException({ code: 'KNOWLEDGE_JOB_NOT_FOUND', message: '作业不存在' }));
    const res = mockResponse();
    await expect(controller.downloadBackup(req(), randomUUID(), res as never))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  // ── POST /knowledge/backups/restore/preview ──

  it('previewRestore：映射文件并透传 authorId 与 file', async () => {
    const file = {
      originalname: 'backup.kb.gz',
      buffer: Buffer.from('gzip-bytes'),
      mimetype: 'application/gzip'
    };
    const res = await controller.previewRestore(req(), file as never);
    expect(backup.restorePreview).toHaveBeenCalledWith(AUTHOR_ID, {
      originalname: 'backup.kb.gz',
      buffer: Buffer.from('gzip-bytes'),
      mimetype: 'application/gzip'
    });
    expect(res.data).toHaveProperty('preview_id');
    expect(res.data.summary.new).toBe(1);
  });

  it('previewRestore：无 mimetype 时不传该字段', async () => {
    const file = { originalname: 'backup.kb.gz', buffer: Buffer.from('gzip-bytes') };
    await controller.previewRestore(req(), file as never);
    expect(backup.restorePreview).toHaveBeenCalledWith(AUTHOR_ID, {
      originalname: 'backup.kb.gz',
      buffer: Buffer.from('gzip-bytes')
    });
  });

  it('previewRestore：空文件 → 422 KNOWLEDGE_FILE_MISSING', async () => {
    await expect(controller.previewRestore(req(), undefined as never))
      .rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(backup.restorePreview).not.toHaveBeenCalled();
  });

  // ── POST /knowledge/backups/restore/commit ──

  it('commitRestore：透传 preview_id + policy（无 resolutions）', async () => {
    const res = await controller.commitRestore(req(), { preview_id: randomUUID(), policy: 'skip' });
    expect(backup.restoreCommit).toHaveBeenCalledWith(AUTHOR_ID, {
      preview_id: expect.any(String),
      policy: 'skip'
    });
    expect(res.data.result).toEqual({ succeeded: 1, failed: 0, skipped: 0 });
  });

  it('commitRestore：透传 resolutions（exactOptionalPropertyTypes）', async () => {
    const pid = randomUUID();
    const resolutions = [{ entry_index: 0, action: 'rename' as const }, { entry_index: 1, action: 'skip' as const }];
    await controller.commitRestore(req(), { preview_id: pid, policy: 'skip', resolutions });
    expect(backup.restoreCommit).toHaveBeenCalledWith(AUTHOR_ID, { preview_id: pid, policy: 'skip', resolutions });
  });
});

describe('KnowledgeBackupController · ZodValidationPipe 422 校验', () => {
  it('create：缺 scope → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeBackupCreateRequestSchema);
    expect(() => pipe.transform({})).toThrow();
  });

  it('create：非法 scope → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeBackupCreateRequestSchema);
    expect(() => pipe.transform({ scope: 'bogus' })).toThrow();
  });

  it('create：非法 work_id → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeBackupCreateRequestSchema);
    expect(() => pipe.transform({ scope: 'work', work_id: 'not-a-uuid' })).toThrow();
  });

  it('create：strict 拒绝未知字段 → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeBackupCreateRequestSchema);
    expect(() => pipe.transform({ scope: 'global', bogus: 1 })).toThrow();
  });

  it('create：合法 global 通过', () => {
    const pipe = new ZodValidationPipe(knowledgeBackupCreateRequestSchema);
    expect(() => pipe.transform({ scope: 'global' })).not.toThrow();
  });

  it('create：合法 work 带 work_id 通过', () => {
    const pipe = new ZodValidationPipe(knowledgeBackupCreateRequestSchema);
    expect(() => pipe.transform({ scope: 'work', work_id: randomUUID() })).not.toThrow();
  });

  it('commit：缺 preview_id → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeRestoreCommitRequestSchema);
    expect(() => pipe.transform({ policy: 'skip' })).toThrow();
  });

  it('commit：缺 policy → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeRestoreCommitRequestSchema);
    expect(() => pipe.transform({ preview_id: randomUUID() })).toThrow();
  });

  it('commit：非法 policy → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeRestoreCommitRequestSchema);
    expect(() => pipe.transform({ preview_id: randomUUID(), policy: 'bogus' })).toThrow();
  });

  it('commit：strict 拒绝未知字段 → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeRestoreCommitRequestSchema);
    expect(() => pipe.transform({ preview_id: randomUUID(), policy: 'skip', bogus: 1 })).toThrow();
  });

  it('commit：合法 body 通过', () => {
    const pipe = new ZodValidationPipe(knowledgeRestoreCommitRequestSchema);
    expect(() => pipe.transform({ preview_id: randomUUID(), policy: 'overwrite' })).not.toThrow();
  });
});
