// M4-T9 知识库旧端点迁移：detect-type / similar / markdown-render 单测
// 依据：docs/04-功能交付档案/M4-迁移切换/11-迁移切换技术方案.md §4.3~§4.5
// 覆盖：detect-type 规则判定/manual 显式；similar 余弦 Top-N/排除自身/同 scope/未删除/归属 404/无向量降级；markdown-render 转换与安全。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { KnowledgeToolsService } from './knowledge-tools.service';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { KnowledgeEntryEmbeddingEntity } from '../database/knowledge-entry-embedding.entity';
import { WorkEntity } from '../database/work.entity';

describe('KnowledgeToolsService', () => {
  let fixture: WritingFixture;
  let service: KnowledgeToolsService;

  beforeAll(async () => {
    fixture = await createWritingFixture();
    service = new KnowledgeToolsService(fixture.dataSource);
  });

  afterAll(async () => {
    await destroyWritingFixture(fixture);
  });

  async function createRawEntry(partial: Partial<KnowledgeEntryEntity>): Promise<KnowledgeEntryEntity> {
    const repo = fixture.dataSource.getRepository(KnowledgeEntryEntity);
    const uniq = randomUUID();
    const title = partial.title ?? `条目-${uniq.slice(0, 8)}`;
    const entity = repo.create({
      id: partial.id ?? uniq,
      owner_id: partial.owner_id ?? fixture.authorId,
      library_scope: partial.library_scope ?? 'global',
      work_id: partial.work_id ?? null,
      entry_type: partial.entry_type ?? 'article',
      title,
      title_key: title.toLowerCase(),
      original_text: partial.original_text ?? '这是一段测试正文。',
      content_hash: partial.content_hash ?? uniq.replace(/-/g, ''),
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
      deleted_at: partial.deleted_at ?? null,
      deleted_by: null
    });
    return repo.save(entity);
  }

  async function addEmbedding(entryId: string, vector: number[], ownerId = fixture.authorId): Promise<void> {
    const repo = fixture.dataSource.getRepository(KnowledgeEntryEmbeddingEntity);
    // DB 约束 vector(1024)，dim 必须 = 1024；非零值放前 3 维，其余补 0
    const full = [...vector];
    while (full.length < 1024) full.push(0);
    const vecStr = `[${full.map((x) => Number(x.toFixed(8))).join(',')}]`;
    await repo.save(repo.create({
      entry_id: entryId,
      owner_id: ownerId,
      model: 'test-embed',
      dim: 1024,
      embedding: vecStr,
      source_hash: randomUUID().replace(/-/g, '')
    }));
  }

  // ── detect-type ──

  it('detectType 无 manual：按 classify 规则判定（摘要/关键词/参考文献 → paper）', async () => {
    const res = await service.detectType({
      raw_content: '摘要：本文研究知识库。\n关键词：知识库\n参考文献：[1] 张三。'
    });
    expect(res.type).toBe('paper');
    expect(['high', 'medium', 'low']).toContain(res.confidence);
    expect(Array.isArray(res.reasons)).toBe(true);
  });

  it('detectType 含 manual：显式指定优先（setting 仅能由此进入）', async () => {
    const res = await service.detectType({ raw_content: '世界背景', manual: 'setting' });
    expect(res.type).toBe('setting');
    expect(res.confidence).toBe('high');
  });

  it('detectType 短文本无信号 → inspiration（classify 默认链路）', async () => {
    const res = await service.detectType({ raw_content: '一个突然想到的点子' });
    expect(res.type).toBe('inspiration');
  });

  // ── similar ──

  it('similar 目标无 embedding → 空 items（降级不报错）', async () => {
    const target = await createRawEntry({ entry_type: 'article' });
    const res = await service.similar(fixture.authorId, target.id, { limit: 5 });
    expect(res.items).toEqual([]);
  });

  it('similar 返回余弦 Top-N：按 score 降序，含 title/entry_type/excerpt', async () => {
    const target = await createRawEntry({ title: '目标', entry_type: 'article' });
    await addEmbedding(target.id, [1, 0, 0]);

    // 与 [1,0,0] 夹角小 → 高相似；与 [0,1,0] 正交 → 低
    const close = await createRawEntry({ title: '相近', entry_type: 'paper', original_text: '相近条目的正文内容，足够长以便截取摘要。' });
    await addEmbedding(close.id, [0.99, 0.01, 0]);
    const far = await createRawEntry({ title: '低相似', entry_type: 'novel' });
    await addEmbedding(far.id, [0.3, 0.95, 0]); // 与 [1,0,0] 小正余弦（远小于 close）

    const res = await service.similar(fixture.authorId, target.id, { limit: 10 });
    expect(res.items.length).toBe(2);
    expect(res.items[0]!.entry_id).toBe(close.id);
    expect(res.items[0]!.score).toBeGreaterThan(res.items[1]!.score);
    expect(res.items[0]!.title).toBe('相近');
    expect(res.items[0]!.entry_type).toBe('paper');
    expect(res.items[0]!.excerpt).toContain('相近条目的正文内容');
    expect(res.items[0]!.score).toBeGreaterThan(0.9);
  });

  it('similar 排除自身、仅同 scope、跳过已删除条目', async () => {
    const target = await createRawEntry({ entry_type: 'article' });
    await addEmbedding(target.id, [1, 0]);

    const sameScope = await createRawEntry({ entry_type: 'article' });
    await addEmbedding(sameScope.id, [0.9, 0.1]);
    const otherScope = await createRawEntry({ entry_type: 'article', library_scope: 'work', work_id: fixture.workId });
    await addEmbedding(otherScope.id, [0.95, 0.05]);
    const deleted = await createRawEntry({ entry_type: 'article', deleted_at: new Date() });
    await addEmbedding(deleted.id, [0.9, 0.1]);

    const res = await service.similar(fixture.authorId, target.id, { limit: 10 });
    const ids = res.items.map((i) => i.entry_id);
    expect(ids).not.toContain(target.id);
    expect(ids).toContain(sameScope.id);
    expect(ids).not.toContain(otherScope.id);
    expect(ids).not.toContain(deleted.id);
  });

  it('similar 他人条目 → 404（归属校验）', async () => {
    const other = await createRawEntry({ entry_type: 'article', owner_id: fixture.otherAuthorId });
    await addEmbedding(other.id, [1, 0], fixture.otherAuthorId);
    await expect(service.similar(fixture.authorId, other.id, { limit: 5 }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('similar 作品条目：他人作品 → 404', async () => {
    // 用 authorId 但 work 归属 otherAuthorId 的作品：fixture.workId 属于 authorId，故构造他人作品条目需新 work
    const workRepo = fixture.dataSource.getRepository(WorkEntity);
    const foreignWork = await workRepo.save(workRepo.create({
      id: randomUUID(),
      author_id: fixture.otherAuthorId,
      title: '他人作品'
    }));
    const w = await createRawEntry({ entry_type: 'article', library_scope: 'work', work_id: foreignWork.id, owner_id: fixture.otherAuthorId });
    await addEmbedding(w.id, [1, 0], fixture.otherAuthorId);
    await expect(service.similar(fixture.authorId, w.id, { limit: 5 }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  // ── markdown-render ──

  it('markdownRender 转换：标题/粗体 → HTML', async () => {
    const res = service.markdownRender('# 标题\n\n**加粗**');
    expect(res.html).toContain('<h1>标题</h1>');
    expect(res.html).toContain('<strong>加粗</strong>');
  });

  it('markdownRender 空文本 → 空 html', async () => {
    expect(service.markdownRender('').html).toBe('');
  });

  it('markdownRender 安全：禁内联 HTML（html:false）', async () => {
    const res = service.markdownRender('<script>alert(1)</script>\n\n正文');
    expect(res.html).not.toContain('<script>');
  });
});
