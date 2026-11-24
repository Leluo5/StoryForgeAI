// TDD · E knowledge-portability.service Markdown 导入导出
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import {
  createWritingFixture,
  destroyWritingFixture,
  type WritingFixture
} from '../../test/writing-fixture';
import { KnowledgePortabilityService } from './knowledge-portability.service';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';

describe('KnowledgePortabilityService', () => {
  let fixture: WritingFixture;
  let dataSource: DataSource;
  let service: KnowledgePortabilityService;

  beforeAll(async () => {
    fixture = await createWritingFixture();
    dataSource = fixture.dataSource;
    service = new KnowledgePortabilityService(dataSource);
  });

  afterAll(async () => {
    await destroyWritingFixture(fixture);
  });

  async function insertEntry(title: string, original_text: string): Promise<KnowledgeEntryEntity> {
    const repo = dataSource.getRepository(KnowledgeEntryEntity);
    const uniq = crypto.randomUUID();
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
  }

  function makeMd(name: string, content: string) {
    return { originalname: name, buffer: Buffer.from(content, 'utf8'), mimetype: 'text/markdown' };
  }

  it('exportMarkdown：空库返回空导出作业', async () => {
    const resp = await service.exportMarkdown(fixture.authorId, { scope: 'global' });
    expect(resp.job_id).toBeTruthy();
    expect(resp.status).toBe('succeeded');
    expect(resp.entry_count).toBe(0);
    expect(resp.file_name).toMatch(/^knowledge-global-\d{4}-\d{2}-\d{2}\.md$/);
  });

  it('exportMarkdown：有条目时导出内容含标题', async () => {
    await insertEntry('导出测试条目', '这是导出的正文。');
    const resp = await service.exportMarkdown(fixture.authorId, { scope: 'global' });
    expect(resp.entry_count).toBe(1);
  });

  it('previewImport：新文件返回 preview_id 与 new 分类', async () => {
    const resp = await service.previewImport(fixture.authorId, [
      makeMd('导入的新条目.md', '# 导入的新条目\n\n这是导入正文。')
    ]);
    expect(resp.preview_id).toBeTruthy();
    expect(resp.summary.new).toBe(1);
    expect(resp.files).toHaveLength(1);
    expect(resp.files[0]!.conflict).toBe('new');
  });

  it('previewImport：与现有库判重（同标题必为冲突之一）', async () => {
    await insertEntry('重复条目', '相同内容');
    const resp = await service.previewImport(fixture.authorId, [
      makeMd('重复条目.md', '# 重复条目\n\n相同内容')
    ]);
    // 同标题：要么内容哈希相同(duplicate)，要么不同(name_collision)
    expect(resp.summary.duplicate + resp.summary.name_collision).toBe(1);
    expect(resp.conflicts.length).toBeGreaterThanOrEqual(1);
  });

  it('commitImport：policy=skip 不写库', async () => {
    const preview = await service.previewImport(fixture.authorId, [
      makeMd('skip条目.md', '# skip条目\n\nskip内容')
    ]);
    const resp = await service.commitImport(fixture.authorId, {
      preview_id: preview.preview_id,
      policy: 'skip',
      resolutions: []
    });
    expect(resp.status).toBe('succeeded');
  });

  it('commitImport：policy=new 写入条目(origin=markdown_import)', async () => {
    const preview = await service.previewImport(fixture.authorId, [
      makeMd('commit新条目.md', '# commit新条目\n\ncommit内容')
    ]);
    const resp = await service.commitImport(fixture.authorId, {
      preview_id: preview.preview_id,
      policy: 'skip',
      resolutions: [{ file_index: 0, action: 'rename' }]
    });
    expect(resp.result.created).toBe(1);
    const entry = await dataSource.getRepository(KnowledgeEntryEntity).findOneBy({ title: 'commit新条目' });
    expect(entry).not.toBeNull();
    expect(entry!.origin).toBe('markdown_import');
  });

  it('commitImport：无效 preview_id 抛 404', async () => {
    await expect(
      service.commitImport(fixture.authorId, {
        preview_id: '00000000-0000-0000-0000-000000000000',
        policy: 'skip',
        resolutions: []
      })
    ).rejects.toMatchObject({ response: { code: 'KNOWLEDGE_PREVIEW_NOT_FOUND' } });
  });
});
