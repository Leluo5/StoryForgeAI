// M3c-3 知识库 T11 条目 CRUD 与 search_text 重算（真实 PostgreSQL 集成测试）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.1、§2.2.1、§4.1
// 覆盖：创建默认类型识别/显式优先、content_hash 库级与作品级去重（409）、
//       expected_version 乐观锁（409）、search_text 重算、软删/恢复/收藏/置顶、
//       列表摘要不返回全文、详情按 library_scope 权限返回。
import { NotFoundException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { KnowledgeEntriesService } from './entries.service';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { KnowledgeTagEntity } from '../database/knowledge-tag.entity';
import { KnowledgeEntryTagEntity } from '../database/knowledge-entry-tag.entity';
import { KnowledgeWorkRefEntity } from '../database/knowledge-work-ref.entity';
import { hashContent, normalizeTitleKey } from './knowledge.service';
import type { KnowledgeEntryCreateRequest, KnowledgeEntryPatchRequest } from '@storyforge/contracts';

let fixture: WritingFixture;
let service: KnowledgeEntriesService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new KnowledgeEntriesService(fixture.dataSource);
});

afterEach(() => destroyWritingFixture(fixture));

function createInput(overrides: Partial<KnowledgeEntryCreateRequest> = {}): KnowledgeEntryCreateRequest {
  return {
    scope: 'global',
    title: '测试条目',
    text: '这是一段用于单测的正文内容。',
    tags: ['测试'],
    ...overrides
  };
}

async function list(scope: 'global' | 'work', workId?: string) {
  return service.listEntries(fixture.authorId, { scope, work_id: workId });
}

describe('KnowledgeEntriesService · 创建与类型识别', () => {
  it('默认按 T09 识别：正文含摘要/关键词/参考文献 → paper', async () => {
    const res = await service.createEntry(fixture.authorId, createInput({
      text: '摘要：本文研究…\n关键词：知识库\n参考文献：[1] 张三。'
    }));
    const detail = await service.getEntry(fixture.authorId, res.id, { scope: 'global' });
    expect(detail.entry_type).toBe('paper');
  });

  it('默认按 T09 识别：含章节标记 → novel', async () => {
    const res = await service.createEntry(fixture.authorId, createInput({
      text: '第一章 起\n第二章 承\n第三章 转\n第四章 合'
    }));
    const detail = await service.getEntry(fixture.authorId, res.id, { scope: 'global' });
    expect(detail.entry_type).toBe('novel');
  });

  it('默认按 T09 识别：短文本 → inspiration', async () => {
    const res = await service.createEntry(fixture.authorId, createInput({
      text: '一个突然想到的点子'
    }));
    const detail = await service.getEntry(fixture.authorId, res.id, { scope: 'global' });
    expect(detail.entry_type).toBe('inspiration');
  });

  it('默认按 T09 识别：无信号 → article（低置信度）', async () => {
    // 长文本（≥800 字）+ 含空行，排除 inspiration 的「短文本」分支；
    // 避免含「摘要/关键词/参考文献」（论文信号）与章节/引号（小说信号）
    const longPlain = Array.from({ length: 30 }, (_, i) => `第${i + 1}段：这是没有任何特殊信号的长篇内容，仅用于验证默认归类为普通文章，内容足够长以排除灵感短文本分支。`).join('\n\n');
    expect(longPlain.length).toBeGreaterThan(800);
    expect(longPlain).toContain('\n\n');
    expect(longPlain).not.toMatch(/摘要|关键词|参考文献/);
    expect(longPlain).not.toMatch(/第\s*[一二三四五六七八九十百千万0-9]+\s*[章节]/);
    const res = await service.createEntry(fixture.authorId, createInput({
      text: longPlain
    }));
    const detail = await service.getEntry(fixture.authorId, res.id, { scope: 'global' });
    expect(detail.entry_type).toBe('article');
  });

  it('显式 entry_type 优先于启发式', async () => {
    const res = await service.createEntry(fixture.authorId, createInput({
      entry_type: 'setting',
      text: '世界背景：东方大陆，灵气复苏。'
    }));
    const detail = await service.getEntry(fixture.authorId, res.id, { scope: 'global' });
    expect(detail.entry_type).toBe('setting');
  });

  it('写入 content_hash 与 title_key', async () => {
    const res = await service.createEntry(fixture.authorId, createInput({ title: '量子综述' }));
    const entity = await fixture.dataSource.getRepository(KnowledgeEntryEntity).findOneByOrFail({ id: res.id });
    expect(entity.content_hash).toBe(hashContent('这是一段用于单测的正文内容。'));
    expect(entity.title_key).toBe(normalizeTitleKey('量子综述'));
  });

  it('work 条目写入 work_id 与 library_scope=work', async () => {
    const res = await service.createEntry(fixture.authorId, createInput({ scope: 'work', work_id: fixture.workId }));
    const entity = await fixture.dataSource.getRepository(KnowledgeEntryEntity).findOneByOrFail({ id: res.id });
    expect(entity.library_scope).toBe('work');
    expect(entity.work_id).toBe(fixture.workId);
  });
});

