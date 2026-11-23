import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { KnowledgeService } from './knowledge.service';
import { KnowledgeParserService } from './knowledge-parser.service';
import { KnowledgeOutlineService } from './knowledge-outline.service';
import { KnowledgeLinkerService } from './knowledge-linker.service';
import { KnowledgeMarkdownService } from './knowledge-markdown.service';
import { MockKnowledgeLlmProvider } from './knowledge-llm.provider';
import { KnowledgeController } from './knowledge.controller';
import type { AuthenticatedRequest } from '../common/http';

let fixture: WritingFixture;
let controller: KnowledgeController;
let knowledge: KnowledgeService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  const llm = new MockKnowledgeLlmProvider();
  const outline = new KnowledgeOutlineService(llm);
  knowledge = new KnowledgeService(fixture.dataSource);
  const parser = new KnowledgeParserService(llm, outline);
  const linker = new KnowledgeLinkerService(llm);
  const markdown = new KnowledgeMarkdownService();
  controller = new KnowledgeController(knowledge, parser, outline, linker, markdown);
});

afterEach(() => destroyWritingFixture(fixture));

/** 构造已认证请求（author = fixture.authorId，绕过来 guard 直调方法） */
function req(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    requestId: 'req-test',
    cookies: {},
    get: () => undefined,
    author: { id: fixture.authorId, email: 'x@example.com', display_name: 'X', created_at: '', updated_at: '' },
    ...overrides
  } as unknown as AuthenticatedRequest;
}

const ARTICLE_BODY = '这是一篇普通文章内容，包含若干段落。第二段继续展开说明。';

describe('KnowledgeController · 3.1 统一录入', () => {
  it('article 返回 preview + 结构化结果 + degraded=false', async () => {
    const res = await controller.createEntry(req(), {
      source: 'paste',
      type: 'auto',
      raw_content: ARTICLE_BODY
    });
    const d = res.data as any;
    expect(d.status).toBe('preview');
    expect(d.type).toBe('article');
    expect(d.degraded).toBe(false);
    expect(d.structured).toHaveProperty('paragraphs');
  });

  it('inspiration 自动关联补充 enriched_text + related_ids', async () => {
    // 先入库一篇相近文章（无相似内容不关联，仅验证字段存在）
    await knowledge.commit(fixture.authorId, {
      type: 'inspiration',
      title: '既有灵感',
      source: 'paste',
      raw_content: '既有的一个灵感点子',
      structured: { raw_text: '既有的一个灵感点子', enriched_text: '', related_ids: [] },
      tags: [],
      links: []
    });
    const res = await controller.createEntry(req(), {
      source: 'paste',
      type: 'inspiration',
      title: '新灵感想法',
      raw_content: '一个新的灵感点子：关于时间旅行的叙事'
    });
    const d = res.data as any;
    expect(d.type).toBe('inspiration');
    expect(d.status).toBe('preview');
    expect(d.structured).toHaveProperty('enriched_text');
    expect(d.structured).toHaveProperty('related_ids');
  });

  it('手动指定 type 优先于 LLM 识别', async () => {
    const res = await controller.createEntry(req(), {
      source: 'paste',
      type: 'novel',
      title: '指定为小说',
      raw_content: '第一章 起始\n\n这是小说的开篇内容。'
    });
    expect((res.data as any).type).toBe('novel');
  });

  it('3.1 统一录入只生成预览，不落库（同内容两次均 preview）', async () => {
    const first = await controller.createEntry(req(), { source: 'paste', type: 'auto', raw_content: ARTICLE_BODY });
    const second = await controller.createEntry(req(), { source: 'paste', type: 'auto', raw_content: ARTICLE_BODY });
    // 3.1 语义：生成 preview 不落库；去重在 commit（3.2）时处理，此处均 preview
    expect(first.data.status).toBe('preview');
    expect(second.data.status).toBe('preview');
  });
});

describe('KnowledgeController · 3.2~3.7 入库/详情/编辑/删除/关联', () => {
  it('3.2 commit 幂等入库', async () => {
    const body = {
      type: 'article' as const,
      title: '控制器入库',
      source: 'paste' as const,
      raw_content: ARTICLE_BODY,
      structured: { paragraphs: [ARTICLE_BODY] },
      tags: ['t'],
      links: []
    };
    const first = await controller.commitEntry(req(), randomUUID(), body);
    expect(first.data.status).toBe('saved');
    const second = await controller.commitEntry(req(), randomUUID(), body);
    expect(second.data.id).toBe(first.data.id);
  });

  it('3.3 检索 + 3.4 详情', async () => {
    const body = {
      type: 'article' as const,
      title: '检索目标',
      source: 'paste' as const,
      raw_content: '检索正文关键词',
      structured: { paragraphs: ['检索正文关键词'] },
      tags: ['科幻'],
      links: []
    };
    const created = await controller.commitEntry(req(), randomUUID(), body);
    const list = await controller.searchEntries(req(), { page: 1, page_size: 20, keyword: '检索正文' });
    expect(list.data.total).toBe(1);
    expect(list.data.items[0]?.id).toBe(created.data.id);
    const detail = await controller.getEntry(req(), created.data.id);
    expect(detail.data.title).toBe('检索目标');
  });

  it('3.5 编辑 + 3.6 删除', async () => {
    const body = {
      type: 'article' as const,
      title: '待编辑',
      source: 'paste' as const,
      raw_content: '编辑前内容',
      structured: { paragraphs: ['编辑前内容'] },
      tags: [],
      links: []
    };
    const created = await controller.commitEntry(req(), randomUUID(), body);
    const updated = await controller.updateEntry(req(), created.data.id, { title: '已编辑', tags: ['x'] });
    expect(updated.data.title).toBe('已编辑');
    const del = await controller.deleteEntry(req(), created.data.id);
    expect(del.data.ok).toBe(true);
  });

  it('3.7 建立关联', async () => {
    const a = await controller.commitEntry(req(), randomUUID(), {
      type: 'article', title: 'A', source: 'paste', raw_content: '内容A', structured: {}, tags: [], links: []
    });
    const b = await controller.commitEntry(req(), randomUUID(), {
      type: 'article', title: 'B', source: 'paste', raw_content: '内容B', structured: {}, tags: [], links: []
    });
    const linked = await controller.linkEntry(req(), a.data.id, { target_id: b.data.id, type: 'reference' });
    // 中间态（L1）：关联已迁移为 knowledge_entry_links 多表关系，旧 controller 暂返回空 links 占位；
    // 真实断言由 T36 改写（F3 §4 处置表）。
    expect(linked.data.links).toEqual([]);
  });
});

