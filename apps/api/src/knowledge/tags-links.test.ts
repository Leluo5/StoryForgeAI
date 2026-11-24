// M3c-3 知识库 T15 标签服务与跨条目关联
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.2、§4.3、§2.2.3、§2.2.4、§2.2.5
// 覆盖：标签去重（大小写不敏感）、重命名刷新 search_text、删除清理不留孤儿、
//       关联双向幂等、自关联拒绝、跨库拒绝、404、幂等断开。
import { ConflictException, NotFoundException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { KnowledgeEntriesService } from './entries.service';
import { KnowledgeTagsService } from './tags.service';
import { KnowledgeLinksService } from './links.service';
import { KnowledgeEntryTagEntity } from '../database/knowledge-entry-tag.entity';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import type { KnowledgeEntryCreateRequest } from '@storyforge/contracts';

let fixture: WritingFixture;
let entries: KnowledgeEntriesService;
let tags: KnowledgeTagsService;
let links: KnowledgeLinksService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  entries = new KnowledgeEntriesService(fixture.dataSource);
  tags = new KnowledgeTagsService(fixture.dataSource);
  links = new KnowledgeLinksService(fixture.dataSource);
});

afterEach(() => destroyWritingFixture(fixture));

function createInput(overrides: Partial<KnowledgeEntryCreateRequest> = {}): KnowledgeEntryCreateRequest {
  return {
    scope: 'global',
    title: '测试条目',
    text: '这是一段用于单测的正文内容。',
    tags: [],
    ...overrides
  };
}

async function makeEntry(title: string, text?: string) {
  const body = text ?? `${title}：正文内容足够用于测试，且内容各不相同以避免 content_hash 去重冲突。`;
  const res = await entries.createEntry(fixture.authorId, createInput({ title, text: body }));
  return res.id;
}

