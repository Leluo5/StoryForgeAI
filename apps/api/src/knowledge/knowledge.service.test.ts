import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { KnowledgeService, hashContent } from './knowledge.service';
import type { CommitKnowledgeEntryRequest, KnowledgeType } from '@storyforge/contracts';

let fixture: WritingFixture;
let service: KnowledgeService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new KnowledgeService(fixture.dataSource);
});

afterEach(() => destroyWritingFixture(fixture));

function commitInput(overrides: Partial<CommitKnowledgeEntryRequest> = {}): CommitKnowledgeEntryRequest {
  return {
    type: 'article',
    title: '测试文章',
    source: 'paste',
    raw_content: '这是一篇用于单测的文章正文。',
    structured: { paragraphs: ['这是一篇用于单测的文章正文。'], key_points: ['要点'], summary: '摘要', tag_list: ['测试'] },
    tags: ['测试', '文章'],
    links: [],
    ...overrides
  };
}

describe('KnowledgeService · 内容哈希', () => {
  it('sha256 十六进制长度 64', () => {
    expect(hashContent('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashContent('abc')).toBe(hashContent('abc'));
    expect(hashContent('abc')).not.toBe(hashContent('abd'));
  });
});

describe('KnowledgeService · CRUD', () => {
  it('commit 入库并返回 id/status', async () => {
    const res = await service.commit(fixture.authorId, commitInput());
    expect(res.status).toBe('saved');
    expect(res.id).toBeTruthy();
    const got = await service.getById(fixture.authorId, res.id);
    expect(got.title).toBe('测试文章');
    expect(got.type).toBe('article');
    expect(got.content_hash).toBe(hashContent('这是一篇用于单测的文章正文。'));
  });

  it('commit 幂等：同 author+content_hash 返回已有，不新建', async () => {
    const first = await service.commit(fixture.authorId, commitInput());
    const second = await service.commit(fixture.authorId, commitInput());
    expect(second.id).toBe(first.id);
  });

  it('createPreview 未入库返回 preview 骨架', async () => {
    const preview = await service.createPreview(fixture.authorId, {
      source: 'paste',
      type: 'auto',
      raw_content: '新内容无哈希冲突'
    });
    expect(preview.status).toBe('preview');
    expect(preview.structured).toEqual({});
  });

  it('createPreview 命中已有哈希返回 saved + 已有 id', async () => {
    const committed = await service.commit(fixture.authorId, commitInput());
    const preview = await service.createPreview(fixture.authorId, {
      source: 'paste',
      type: 'auto',
      raw_content: '这是一篇用于单测的文章正文。'
    });
    expect(preview.status).toBe('saved');
    expect(preview.id).toBe(committed.id);
  });

  it('update 更新 title/structured/tags/links', async () => {
    const created = await service.commit(fixture.authorId, commitInput());
    const updated = await service.update(fixture.authorId, created.id, {
      title: '更新标题',
      tags: ['新标签'],
      structured: { summary: '新摘要' },
      links: []
    });
    expect(updated.title).toBe('更新标题');
    expect(updated.tags).toEqual(['新标签']);
  });

  it('getById 越权（其他 author）返回 404 隐藏存在性', async () => {
    const created = await service.commit(fixture.authorId, commitInput());
    await expect(service.getById(fixture.otherAuthorId, created.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('delete 删除条目并清理其他条目 links 引用', async () => {
    const a = await service.commit(fixture.authorId, commitInput({ title: 'A' }));
    const b = await service.commit(fixture.authorId, commitInput({ title: 'B', raw_content: 'B 的独立内容', links: [a.id] }));
    await service.delete(fixture.authorId, a.id);
    await expect(service.getById(fixture.authorId, a.id)).rejects.toBeInstanceOf(NotFoundException);
    const bAfter = await service.getById(fixture.authorId, b.id);
    expect(bAfter.links).not.toContain(a.id);
  });
});

describe('KnowledgeService · 统一检索（四维过滤 + 分页）', () => {
  it('keyword 匹配 title/raw_content/structured', async () => {
    const created = await service.commit(fixture.authorId, commitInput({ title: '量子纠缠综述' }));
    const r = await service.searchEntries(fixture.authorId, { page: 1, page_size: 20, keyword: '量子' });
    expect(r.total).toBe(1);
    expect(r.items[0]?.id).toBe(created.id);
  });

  it('type 过滤', async () => {
    await service.commit(fixture.authorId, commitInput({ type: 'article' }));
    const novel = await service.commit(fixture.authorId, commitInput({ type: 'novel', raw_content: '小说内容', title: '小说' }));
    const r = await service.searchEntries(fixture.authorId, { page: 1, page_size: 20, type: 'novel' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.id).toBe(novel.id);
  });

  it('tag 过滤', async () => {
    const created = await service.commit(fixture.authorId, commitInput({ tags: ['科幻'] }));
    const r = await service.searchEntries(fixture.authorId, { page: 1, page_size: 20, tag: '科幻' });
    expect(r.items.some((i) => i.id === created.id)).toBe(true);
  });

  it('分页：page/page_size', async () => {
    for (let i = 0; i < 5; i++) {
      await service.commit(fixture.authorId, commitInput({ title: `条目${i}`, raw_content: `内容${i}` }));
    }
    const r = await service.searchEntries(fixture.authorId, { page: 1, page_size: 2 });
    expect(r.total).toBe(5);
    expect(r.items).toHaveLength(2);
  });
});

describe('KnowledgeService · 关联', () => {
  it('addLink 建立双向引用（source→target）', async () => {
    const a = await service.commit(fixture.authorId, commitInput({ title: 'A' }));
    const b = await service.commit(fixture.authorId, commitInput({ title: 'B', raw_content: 'B 内容' }));
    const linked = await service.addLink(fixture.authorId, a.id, { target_id: b.id, type: 'reference' });
    expect(linked.links).toContain(b.id);
  });

  it('addLink 禁止自链', async () => {
    const a = await service.commit(fixture.authorId, commitInput({ title: 'A' }));
    await expect(service.addLink(fixture.authorId, a.id, { target_id: a.id, type: 'reference' }))
      .rejects.toThrow();
  });

  it('removeLink 移除引用', async () => {
    const a = await service.commit(fixture.authorId, commitInput({ title: 'A', links: [randomUUID()] }));
    const target = randomUUID();
    // 先 add 再 remove
    const b = await service.commit(fixture.authorId, commitInput({ title: 'B', raw_content: 'B2' }));
    await service.addLink(fixture.authorId, a.id, { target_id: b.id, type: 'reference' });
    const removed = await service.removeLink(fixture.authorId, a.id, b.id);
    expect(removed.links).not.toContain(b.id);
    void target;
  });
});