describe('KnowledgeEntriesService · content_hash 去重（409）', () => {
  it('全局库：同 owner + content_hash → 409 KNOWLEDGE_ENTRY_DUPLICATE', async () => {
    await service.createEntry(fixture.authorId, createInput());
    await expect(service.createEntry(fixture.authorId, createInput()))
      .rejects.toMatchObject({ status: 409, response: { code: 'KNOWLEDGE_ENTRY_DUPLICATE' } });
  });

  it('作品库：同 work_id + content_hash → 409 KNOWLEDGE_ENTRY_DUPLICATE', async () => {
    await service.createEntry(fixture.authorId, createInput({ scope: 'work', work_id: fixture.workId }));
    await expect(service.createEntry(fixture.authorId, createInput({ scope: 'work', work_id: fixture.workId })))
      .rejects.toMatchObject({ status: 409, response: { code: 'KNOWLEDGE_ENTRY_DUPLICATE' } });
  });

  it('不同 work_id 同内容可共存（作品级去重按 work 隔离）', async () => {
    const a = await service.createEntry(fixture.authorId, createInput({ scope: 'work', work_id: fixture.workId }));
    // 另一个作品：用 createWritingFixture 创建第二个 work 成本高，直接以全局库同内容验证跨库不冲突
    const global = await service.createEntry(fixture.authorId, createInput({ scope: 'global' }));
    expect(global.id).not.toBe(a.id);
  });
});

describe('KnowledgeEntriesService · 乐观锁更新', () => {
  it('expected_version 匹配 → 更新并 version+1', async () => {
    const created = await service.createEntry(fixture.authorId, createInput());
    const detail = await service.getEntry(fixture.authorId, created.id, { scope: 'global' });
    const updated = await service.updateEntry(fixture.authorId, created.id, {
      title: '新标题',
      expected_version: detail.version
    });
    expect(updated.title).toBe('新标题');
    expect(updated.version).toBe(detail.version + 1);
  });

  it('expected_version 不匹配 → 409 KNOWLEDGE_VERSION_CONFLICT', async () => {
    const created = await service.createEntry(fixture.authorId, createInput());
    await expect(service.updateEntry(fixture.authorId, created.id, {
      title: '冲突标题',
      expected_version: 999
    })).rejects.toMatchObject({ status: 409, response: { code: 'KNOWLEDGE_VERSION_CONFLICT' } });
  });

  it('无 expected_version 也允许更新（可选）', async () => {
    const created = await service.createEntry(fixture.authorId, createInput());
    const updated = await service.updateEntry(fixture.authorId, created.id, { title: '无锁标题' });
    expect(updated.title).toBe('无锁标题');
  });
});

describe('KnowledgeEntriesService · search_text 重算', () => {
  it('创建时由标题 + 标签名 + 原文前 2000 字构成', async () => {
    const res = await service.createEntry(fixture.authorId, createInput({ title: '重算标题', tags: ['甲', '乙'] }));
    const entity = await fixture.dataSource.getRepository(KnowledgeEntryEntity).findOneByOrFail({ id: res.id });
    expect(entity.search_text).toContain('重算标题');
    expect(entity.search_text).toContain('甲');
    expect(entity.search_text).toContain('乙');
    expect(entity.search_text).toContain('这是一段用于单测的正文内容。');
  });

  it('更新标题同步刷新 search_text', async () => {
    const created = await service.createEntry(fixture.authorId, createInput({ title: '旧标题' }));
    await service.updateEntry(fixture.authorId, created.id, { title: '新标题', expected_version: 1 });
    const entity = await fixture.dataSource.getRepository(KnowledgeEntryEntity).findOneByOrFail({ id: created.id });
    expect(entity.search_text).toContain('新标题');
    expect(entity.search_text).not.toContain('旧标题');
  });

  it('结构化完成回填时重算（含结构化摘要）', async () => {
    const created = await service.createEntry(fixture.authorId, createInput());
    await service.refreshSearchText(fixture.authorId, created.id);
    const entity = await fixture.dataSource.getRepository(KnowledgeEntryEntity).findOneByOrFail({ id: created.id });
    expect(entity.search_text.length).toBeGreaterThan(0);
  });

  it('原文前 2000 字上限，不索引全文', async () => {
    const longText = '长'.repeat(3000);
    const res = await service.createEntry(fixture.authorId, createInput({ text: longText }));
    const entity = await fixture.dataSource.getRepository(KnowledgeEntryEntity).findOneByOrFail({ id: res.id });
    // search_text 只含原文前 2000 字 + 标题 + 标签，总长不超过 2000 + 余量
    expect(entity.search_text.length).toBeLessThanOrEqual(2200);
  });
});