describe('KnowledgeTagsService · 标签', () => {
  it('新建标签：entry_count 初始为 0', async () => {
    const tag = await tags.createTag(fixture.authorId, { scope: 'global', name: '世界观' });
    expect(tag.name).toBe('世界观');
    expect(tag.entry_count).toBe(0);
  });

  it('同名标签（大小写不敏感）→ 409', async () => {
    await tags.createTag(fixture.authorId, { scope: 'global', name: '世界观' });
    await expect(tags.createTag(fixture.authorId, { scope: 'global', name: ' 世界 观 ' }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('标签列表：按库隔离并带条目数', async () => {
    const entryId = await makeEntry('条目A');
    await tags.createTag(fixture.authorId, { scope: 'global', name: '重要' });
    // 给条目A打上标签（updateEntry 的 ensureTags 复用已存在标签）
    await entries.updateEntry(fixture.authorId, entryId, { tags: ['重要'], expected_version: 1 });
    const list = await tags.listTags(fixture.authorId, 'global');
    const important = list.find((t) => t.name === '重要');
    expect(important).toBeDefined();
    expect(important!.entry_count).toBe(1);
  });

  it('重命名标签：刷新绑定条目 search_text', async () => {
    const entryId = await makeEntry('标签重算条目');
    const created = await tags.createTag(fixture.authorId, { scope: 'global', name: '旧名' });
    // 绑定到条目（ensureTags 复用已存在标签）
    await entries.updateEntry(fixture.authorId, entryId, { tags: ['旧名'], expected_version: 1 });
    const renamed = await tags.renameTag(fixture.authorId, created.id, '新名');
    expect(renamed.name).toBe('新名');
    // search_text 含新名、不含旧名
    const entity = await fixture.dataSource.getRepository(KnowledgeEntryEntity).findOneByOrFail({ id: entryId });
    expect(entity.search_text).toContain('新名');
    expect(entity.search_text).not.toContain('旧名');
  });

  it('删除标签：清理 entry_tags，不删条目', async () => {
    const entryId = await makeEntry('删除标签条目');
    const created = await tags.createTag(fixture.authorId, { scope: 'global', name: '待删' });
    await entries.updateEntry(fixture.authorId, entryId, { tags: ['待删'], expected_version: 1 });
    await tags.deleteTag(fixture.authorId, created.id);
    // 条目仍存在
    const detail = await entries.getEntry(fixture.authorId, entryId, { scope: 'global' });
    expect(detail.title).toBe('删除标签条目');
    // entry_tags 无孤儿
    const orphan = await fixture.dataSource.getRepository(KnowledgeEntryTagEntity)
      .findOneBy({ tag_id: created.id });
    expect(orphan).toBeNull();
  });

  it('重命名冲突：同库其他标签同名 → 409', async () => {
    await tags.createTag(fixture.authorId, { scope: 'global', name: '甲' });
    const b = await tags.createTag(fixture.authorId, { scope: 'global', name: '乙' });
    await expect(tags.renameTag(fixture.authorId, b.id, '甲')).rejects.toBeInstanceOf(ConflictException);
  });

  it('删除不存在标签 → 404', async () => {
    await expect(tags.deleteTag(fixture.authorId, '00000000-0000-0000-0000-000000000000'))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('KnowledgeLinksService · 跨条目关联', () => {
  it('建立关联：返回双向视图', async () => {
    const a = await makeEntry('关联源');
    const b = await makeEntry('关联目标');
    const link = await links.createLink(fixture.authorId, { source_entry_id: a, target_entry_id: b });
    expect(link.source_entry_id).toBe(a);
    expect(link.target_entry_id).toBe(b);
    expect(link.source_title).toBe('关联源');
    expect(link.target_title).toBe('关联目标');
  });

  it('自关联 → 409', async () => {
    const a = await makeEntry('自关联条目');
    await expect(links.createLink(fixture.authorId, { source_entry_id: a, target_entry_id: a }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('跨库关联 → 409', async () => {
    const a = await makeEntry('全局条目');
    // 作品库条目
    const w = await entries.createEntry(fixture.authorId, {
      scope: 'work',
      work_id: fixture.workId,
      title: '作品条目',
      text: '作品库正文内容。',
      tags: []
    });
    await expect(links.createLink(fixture.authorId, { source_entry_id: a, target_entry_id: w.id }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('重复关联（双向）→ 409 + 既有 id', async () => {
    const a = await makeEntry('重复源');
    const b = await makeEntry('重复目标');
    const first = await links.createLink(fixture.authorId, { source_entry_id: a, target_entry_id: b });
    // 反向 B→A 也视为已存在
    try {
      await links.createLink(fixture.authorId, { source_entry_id: b, target_entry_id: a });
      throw new Error('应当抛 409');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as any).response?.details?.link_id).toBe(first.id);
    }
  });

  it('listLinks：双向返回两端', async () => {
    const a = await makeEntry('双向源');
    const b = await makeEntry('双向目标');
    const c = await makeEntry('双向第三');
    await links.createLink(fixture.authorId, { source_entry_id: a, target_entry_id: b });
    await links.createLink(fixture.authorId, { source_entry_id: c, target_entry_id: a });
    const fromA = await links.listLinks(fixture.authorId, a);
    expect(fromA.length).toBe(2);
    const ids = fromA.map((l) => [l.source_entry_id, l.target_entry_id].sort().join('|'));
    expect(ids).toContain([a, b].sort().join('|'));
    expect(ids).toContain([a, c].sort().join('|'));
  });

  it('listLinks 条目不存在 → 404', async () => {
    await expect(links.listLinks(fixture.authorId, '00000000-0000-0000-0000-000000000000'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('deleteLink 幂等：不存在返回 ok', async () => {
    const res = await links.deleteLink(fixture.authorId, '00000000-0000-0000-0000-000000000000');
    expect(res).toEqual({ ok: true });
  });

  it('deleteLink 删除真实关联', async () => {
    const a = await makeEntry('删除源');
    const b = await makeEntry('删除目标');
    const link = await links.createLink(fixture.authorId, { source_entry_id: a, target_entry_id: b });
    const res = await links.deleteLink(fixture.authorId, link.id);
    expect(res).toEqual({ ok: true });
    const after = await links.listLinks(fixture.authorId, a);
    expect(after.length).toBe(0);
  });
});
