// TDD · D knowledge-structure.handler 结构化管线
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { DataSource } from 'typeorm';
import {
  createWritingFixture,
  destroyWritingFixture,
  type WritingFixture
} from '../../test/writing-fixture';
import { KnowledgeStructureHandler } from './knowledge-structure.handler';
import { KnowledgeJobService } from './jobs.processor';
import { KnowledgeEntriesService } from './entries.service';
import { MockKnowledgeStructureProvider } from './structure.provider';
import { MockEmbeddingProvider } from './embedding.mock';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { KnowledgeEntryEmbeddingEntity } from '../database/knowledge-entry-embedding.entity';

describe('KnowledgeStructureHandler', () => {
  let fixture: WritingFixture;
  let dataSource: DataSource;
  let handler: KnowledgeStructureHandler;

  const fakeQueue = { add: async () => undefined, close: async () => undefined };

  beforeAll(async () => {
    fixture = await createWritingFixture();
    dataSource = fixture.dataSource;
    const jobService = new KnowledgeJobService(dataSource, fakeQueue);
    const entriesService = new KnowledgeEntriesService(dataSource);
    handler = new KnowledgeStructureHandler(
      dataSource,
      jobService,
      new MockKnowledgeStructureProvider(),
      new MockEmbeddingProvider(),
      entriesService
    );
  });

  afterAll(async () => {
    await destroyWritingFixture(fixture);
  });

  async function createRawEntry(partial: Partial<KnowledgeEntryEntity>): Promise<KnowledgeEntryEntity> {
    const repo = dataSource.getRepository(KnowledgeEntryEntity);
    const uniq = crypto.randomUUID();
    const title = partial.title ?? `测试条目-${uniq.slice(0, 8)}`;
    const entity = repo.create({
      id: partial.id ?? uniq,
      owner_id: partial.owner_id ?? fixture.authorId,
      library_scope: partial.library_scope ?? 'global',
      work_id: partial.work_id ?? null,
      entry_type: partial.entry_type ?? 'article',
      title,
      title_key: title.toLowerCase(),
      original_text: partial.original_text ?? '这是一段用于结构化的测试正文内容，包含足够的信息量。',
      content_hash: partial.content_hash ?? uniq.replace(/-/g, ''),
      search_text: '',
      structured: partial.structured ?? null,
      structure_status: partial.structure_status ?? 'pending',
      structure_error: null,
      outline_status: partial.outline_status ?? null,
      outline: partial.outline ?? null,
      favorite: false,
      pinned: false,
      pinned_at: null,
      origin: 'manual',
      source_entry_id: null,
      version: 1,
      deleted_at: null,
      deleted_by: null
    });
    return repo.save(entity);
  }

  it('结构化成功：article 类型写 structured/ready/search_text', async () => {
    const entry = await createRawEntry({ entry_type: 'article' });
    const result = await handler.handle(null, {
      entryId: entry.id,
      rawContent: entry.original_text,
      entryType: 'article',
      title: entry.title,
      scope: 'global',
      ownerId: fixture.authorId
    });
    expect(result.ok).toBe(true);
    const saved = await dataSource.getRepository(KnowledgeEntryEntity).findOneBy({ id: entry.id });
    expect(saved!.structure_status).toBe('ready');
    expect(saved!.structured).not.toBeNull();
    expect(saved!.search_text).toContain(entry.title);
  });

  it('结构化成功：novel 类型生成 outline（ready 或 failed 降级）', async () => {
    const entry = await createRawEntry({
      entry_type: 'novel',
      original_text: '第一章 开始\n这是第一章的内容。\n\n第二章 继续\n这是第二章的内容。'
    });
    const result = await handler.handle(null, {
      entryId: entry.id,
      rawContent: entry.original_text,
      entryType: 'novel',
      title: entry.title,
      scope: 'global',
      ownerId: fixture.authorId
    });
    expect(result.ok).toBe(true);
    const saved = await dataSource.getRepository(KnowledgeEntryEntity).findOneBy({ id: entry.id });
    expect(saved!.structure_status).toBe('ready');
    expect(['ready', 'failed']).toContain(saved!.outline_status);
  });

  it('结构化成功：灵感类型写入向量与自动关联表', async () => {
    const inspiration = await createRawEntry({ entry_type: 'inspiration', original_text: '一个独特的创作灵感火花' });
    // 另建一个非灵感受试体
    await createRawEntry({ entry_type: 'article', original_text: '一个独特的创作灵感火花' });
    const result = await handler.handle(null, {
      entryId: inspiration.id,
      rawContent: inspiration.original_text,
      entryType: 'inspiration',
      title: inspiration.title,
      scope: 'global',
      ownerId: fixture.authorId
    });
    expect(result.ok).toBe(true);
    const emb = await dataSource.getRepository(KnowledgeEntryEmbeddingEntity).findOneBy({ entry_id: inspiration.id });
    expect(emb).not.toBeNull();
    expect(emb!.dim).toBe(1024);
  });

  it('结构化失败：不存在条目返回 ok=false 不抛错', async () => {
    const result = await handler.handle(null, {
      entryId: '00000000-0000-0000-0000-000000000000',
      rawContent: '内容',
      entryType: 'article',
      title: 't',
      scope: 'global',
      ownerId: fixture.authorId
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('结构化失败：空内容返回 KNOWNLEDGE_TEXT_EMPTY 并标记 failed', async () => {
    const entry = await createRawEntry({ entry_type: 'article', original_text: '' });
    const result = await handler.handle(null, {
      entryId: entry.id,
      rawContent: '',
      entryType: 'article',
      title: entry.title,
      scope: 'global',
      ownerId: fixture.authorId
    });
    expect(result.ok).toBe(false);
    const saved = await dataSource.getRepository(KnowledgeEntryEntity).findOneBy({ id: entry.id });
    expect(saved!.structure_status).toBe('failed');
  });
});
