import { describe, it, expect } from 'vitest';
import type {
  ArticleStructured,
  InspirationStructured,
  KnowledgeEntryStructured,
  KnowledgeEntryType,
  NovelStructured,
  PaperStructured
} from '@storyforge/contracts';
import {
  chunkText,
  mergeStructured,
  type StructureInput,
  type StructureBlock
} from './structure.provider';
import { LlmKnowledgeStructureProvider } from './structure.llm';
import type { KnowledgeLlmProvider } from './knowledge-llm.provider';

// ───────────────────────────── 测试辅助 ─────────────────────────────

/** 收窄 union 到指定 entry_type 分支（类型守卫） */
function ofType<T extends KnowledgeEntryStructured['entry_type']>(
  s: KnowledgeEntryStructured,
  type: T
): Extract<KnowledgeEntryStructured, { entry_type: T }> {
  if (s.entry_type !== type) throw new Error(`expected ${type}, got ${s.entry_type}`);
  return s as Extract<KnowledgeEntryStructured, { entry_type: T }>;
}

/** 构造 StructureInput 的辅助函数 */
function input(partial: Partial<StructureInput> = {}): StructureInput {
  return {
    entryId: '6f3b4a2c-9c1e-4d2a-8b3f-1a2b3c4d5e6f',
    rawContent: '这是一段测试内容。',
    entryType: 'article' as KnowledgeEntryType,
    title: '测试条目',
    ...partial
  };
}

// ───────────────────────────── chunkText 分块 ─────────────────────────────

describe('chunkText 分块', () => {
  it('空内容返回空数组', () => {
    expect(chunkText('', input())).toEqual([]);
  });

  it('单段短文本返回单个块', () => {
    const blocks = chunkText('只有一段内容。', input());
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.text).toBe('只有一段内容。');
    expect(blocks[0]!.type).toBe('article');
  });

  it('按空行分段切分', () => {
    const blocks = chunkText('第一段。\n\n第二段。\n\n第三段。', input());
    expect(blocks).toHaveLength(3);
    expect(blocks.map((b) => b.text)).toEqual(['第一段。', '第二段。', '第三段。']);
  });

  it('单块长度不超过 6000 字符', () => {
    // 生成 20000 字符的连续文本（无空行分隔，触发长度切分）
    const longText = '长'.repeat(20_000);
    const blocks = chunkText(longText, input());
    for (const block of blocks) {
      expect(block.text.length).toBeLessThanOrEqual(6000);
    }
    // 至少分成 4 块（20000/6000 ≈ 3.33 → 4）
    expect(blocks.length).toBeGreaterThanOrEqual(4);
  });

  it('相邻块重叠 200 字符', () => {
    const longText = '长'.repeat(12_000);
    const blocks = chunkText(longText, input());
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    // 检查相邻块的重叠：block[i].text 末尾与 block[i+1].text 开头有重叠
    for (let i = 0; i < blocks.length - 1; i++) {
      const overlap = blocks[i]!.text.slice(-200);
      expect(blocks[i + 1]!.text.startsWith(overlap.slice(0, 100))).toBe(true);
    }
  });

  it('按标题层级 #~### 切分并保留标题', () => {
    const md = '# 第一章\n\n内容一。\n\n## 第一节\n\n内容二。\n\n### 小节\n\n内容三。';
    const blocks = chunkText(md, input());
    // 标题作为块首，段落跟随
    expect(blocks.some((b) => b.text.includes('第一章'))).toBe(true);
    expect(blocks.some((b) => b.text.includes('第一节'))).toBe(true);
    expect(blocks.some((b) => b.text.includes('小节'))).toBe(true);
  });

  it('小说按章节标题优先切分', () => {
    const novelText = '第一章 开始\n\n正文一。\n\n第二章 发展\n\n正文二。\n\n第三章 高潮\n\n正文三。';
    const blocks = chunkText(novelText, input({ entryType: 'novel' }));
    // 章节标题应作为独立块边界
    const chapterBlocks = blocks.filter((b) => /第[一二三四五六七八九十]+章/.test(b.text));
    expect(chapterBlocks.length).toBeGreaterThanOrEqual(3);
  });

  it('非小说类型不做章节优先切分', () => {
    const articleText = '第一章 背景\n\n正文一。\n\n第二章 方法\n\n正文二。';
    const blocks = chunkText(articleText, input({ entryType: 'article' }));
    // article 类型下没有 chapterBoundary 标记（章节优先仅对 novel 生效）
    expect(blocks.every((b) => b.chapterBoundary !== true)).toBe(true);
    // 段落仍按空行独立成块
    expect(blocks.length).toBe(4);
  });
});