describe('KnowledgeController · 3.8 大纲提取', () => {
  it('无章节标题返回 no_chapters（不写回）', async () => {
    const body = {
      type: 'novel' as const,
      title: '无章节小说',
      source: 'paste' as const,
      raw_content: '一段没有章节标题的正文内容。',
      structured: { characters: [], plot_lines: ['一段没有章节标题的正文内容。'], narrative_style: [], world_setting: '' },
      tags: [],
      links: []
    };
    const created = await controller.commitEntry(req(), randomUUID(), body);
    const res = await controller.extractOutline(req(), { novel_id: created.data.id });
    expect(res.data).toHaveProperty('error', 'no_chapters');
  });

  it('含章节标题返回 outline 并写回 structured.outline', async () => {
    const body = {
      type: 'novel' as const,
      title: '有章节小说',
      source: 'paste' as const,
      raw_content: '第一章 开端\n\n内容一。\n\n第二章 发展\n\n内容二。',
      structured: { characters: [], plot_lines: [], narrative_style: [], world_setting: '' },
      tags: [],
      links: []
    };
    const created = await controller.commitEntry(req(), randomUUID(), body);
    const res = await controller.extractOutline(req(), { novel_id: created.data.id });
    const d = res.data as any;
    expect(d.outline).toBeTruthy();
    expect(d.outline.chapters.length).toBeGreaterThan(0);
    // 已写回
    const detail = await controller.getEntry(req(), created.data.id);
    expect((detail.data.structured as any)).toHaveProperty('outline');
  });
});

describe('KnowledgeController · 3.9 Markdown 导入导出', () => {
  it('3.9a 单文件导出（single）', async () => {
    const created = await controller.commitEntry(req(), randomUUID(), {
      type: 'article', title: '导出目标', source: 'paste', raw_content: '导出正文', structured: {}, tags: [], links: []
    });
    const res = await controller.exportMarkdown(req(), { mode: 'single', entry_ids: [created.data.id] });
    const d = res.data as any;
    expect(d.mode).toBe('single');
    expect(d.total).toBe(1);
    expect(d.content).toContain('# 导出目标');
    expect(d.content).toContain('导出正文');
    expect(d.file_name).toMatch(/\.md$/);
  });

  it('3.9b 导入预览（bad_extension + 正常）', async () => {
    const res = await controller.importPreview(req(), {
      files: [
        { file_name: 'a.txt', content: '文本内容' },
        { file_name: 'b.md', content: '# 导入文章\n\n正文内容。' }
      ],
      target_type: 'article'
    });
    const d = res.data as any;
    expect(d.items[0]?.reason).toBe('bad_extension');
    expect(d.items[1]?.title).toBe('导入文章');
  });

  it('3.9c 确认导入（新建 + 冲突改名）', async () => {
    // 预置一条同标题内容不同的条目，触发 name_collision
    await controller.commitEntry(req(), randomUUID(), {
      type: 'article', title: '已有标题', source: 'paste', raw_content: '旧内容', structured: {}, tags: [], links: []
    });
    const res = await controller.importMarkdown(req(), {
      items: [
        { file_name: 'x.md', title: '已有标题', type: 'article', content: '新内容不同' },
        { file_name: 'y.md', title: '全新标题', type: 'article', content: '全新内容' }
      ],
      target_type: 'article',
      conflict_strategy: 'rename'
    });
    const d = res.data as any;
    expect(d.total).toBe(2);
    expect(d.success).toBe(2);
    expect(d.created).toBe(2);
    expect(d.updated).toBe(0);
  });

  it('3.9d 单文件校验', async () => {
    const bad = await controller.validateMarkdown(req(), { file_name: 'x.txt', content: '内容' });
    expect(bad.data.valid).toBe(false);
    expect(bad.data.reason).toBe('bad_extension');
    const good = await controller.validateMarkdown(req(), { file_name: 'x.md', content: '# 标题\n\n正文' });
    expect(good.data.valid).toBe(true);
  });
});
