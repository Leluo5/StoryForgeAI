// TDD · C knowledge-ingest.service 上传编排 + restructure
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import {
  createWritingFixture,
  destroyWritingFixture,
  type WritingFixture
} from '../../test/writing-fixture';
import { KnowledgeIngestService } from './knowledge-ingest.service';
import { KnowledgeJobService } from './jobs.processor';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { KnowledgeJobEntity } from '../database/knowledge-job.entity';

describe('KnowledgeIngestService', () => {
  let fixture: WritingFixture;
  let dataSource: DataSource;
  let service: KnowledgeIngestService;

  const fakeQueue = { add: async () => undefined, close: async () => undefined };

  beforeAll(async () => {
    fixture = await createWritingFixture();
    dataSource = fixture.dataSource;
    const jobService = new KnowledgeJobService(dataSource, fakeQueue);
    service = new KnowledgeIngestService(dataSource, jobService);
  });

  afterAll(async () => {
    await destroyWritingFixture(fixture);
  });

  function makeTxt(name: string, content: string) {
    return { originalname: name, buffer: Buffer.from(content, 'utf8'), mimetype: 'text/plain' };
  }

  it('uploadFiles：txt 文件建条目(origin=upload) + 入队 structure 作业', async () => {
    const resp = await service.uploadFiles(fixture.authorId, [makeTxt('灵感笔记.md', '# 一个上传的灵感\n这是一段正文。')], {
      scope: 'global'
    });
    expect(resp.jobs).toHaveLength(1);
    expect(resp.rejected).toHaveLength(0);
    expect(resp.jobs[0]!.status).toBe('queued');

    const job = await dataSource.getRepository(KnowledgeJobEntity).findOneBy({ id: resp.jobs[0]!.job_id });
    expect(job).not.toBeNull();
    expect(job!.kind).toBe('structure');

    const entry = await dataSource.getRepository(KnowledgeEntryEntity).findOneBy({ id: job!.entry_id! });
    expect(entry).not.toBeNull();
    expect(entry!.origin).toBe('upload');
    expect(entry!.title).toBe('灵感笔记');
  });

  it('uploadFiles：单文件解析失败进入 rejected，不阻塞整批', async () => {
    const resp = await service.uploadFiles(
      fixture.authorId,
      [makeTxt('bad.exe', 'not supported')],
      { scope: 'global' }
    );
    expect(resp.jobs).toHaveLength(0);
    expect(resp.rejected).toHaveLength(1);
    expect(resp.rejected[0]!.code).toMatch(/UNSUPPORTED|PARSE/);
  });

  it('uploadFiles：超过 10 个文件抛 409', async () => {
    const files = Array.from({ length: 11 }, (_, i) => makeTxt(`f${i}.txt`, 'x'));
    await expect(service.uploadFiles(fixture.authorId, files, { scope: 'global' })).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_FILE_COUNT_EXCEEDED' }
    });
  });

  it('uploadFiles：无文件抛 404', async () => {
    await expect(service.uploadFiles(fixture.authorId, [], { scope: 'global' })).rejects.toMatchObject({
      response: { code: 'KNOWLEDGE_FILE_MISSING' }
    });
  });

  it('enqueueRestructure：正常条目入队 structure 作业', async () => {
    const repo = dataSource.getRepository(KnowledgeEntryEntity);
    const entry = await repo.save(repo.create({
      id: crypto.randomUUID(),
      owner_id: fixture.authorId,
      library_scope: 'global',
      work_id: null,
      entry_type: 'article',
      title: '重结构化条目',
      title_key: '重结构化条目',
      original_text: '这是一段待重新结构化的正文内容。',
      content_hash: crypto.randomUUID().replace(/-/g, ''),
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
      deleted_by: null
    }));
    const result = await service.enqueueRestructure(fixture.authorId, entry.id, { scope: 'global' });
    expect(result.job_id).toBeTruthy();
    expect(result.status).toBe('queued');
  });

  it('enqueueRestructure：不存在条目抛 404', async () => {
    await expect(
      service.enqueueRestructure(fixture.authorId, '00000000-0000-0000-0000-000000000000', { scope: 'global' })
    ).rejects.toMatchObject({ response: { code: 'KNOWLEDGE_ENTRY_NOT_FOUND' } });
  });
});