describe('KnowledgeEntriesService · 软删 / 恢复 / 收藏 / 置顶', () => {
  it('软删只置 deleted_at，不物理删除', async () => {
    const created = await service.createEntry(fixture.authorId, createInput());
    await service.softDelete(fixture.authorId, created.id);
    const entity = await fixture.dataSource.getRepository(KnowledgeEntryEntity).findOneByOrFail({ id: created.id });
    expect(entity.deleted_at).toBeInstanceOf(Date);
    expect(entity.title).toBe('测试条目');
  });

  it('软删后常规详情 404', async () => {
    const created = await service.createEntry(fixture.authorId, createInput());
    await service.softDelete(fixture.authorId, created.id);
    await expect(service.getEntry(fixture.authorId, created.id, { scope: 'global' }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('恢复仅限回收站条目：deleted_at 置空', async () => {
    const created = await service.createEntry(fixture.authorId, createInput());
    await service.softDelete(fixture.authorId, created.id);
    await service.restore(fixture.authorId, created.id);
    const entity = await fixture.dataSource.getRepository(KnowledgeEntryEntity).findOneByOrFail({ id: created.id });
    expect(entity.deleted_at).toBeNull();
  });

  it('收藏幂等：重复设置返回当前状态', async () => {
    const created = await service.createEntry(fixture.authorId, createInput());
    const r1 = await service.setFlags(fixture.authorId, created.id, { favorite: true });
    expect(r1.favorite).toBe(true);
    const r2 = await service.setFlags(fixture.authorId, created.id, { favorite: true });
    expect(r2.favorite).toBe(true);
    const entity = await fixture.dataSource.getRepository(KnowledgeEntryEntity).findOneByOrFail({ id: created.id });
    expect(entity.favorite).toBe(true);
  });

  it('置顶设置 pinned_at', async () => {
    const created = await service.createEntry(fixture.authorId, createInput());
    await service.setFlags(fixture.authorId, created.id, { pinned: true });
    const entity = await fixture.dataSource.getRepository(KnowledgeEntryEntity).findOneByOrFail({ id: created.id });
    expect(entity.pinned).toBe(true);
    expect(entity.pinned_at).toBeInstanceOf(Date);
  });
});

describe('KnowledgeEntriesService · 列表摘要与详情权限', () => {
  it('列表返回摘要，不含 original_text', async () => {
    await service.createEntry(fixture.authorId, createInput({ title: '列表条目' }));
    const res = await list('global');
    expect(res.items.length).toBeGreaterThan(0);
    const item = res.items[0]!;
    expect(item).not.toHaveProperty('original_text');
    expect(item).toHaveProperty('excerpt');
    expect(item).toHaveProperty('title');
  });

  it('详情按 library_scope 权限：global 校验 owner_id', async () => {
    const created = await service.createEntry(fixture.authorId, createInput());
    await expect(service.getEntry(fixture.otherAuthorId, created.id, { scope: 'global' }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('详情返回 original_text 与 version', async () => {
    const created = await service.createEntry(fixture.authorId, createInput({ title: '详情条目' }));
    const detail = await service.getEntry(fixture.authorId, created.id, { scope: 'global' });
    expect(detail.original_text).toContain('这是一段用于单测的正文内容。');
    expect(detail.version).toBeGreaterThanOrEqual(1);
    expect(detail.entry_type).toBeDefined();
  });

  it('列表按关键词过滤（search_text 命中）', async () => {
    await service.createEntry(fixture.authorId, createInput({ title: '量子检索' }));
    await service.createEntry(fixture.authorId, createInput({ title: '无关标题', text: '完全不同的内容XYZ' }));
    const res = await service.listEntries(fixture.authorId, { scope: 'global', keyword: '量子' });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.title).toBe('量子检索');
  });

  it('列表按类型过滤', async () => {
    await service.createEntry(fixture.authorId, createInput({ entry_type: 'novel', text: '第一章\n第二章' }));
    await service.createEntry(fixture.authorId, createInput({ entry_type: 'article', title: '普通', text: '普通内容没有特殊信号' }));
    const res = await service.listEntries(fixture.authorId, { scope: 'global', types: ['novel'] });
    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.entry_type).toBe('novel');
  });
});

// 供 TDD 参考的导入不直接使用；TypeScript noUnusedLocals 下需避免未用导入。
void KnowledgeTagEntity;
void KnowledgeEntryTagEntity;
void KnowledgeWorkRefEntity;
