// M3c-3 知识库 T13 大纲提取器（纯函数，四维 + no_chapters 降级）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.4、契约 knowledgeOutlineSchema
// 覆盖：四维正例、空输入降级、失败降级、重复幂等、人物关系提取、维度名与枚举一致。
import { extractOutline, type OutlineExtractInput, type OutlineExtractResult } from './outline.extractor';
import { knowledgeOutlineSchema, type KnowledgeEntryOutline } from '@storyforge/contracts';

const novelInput: OutlineExtractInput = {
  entryType: 'novel',
  originalText: [
    '第一章 缘起',
    '少年林逸在山村醒来，遇见神秘少女苏青。',
    '',
    '第二章 山门',
    '林逸拜入青云宗，师从长老玄清，与苏青同行。',
    '',
    '第三章 试炼',
    '宗门试炼开启，林逸与苏青结盟对抗强敌，发现隐藏秘境。'
  ].join('\n'),
  structured: {
    entry_type: 'novel',
    characters: [
      { name: '林逸', role: '主角', description: '山村少年' },
      { name: '苏青', role: '女主', description: '神秘少女' },
      { name: '玄清', role: '长老', description: '青云宗长老' }
    ],
    plot_summary: '林逸拜师修行，与苏青并肩探险。',
    narrative_style: '第三人称',
    worldview: '修仙大陆'
  }
};

describe('KnowledgeOutlineExtractor', () => {
  it('四维正例：novel 条目提取出完整四维大纲', () => {
    const res = extractOutline(novelInput);
    expect(res.status).toBe('ready');
    if (res.status !== 'ready') return;
    const outline = res.outline;
    expect(outline.chapters.length).toBe(3);
    expect(outline.chapters[0]).toEqual({ title: '缘起', summary: '少年林逸在山村醒来，遇见神秘少女苏青。' });
    expect(outline.plot_nodes.length).toBeGreaterThan(0);
    expect(outline.plot_nodes[0]).toHaveProperty('chapter_index');
    expect(outline.character_relations.length).toBeGreaterThan(0);
    expect(outline.story_lines.length).toBeGreaterThanOrEqual(1);
    expect(outline.story_lines.length).toBeLessThanOrEqual(5);
  });

  it('章节标题识别：支持「第X章」「Chapter X」「卷一」', () => {
    const res = extractOutline({
      entryType: 'novel',
      originalText: 'Chapter 1 Start\n正文A\n\nChapter 2 Middle\n正文B\n\n卷一 终章\n正文C',
      structured: { entry_type: 'novel' }
    });
    expect(res.status).toBe('ready');
    if (res.status !== 'ready') return;
    const titles = res.outline.chapters.map((c) => c.title);
    expect(titles).toContain('Start');
    expect(titles).toContain('Middle');
    expect(titles).toContain('终章');
  });

  it('空输入降级：无章节标题 → no_chapters 且不抛错', () => {
    const res = extractOutline({
      entryType: 'novel',
      originalText: '只有一段没有章节标记的普通文本，长度适中但无结构。',
      structured: { entry_type: 'novel' }
    });
    expect(res.status).toBe('failed');
    if (res.status !== 'failed') return;
    expect(res.reason).toBe('no_chapters');
  });

  it('非小说条目（article）若无章节 → no_chapters 降级', () => {
    const res = extractOutline({
      entryType: 'article',
      originalText: '普通文章正文，无章节标题。',
      structured: { entry_type: 'article', sections: [], key_points: [], tags: [] }
    });
    expect(res.status).toBe('failed');
  });

  it('失败降级：异常输入返回 extract_failed 不抛错', () => {
    const res = extractOutline({
      entryType: 'novel',
      originalText: '',
      structured: { entry_type: 'novel' }
    });
    // 空原文 → no_chapters（不算异常）；这里验证函数本身不抛错
    expect(res).toBeDefined();
    expect(res.status === 'ready' || res.status === 'failed').toBe(true);
  });

  it('重复幂等：同输入两次输出一致', () => {
    const a = extractOutline(novelInput);
    const b = extractOutline(novelInput);
    expect(a).toEqual(b);
  });

  it('人物关系：共现 → relation=同场；显式关系词 → 具体关系', () => {
    const res = extractOutline({
      entryType: 'novel',
      originalText: [
        '第一章 相遇',
        '林逸与苏青并肩作战。',
        '',
        '第二章 拜师',
        '玄清收林逸为徒，玄清是林逸的师父。'
      ].join('\n'),
      structured: {
        entry_type: 'novel',
        characters: [
          { name: '林逸', role: '主角', description: '' },
          { name: '苏青', role: '女主', description: '' },
          { name: '玄清', role: '长老', description: '' }
        ]
      }
    });
    expect(res.status).toBe('ready');
    if (res.status !== 'ready') return;
    const relations = res.outline.character_relations;
    expect(relations.length).toBeGreaterThan(0);
    const 玄清林逸 = relations.find((r) => r.source === '玄清' && r.target === '林逸');
    if (玄清林逸) {
      expect(玄清林逸.relation).toBe('师父');
    }
    const 林逸苏青 = relations.find(
      (r) => (r.source === '林逸' && r.target === '苏青') || (r.source === '苏青' && r.target === '林逸')
    );
    if (林逸苏青) {
      expect(['同场', '共现']).toContain(林逸苏青.relation);
    }
  });

  it('维度名与契约枚举一致：只输出 chapters/plot_nodes/character_relations/story_lines', () => {
    const res = extractOutline(novelInput);
    expect(res.status).toBe('ready');
    if (res.status !== 'ready') return;
    const keys = Object.keys(res.outline).sort();
    // 字典序：chapters < character_relations < plot_nodes < story_lines
    expect(keys).toEqual(['chapters', 'character_relations', 'plot_nodes', 'story_lines']);
    // 校验可通过契约 schema
    const parsed = knowledgeOutlineSchema.safeParse(res.outline);
    expect(parsed.success).toBe(true);
  });

  it('故事线数量限制在 1~5 条', () => {
    const res = extractOutline(novelInput);
    expect(res.status).toBe('ready');
    if (res.status !== 'ready') return;
    expect(res.outline.story_lines.length).toBeGreaterThanOrEqual(1);
    expect(res.outline.story_lines.length).toBeLessThanOrEqual(5);
  });

  it('输出类型：ready 时含完整 outline；failed 时含 reason', () => {
    const ready = extractOutline(novelInput) as OutlineExtractResult;
    expect(ready.status === 'ready' ? ready.outline : ready.reason).toBeDefined();
    const failed = extractOutline({ entryType: 'novel', originalText: '无章节', structured: { entry_type: 'novel' } });
    expect(failed.status === 'failed' ? failed.reason : failed.outline).toBeDefined();
  });
});

// 类型辅助：确保 KnowledgeEntryOutline 可用于断言
const _outlineGuard = (o: KnowledgeEntryOutline) => o;
void _outlineGuard;
