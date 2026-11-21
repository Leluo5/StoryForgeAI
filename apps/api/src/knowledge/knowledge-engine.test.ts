import { describe, expect, it } from 'vitest';
import type { KnowledgeEntry } from '@storyforge/contracts';
import { KnowledgeParserService, TypeUncertainError } from './knowledge-parser.service';
import { KnowledgeOutlineService } from './knowledge-outline.service';
import { KnowledgeLinkerService, tfidfSimilarity, tokenize } from './knowledge-linker.service';
import { MockKnowledgeLlmProvider } from './knowledge-llm.provider';
import type { KnowledgeLlmContext } from './knowledge-llm.provider';

const llm = new MockKnowledgeLlmProvider();
const outline = new KnowledgeOutlineService(llm);
const parser = new KnowledgeParserService(llm, outline);
const linker = new KnowledgeLinkerService(llm);

function ctx(rawContent: string, title: string | undefined = undefined, source = 'paste'): KnowledgeLlmContext {
  return title === undefined ? { rawContent, source } : { rawContent, title, source };
}

describe('KnowledgeParserService · 类型识别', () => {
  it('手动指定优先于 LLM', async () => {
    expect(await parser.detectType(ctx('内容'), 'paper')).toBe('paper');
  });

  it('LLM 启发式：论文→paper、小说→novel、灵感→inspiration、其余→article', async () => {
    expect(await parser.detectType(ctx('这是一篇研究实验论文'))).toBe('paper');
    expect(await parser.detectType(ctx('这是小说章节，主角登场'))).toBe('novel');
    expect(await parser.detectType(ctx('有个灵感想法点子'))).toBe('inspiration');
    expect(await parser.detectType(ctx('普通内容'))).toBe('article');
  });

  it('不确定时抛 TypeUncertainError', async () => {
    const uncertain = { detectType: async () => ({ type: 'uncertain' as const }) };
    const p = new KnowledgeParserService(uncertain as never, outline);
    await expect(p.detectType(ctx('x'))).rejects.toBeInstanceOf(TypeUncertainError);
  });
});

describe('KnowledgeParserService · 四类拆分', () => {
  it('article：按空行分段', async () => {
    const r = await parser.parseArticle(ctx('第一段。\n\n第二段。'));
    expect(r.paragraphs).toHaveLength(2);
    expect(r.paragraphs[0]).toBe('第一段。');
    expect(r.summary).toContain('第一段');
  });

  it('paper：段落映射到研究问题/方法/结论', async () => {
    const r = await parser.parsePaper(ctx('问题A\n\n方法B\n\n结论C'));
    expect(r.research_question).toContain('问题A');
    expect(r.research_method).toContain('方法B');
    expect(r.core_conclusion).toContain('结论C');
  });

  it('novel：plot_lines 来自段落', async () => {
    const r = await parser.parseNovel(ctx('第一章。\n\n第二章。', '书名'));
    expect(r.plot_lines).toHaveLength(2);
    expect(r.world_setting).toBe('书名');
  });

  it('inspiration：保留原文', async () => {
    const r = await parser.parseInspiration(ctx('一个想法'));
    expect(r.raw_text).toBe('一个想法');
    expect(r.enriched_text).toBe('一个想法');
  });
});

describe('KnowledgeParserService · 分块与降级', () => {
  it('超大文本分块后合并（article）', async () => {
    const big = '段落。\n\n'.repeat(2000); // 约 8000 字 > 阈值 6000
    const r = await parser.parseArticle(ctx(big));
    expect(r.paragraphs.length).toBeGreaterThan(1);
    expect(r.key_points.length).toBeLessThanOrEqual(10);
  });

  it('解析失败降级为原文存储', async () => {
    const failing = { detectType: async () => 'article' as const, parseArticle: async () => { throw new Error('llm down'); } };
    const p = new KnowledgeParserService(failing as never, outline);
    const r = await p.parseEntry(ctx('原文内容'), 'article');
    expect(r.degraded).toBe(true);
    expect(r.structured.raw).toBe('原文内容');
  });

  it('parseEntry 成功路径返回非降级', async () => {
    const r = await parser.parseEntry(ctx('普通文章内容'), 'article');
    expect(r.degraded).toBe(false);
    expect(r.type).toBe('article');
  });
});

describe('KnowledgeParserService · 自动触发大纲', () => {
  it('novel 有章节标题时触发大纲并合并', async () => {
    const novelCtx = ctx('第一章 开局\n\n正文内容\n\n第二章 发展\n\n更多内容', '书名');
    const novelStructured = await parser.parseNovel(novelCtx);
    const withOutline = await parser.triggerOutlineForNovel(novelCtx, novelStructured);
    expect(withOutline.outline).toBeDefined();
    expect(withOutline.outline?.chapters.length).toBe(2);
  });

  it('无章节结构时保留拆文结果（无 outline）', async () => {
    const novelCtx = ctx('只是一段没有章节标记的内容', '书名');
    const novelStructured = await parser.parseNovel(novelCtx);
    const withOutline = await parser.triggerOutlineForNovel(novelCtx, novelStructured);
    expect(withOutline.outline).toBeUndefined();
  });
});

describe('KnowledgeOutlineService · 四维度大纲', () => {
  it('识别中文章节标题并生成大纲', async () => {
    const r = await outline.extractOutline(ctx('第一章 初入江湖\n\n第二章 再起波澜', '书'));
    expect(r.outline).toBeDefined();
    expect(r.outline?.chapters).toHaveLength(2);
    expect(r.outline?.chapters[0]?.title).toContain('第一章');
    expect(r.outline?.plot_nodes.length).toBeGreaterThan(0);
    expect(r.outline?.core_storylines.main).toBeDefined();
  });

  it('无章节且无情节返回 no_chapters', async () => {
    const r = await outline.extractOutline(ctx('没有结构'));
    expect(r.error).toBe('no_chapters');
  });
});

describe('KnowledgeLinkerService · 相似度与关联', () => {
  it('tokenize 提取中英文', () => {
    expect(tokenize('Hello 世界')).toContain('hello');
    expect(tokenize('Hello 世界')).toContain('世');
  });

  it('tfidfSimilarity：相似文本得分高，无关文本低', () => {
    const high = tfidfSimilarity('量子纠缠研究', '量子纠缠理论探讨');
    const low = tfidfSimilarity('量子纠缠', '烹饪美食指南');
    expect(high).toBeGreaterThan(low);
    expect(high).toBeGreaterThan(0);
  });

  it('linkInspiration 返回前 TOP_N 关联 + 补充文本', async () => {
    const entries = [
      { id: '1', raw_content: '量子纠缠在通信中的应用' },
      { id: '2', raw_content: '完全无关的烹饪内容' },
      { id: '3', raw_content: '量子纠缠与加密' }
    ] as unknown as KnowledgeEntry[];
    const r = await linker.linkInspiration('量子纠缠新进展', entries);
    expect(r.related_ids).toContain('1');
    expect(r.related_ids).toContain('3');
    expect(r.related_ids).not.toContain('2');
    expect(r.related_ids.length).toBeLessThanOrEqual(3);
    expect(r.enriched_text).toBe('量子纠缠新进展');
  });

  it('无匹配时返回空关联', async () => {
    const entries = [{ id: '1', raw_content: '食谱' }] as unknown as KnowledgeEntry[];
    const r = await linker.linkInspiration('量子纠缠', entries);
    expect(r.related_ids).toEqual([]);
  });
});
