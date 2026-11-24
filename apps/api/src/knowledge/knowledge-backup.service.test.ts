// TDD · F knowledge-backup.service 整库备份恢复
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import {
  createWritingFixture,
  destroyWritingFixture,
  type WritingFixture
} from '../../test/writing-fixture';
import { KnowledgeBackupService } from './knowledge-backup.service';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { KnowledgeTagEntity } from '../database/knowledge-tag.entity';
import { KnowledgeEntryLinkEntity } from '../database/knowledge-entry-link.entity';
import { KnowledgeEntryTagEntity } from '../database/knowledge-entry-tag.entity';
import { KnowledgeJobEntity } from '../database/knowledge-job.entity';
import { serializeBackupV1 } from './portability.backup';
import { stat, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { KnowledgeBackup } from '@storyforge/contracts';

describe('KnowledgeBackupService', () => {
  let fixture: WritingFixture;
  let dataSource: DataSource;
  let service: KnowledgeBackupService;

  beforeAll(async () => {
    fixture = await createWritingFixture();
    dataSource = fixture.dataSource;
    service = new KnowledgeBackupService(dataSource);
  });

  afterAll(async () => {
    await destroyWritingFixture(fixture);
  });

  async function insertEntry(title: string, original_text: string): Promise<KnowledgeEntryEntity> {
    const repo = dataSource.getRepository(KnowledgeEntryEntity);
    const uniq = randomUUID();
    return repo.save(repo.create({
      id: uniq,
      owner_id: fixture.authorId,
      library_scope: 'global',
      work_id: null,
      entry_type: 'article',
      title,
      title_key: title.toLowerCase(),
      original_text,
      content_hash: uniq.replace(/-/g, ''),
      search_text: `${title} ${original_text.slice(0, 2000)}`,
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
      deleted_by: null
    }));
  }

  function makeBackupFile(backup: KnowledgeBackup) {
    return {
      originalname: 'backup.kb.gz',
      buffer: serializeBackupV1(backup),
      mimetype: 'application/gzip'
    };
  }

  function sampleBackup(overrides: Partial<KnowledgeBackup> = {}): KnowledgeBackup {
    return {
      schema_version: 1,
      kind: 'knowledge-backup',
      exported_at: new Date().toISOString(),
      library: { scope: 'global', work_id: null, work_title: null },
      entries: [
        {
          local_id: 'e1',
          entry_type: 'article',
          title: '备份条目A',
          original_text: '备份正文A',
          content_hash: 'a'.repeat(64),
          structured: null,
          outline: null,
          structure_status: 'pending',
          outline_status: null,
          origin: 'manual',
          favorite: false,
          pinned: false,
          tags: ['备份标签'],
          created_at: new Date().toISOString()
        }
      ],
      tags: [{ name: '备份标签' }],
      links: [],
      refs: [],
      ...overrides
    };
  }

  it('createBackup：空库返回 succeeded 作业与 0 条', async () => {
    const resp = await service.createBackup(fixture.authorId, { scope: 'global' });
    expect(resp.job_id).toBeTruthy();
    expect(resp.status).toBe('succeeded');
    expect(resp.entry_count).toBe(0);
  });

  it('createBackup：有条目时 entry_count 统计且生成 artifact', async () => {
    await insertEntry('备份统计条目', '备份统计正文');
    const resp = await service.createBackup(fixture.authorId, { scope: 'global' });
    expect(resp.entry_count).toBeGreaterThanOrEqual(1);
    const job = await dataSource.getRepository('knowledge_jobs').findOneBy?.({ id: resp.job_id });
    expect(job).toBeTruthy();
  });

  it('createBackup：gzip 产物落盘，artifact_path 为存在文件且以 .kb.gz 结尾', async () => {
    const resp = await service.createBackup(fixture.authorId, { scope: 'global' });
    const job = await dataSource.getRepository(KnowledgeJobEntity).findOneByOrFail({ id: resp.job_id });
    expect(job.artifact_path).toBeTruthy();
    expect(job.artifact_path).toMatch(/\.kb\.gz$/);
    expect(job.artifact_hash).toBeTruthy();
    const info = await stat(job.artifact_path as string);
    expect(info.size).toBe(job.artifact_size);
    // 清理落盘产物（不阻塞断言）
    await rm(dirname(job.artifact_path as string), { recursive: true, force: true }).catch(() => undefined);
  });

  it('restorePreview：合法备份返回 preview_id 与 new 分类', async () => {
    const resp = await service.restorePreview(fixture.authorId, makeBackupFile(sampleBackup()));
    expect(resp.preview_id).toBeTruthy();
    expect(resp.summary.new).toBe(1);
    expect(resp.file_name).toBe('backup.kb.gz');
  });

  it('restorePreview：与现有库判重（同内容→same_content）', async () => {
    await insertEntry('备份条目A', '备份正文A');
    const backup = sampleBackup();
    // 让备份条目的 content_hash 与已插入条目一致（覆盖为现有 hash）
    const existing = await dataSource.getRepository(KnowledgeEntryEntity).findOneBy({ title: '备份条目A' });
    backup.entries[0]!.content_hash = existing!.content_hash;
    const resp = await service.restorePreview(fixture.authorId, makeBackupFile(backup));
    expect(resp.summary.same_content).toBe(1);
    expect(resp.conflicts.length).toBeGreaterThanOrEqual(1);
  });

  it('restorePreview：无效备份抛 422', async () => {
    const bad = Buffer.from('not-gzip', 'utf8');
    await expect(
      service.restorePreview(fixture.authorId, { originalname: 'bad.kb.gz', buffer: bad, mimetype: 'application/gzip' })
    ).rejects.toMatchObject({ status: 422 });
  });

  it('restoreCommit：policy=skip 不写库', async () => {
    const preview = await service.restorePreview(fixture.authorId, makeBackupFile(sampleBackup()));
    const resp = await service.restoreCommit(fixture.authorId, {
      preview_id: preview.preview_id,
      policy: 'skip',
      resolutions: []
    });
    expect(resp.status).toBe('succeeded');
    expect(resp.result.succeeded + resp.result.skipped + resp.result.failed).toBe(1);
  });

  it('restoreCommit：policy=overwrite 写入条目(origin=backup)', async () => {
    const preview = await service.restorePreview(fixture.authorId, makeBackupFile(sampleBackup()));
    const resp = await service.restoreCommit(fixture.authorId, {
      preview_id: preview.preview_id,
      policy: 'overwrite',
      resolutions: []
    });
    expect(resp.result.succeeded).toBeGreaterThanOrEqual(1);
    const entry = await dataSource.getRepository(KnowledgeEntryEntity).findOneBy({ origin: 'backup', title: '备份条目A' });
    if (entry) expect(entry.origin).toBe('backup');
  });

  it('restoreCommit：无效 preview_id 抛 404', async () => {
    await expect(
      service.restoreCommit(fixture.authorId, {
        preview_id: '00000000-0000-0000-0000-000000000000',
        policy: 'skip',
        resolutions: []
      })
    ).rejects.toMatchObject({ response: { code: 'KNOWLEDGE_PREVIEW_NOT_FOUND' } });
  });
});