// ───────────────────────────── mergeStructured 合并去重 ─────────────────────────────

describe('mergeStructured 合并', () => {
  it('相同 type+title 去重保留原文顺序', () => {
    const blocks: StructureBlock[] = [
      {
        text: '内容一',
        type: 'article',
        order: 0,
        structured: { entry_type: 'article', sections: [{ heading: '标题A', content: '内容A' }], key_points: ['点A'], tags: ['标签1'] }
      },
      {
        text: '内容二',
        type: 'article',
        order: 1,
        structured: { entry_type: 'article', sections: [{ heading: '标题A', content: '内容A' }], key_points: ['点A'], tags: ['标签1'] }
      }
    ];
    const merged = mergeStructured(blocks, input({ entryType: 'article' }));
    // 相同 title+content 合并后只保留一份
    const structured = ofType(merged.structured, 'article');
    expect(structured.entry_type).toBe('article');
    // key_points 去重
    expect(structured.key_points).toEqual(['点A']);
    // tags 去重
    expect(structured.tags).toEqual(['标签1']);
  });

  it('不同块内容保留原文顺序拼接', () => {
    const blocks: StructureBlock[] = [
      {
        text: '第一块',
        type: 'article',
        order: 0,
        structured: { entry_type: 'article', sections: [{ heading: 'H1', content: 'C1' }], key_points: ['K1'], tags: ['T1'] }
      },
      {
        text: '第二块',
        type: 'article',
        order: 1,
        structured: { entry_type: 'article', sections: [{ heading: 'H2', content: 'C2' }], key_points: ['K2'], tags: ['T2'] }
      }
    ];
    const merged = mergeStructured(blocks, input({ entryType: 'article' }));
    const structured = ofType(merged.structured, 'article');
    expect(structured.sections).toHaveLength(2);
    expect(structured.sections[0]?.heading).toBe('H1');
    expect(structured.sections[1]?.heading).toBe('H2');
    expect(structured.key_points).toEqual(['K1', 'K2']);
  });

  it('标签并集去重且不超过 20 个', () => {
    const tags = Array.from({ length: 30 }, (_, i) => `标签${i}`);
    const blocks: StructureBlock[] = [
      {
        text: '块1',
        type: 'article',
        order: 0,
        structured: { entry_type: 'article', sections: [], key_points: [], tags: tags.slice(0, 20) }
      },
      {
        text: '块2',
        type: 'article',
        order: 1,
        structured: { entry_type: 'article', sections: [], key_points: [], tags: tags.slice(10) }
      }
    ];
    const merged = mergeStructured(blocks, input({ entryType: 'article' }));
    const structured = ofType(merged.structured, 'article');
    expect(structured.tags.length).toBeLessThanOrEqual(20);
  });

  it('论文五要素按块合并取信息量最大者', () => {
    const blocks: StructureBlock[] = [
      {
        text: '块1',
        type: 'paper',
        order: 0,
        structured: {
          entry_type: 'paper',
          research_question: '短问题',
          method: '方法A',
          findings: '发现A',
          contributions: '贡献A',
          limitations: '限制A',
          keywords: ['关键词1']
        }
      },
      {
        text: '块2',
        type: 'paper',
        order: 1,
        structured: {
          entry_type: 'paper',
          research_question: '这是一个更长的研究问题，包含更多信息量。',
          method: '方法B',
          findings: '发现B',
          contributions: '贡献B',
          limitations: '限制B',
          keywords: ['关键词2']
        }
      }
    ];
    const merged = mergeStructured(blocks, input({ entryType: 'paper' }));
    const structured = ofType(merged.structured, 'paper');
    expect(structured.entry_type).toBe('paper');
    // 取信息量更大的 research_question（块2更长）
    expect(structured.research_question).toBe('这是一个更长的研究问题，包含更多信息量。');
  });

  it('小说角色按名称合并', () => {
    const blocks: StructureBlock[] = [
      {
        text: '块1',
        type: 'novel',
        order: 0,
        structured: {
          entry_type: 'novel',
          characters: [{ name: '张三', role: '主角', description: '描述1' }],
          plot_summary: '情节1',
          narrative_style: '风格',
          worldview: '世界观'
        }
      },
      {
        text: '块2',
        type: 'novel',
        order: 1,
        structured: {
          entry_type: 'novel',
          characters: [{ name: '张三', role: '主角', description: '描述1' }, { name: '李四', role: '配角', description: '描述2' }],
          plot_summary: '情节2',
          narrative_style: '风格',
          worldview: '世界观'
        }
      }
    ];
    const merged = mergeStructured(blocks, input({ entryType: 'novel' }));
    expect(merged.structured.entry_type).toBe('novel');
    // 张三去重，李四保留
    expect(ofType(merged.structured, 'novel').characters.map((c) => c.name)).toEqual(['张三', '李四']);
  });
});

