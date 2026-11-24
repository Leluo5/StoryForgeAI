// TDD · B knowledge-job.worker 作业分派
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { DataSource } from 'typeorm';
import {
  createWritingFixture,
  destroyWritingFixture,
  type WritingFixture
} from '../../test/writing-fixture';
import { KnowledgeJobWorker } from './knowledge-job.worker';
import { KnowledgeJobService } from './jobs.processor';
import { KnowledgeStructureHandler } from './knowledge-structure.handler';
import { KnowledgePortabilityService } from './knowledge-portability.service';
import { KnowledgeBackupService } from './knowledge-backup.service';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { KnowledgeJobEntity } from '../database/knowledge-job.entity';

describe('KnowledgeJobWorker', () => {
  let fixture: WritingFixture;
  let dataSource: DataSource;
  let jobService: KnowledgeJobService;
  let worker: KnowledgeJobWorker;

  const fakeQueue = { add: async () => undefined, close: async () => undefined };

  beforeAll(async () => {
    fixture = await createWritingFixture();
    dataSource = fixture.dataSource;
    jobService = new KnowledgeJobService(dataSource, fakeQueue);
  });

  afterAll(async () => {
    await destroyWritingFixture(fixture);
  });

  function makeEntry(overrides: Partial<KnowledgeEntryEntity> = {}): Promise<KnowledgeEntryEntity> {
    const repo = dataSource.getRepository(KnowledgeEntryEntity);
    const uniq = crypto.randomUUID();
    return repo.save(repo.create({
      id: uniq,
      owner_id: fixture.authorId,
      library_scope: 'global',
      work_id: null,
      entry_type: 'article',
      title: `w-${uniq.slice(0, 8)}`,
      title_key: `w-${uniq.slice(0, 8)}`,
      original_text: '一段用于结构化处理的正文内容。',
      content_hash: uniq.replace(/-/g, ''),
      search_text: '',
      structured: null,
      structure_status: 'pending',
      structure_error: null,
      outline_status: null,
      outline: null,
      favorite: false,
      pinned: false,
      pinned_at: null,
      origin: 'manual',
      source_entry_id: null,
      version: 1,
      deleted_at: null,
      deleted_by: null,
      ...overrides
    }));
  }

  async function makeJob(kind: string, entryId: string | null = null, status = 'queued'): Promise<KnowledgeJobEntity> {
    const repo = dataSource.getRepository(KnowledgeJobEntity);
    const job = repo.create({
      id: crypto.randomUUID(),
      owner_id: fixture.authorId,
      library_scope: 'global',
      work_id: null,
      entry_id: entryId,
      kind,
      status,
      progress: { stage: 'queued', processed: 0, total: 1, percent: 0 },
      input: entryId ? { entry_id: entryId, source: 'test' } : {},
      result: {},
      error: null,
      staging_path: null,
      artifact_path: null,
      artifact_size: 0,
      artifact_hash: null,
      idempotency_key: null,
      event_seq: 0,
      created_by: fixture.authorId,
      created_at: new Date(),
      started_at: null,
      finished_at: null
    });
    return repo.save(job);
  }

  // 构造 worker：注入 mock handler / portability / backup，隔离真实依赖
  function makeWorker(handler: KnowledgeStructureHandler): KnowledgeJobWorker {
    const mockPortability = { exportMarkdown: vi.fn(), previewImport: vi.fn(), commitImport: vi.fn() } as unknown as KnowledgePortabilityService;
    const mockBackup = { createBackup: vi.fn(), restorePreview: vi.fn(), restoreCommit: vi.fn() } as unknown as KnowledgeBackupService;
    return new KnowledgeJobWorker(dataSource, jobService, handler, mockPortability, mockBackup);
  }

  it('structure 作业：分派 handler 并成功', async () => {
    const entry = await makeEntry();
    const job = await makeJob('structure', entry.id);
    // mock handler：模拟真实 handler 内部 finishSucceeded
    const handleSpy = vi.fn().mockImplementation(async () => {
      await jobService.finishSucceeded(job.id, {});
      return { ok: true, structured: null };
    });
    const mockHandler = { handle: handleSpy } as unknown as KnowledgeStructureHandler;
    const w = makeWorker(mockHandler);
    await w.process({ data: { jobId: job.id } } as never);
    expect(handleSpy).toHaveBeenCalledTimes(1);
    const saved = await dataSource.getRepository(KnowledgeJobEntity).findOneBy({ id: job.id });
    expect(saved!.status).toBe('succeeded');
  });

  it('非 queued 作业跳过处理', async () => {
    const entry = await makeEntry();
    const job = await makeJob('structure', entry.id, 'cancelled');
    const handleSpy = vi.fn();
    const mockHandler = { handle: handleSpy } as unknown as KnowledgeStructureHandler;
    const w = makeWorker(mockHandler);
    await w.process({ data: { jobId: job.id } } as never);
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it('导入导出作业（export_markdown）由 service 同步完成，worker 确认成功', async () => {
    const job = await makeJob('export_markdown');
    const mockHandler = { handle: vi.fn() } as unknown as KnowledgeStructureHandler;
    const w = makeWorker(mockHandler);
    await w.process({ data: { jobId: job.id } } as never);
    const saved = await dataSource.getRepository(KnowledgeJobEntity).findOneBy({ id: job.id });
    // T27：该 kind 作业由 portability service 同步创建并立即终态，worker 收到即确认成功（不重复执行）
    expect(saved!.status).toBe('succeeded');
  });

  it('structure 作业：条目已软删 markFailed', async () => {
    const entry = await makeEntry({ deleted_at: new Date(), deleted_by: fixture.authorId });
    const job = await makeJob('structure', entry.id);
    const mockHandler = { handle: vi.fn() } as unknown as KnowledgeStructureHandler;
    const w = makeWorker(mockHandler);
    await w.process({ data: { jobId: job.id } } as never);
    const saved = await dataSource.getRepository(KnowledgeJobEntity).findOneBy({ id: job.id });
    expect(saved!.status).toBe('failed');
    expect(saved!.error!.code).toBe('KNOWLEDGE_ENTRY_NOT_FOUND');
  });
});