// ───────────────────────────── LlmKnowledgeStructureProvider ─────────────────────────────

describe('LlmKnowledgeStructureProvider', () => {
  // 构造 mock 旧一代 LLM Provider（确定性）
  function mockLlm(overrides: Partial<{
    parseArticle: () => Promise<ArticleStructured>;
    parsePaper: () => Promise<PaperStructured>;
    parseNovel: () => Promise<NovelStructured>;
    parseInspiration: () => Promise<InspirationStructured>;
  }> = {}) {
    return {
      detectType: async () => ({ type: 'article' as const }),
      parseArticle: overrides.parseArticle ?? (async () => ({ paragraphs: ['段落一', '段落二'], key_points: ['要点'], summary: '摘要', tag_list: ['标签'] })),
      parsePaper: overrides.parsePaper ?? (async () => ({ research_question: '问题', research_method: '方法', core_conclusion: '结论', limitation: '限制', design_insight: '洞察' })),
      parseNovel: overrides.parseNovel ?? (async () => ({ characters: ['张三'], plot_lines: ['情节'], narrative_style: ['风格'], world_setting: '世界观' })),
      parseInspiration: overrides.parseInspiration ?? (async () => ({ raw_text: '原文', enriched_text: '补全', related_ids: [] }))
    } as unknown as KnowledgeLlmProvider;
  }

  it('article 输入调用 parseArticle 并适配为契约结构', async () => {
    const provider = new LlmKnowledgeStructureProvider(mockLlm());
    const result = await provider.structure(input({ entryType: 'article', rawContent: '段落一。\n\n段落二。' }));
    const structured = ofType(result.structured, 'article');
    expect(structured.sections.length).toBeGreaterThan(0);
    expect(structured.tags).toEqual(['标签']);
  });

  it('parseBlock 失败时降级为空结构并记录 warning', async () => {
    const provider = new LlmKnowledgeStructureProvider(
      mockLlm({ parseArticle: async () => { throw new Error('LLM timeout'); } })
    );
    const result = await provider.structure(input({ entryType: 'article', rawContent: '一段内容。' }));
    // 不抛错，降级为空结构
    const structured = ofType(result.structured, 'article');
    expect(structured.sections).toEqual([]);
    expect(result.warnings.some((w) => w.startsWith('BLOCK_STRUCTURE_FAILED'))).toBe(true);
  });

  it('rawContent 超限抛 KNOWLEDGE_TEXT_TOO_LARGE', async () => {
    const provider = new LlmKnowledgeStructureProvider(mockLlm());
    await expect(
      provider.structure(input({ entryType: 'article', rawContent: '长'.repeat(8_000_001) }))
    ).rejects.toThrow('KNOWLEDGE_TEXT_TOO_LARGE');
  });
});
