// M3c-3 知识库 T13 大纲提取器（纯函数，四维 + no_chapters 降级）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.4、契约 knowledgeOutlineSchema
//
// 边界（L2 服务层）：纯函数，不依赖 LLM / DB / 网络；从条目原文与结构化结果提取四维大纲。
// 降级规则：章节数为 0 → { status:'failed', reason:'no_chapters' } 不抛错；
//          提取过程异常 → { status:'failed', reason:'extract_failed' } 不抛错。
// 故事线：按章节主题（角色共现）聚类为 1~5 条。

import type { KnowledgeEntryOutline, KnowledgeEntryStructured, KnowledgeEntryType } from '@storyforge/contracts';

// ───────────────────────────── 章节标题识别 ─────────────────────────────
// 支持「第 X 章 / Chapter X / 卷一 / 第X回」等；捕获标题文本，无标题时用标记本身。
const CHAPTER_TITLE_RE = /^(第\s*[一二三四五六七八九十百千万0-9]+\s*[章卷节回]|Chapter\s+\d+|卷[一二三四五六七八九十])\s*[:：]?\s*(.*)$/;

// 显式人物关系词（师/父/兄/敌/盟等）：命中即作为 relation；否则兜底「同场」。
const RELATION_WORDS: string[] = [
  '师父', '师傅', '师尊', '弟子', '徒弟', '师兄', '师弟', '师姐', '师妹',
  '父亲', '母亲', '兄弟', '姐妹', '父子', '母子', '兄妹', '姐弟',
  '敌人', '仇人', '对手', '盟友', '同盟', '战友', '夫妻', '恋人', '情侣', '挚友', '好友'
];

export interface OutlineExtractInput {
  entryType: KnowledgeEntryType;
  originalText: string;
  structured: KnowledgeEntryStructured | Record<string, unknown> | null;
}

export type OutlineExtractResult =
  | { status: 'ready'; outline: KnowledgeEntryOutline }
  | { status: 'failed'; reason: 'no_chapters' | 'extract_failed' };

interface ChapterBlock {
  title: string;
  text: string;
  index: number;
}

// 按章节标题切分原文 → 章节块列表
function splitChapters(originalText: string): ChapterBlock[] {
  const lines = originalText.split('\n');
  const chapters: ChapterBlock[] = [];
  let current: ChapterBlock | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (current) {
      current.text = currentLines.join('\n').trim();
      chapters.push(current);
    }
    currentLines = [];
  };

  for (const line of lines) {
    const m = line.trim().match(CHAPTER_TITLE_RE);
    if (m) {
      flush();
      const title = (m[2] ?? '').trim() || m[1]!.trim();
      current = { title, text: '', index: chapters.length };
    } else if (current) {
      currentLines.push(line);
    }
  }
  flush();
  return chapters;
}

// 章节正文摘要（情节节点 summary 上限 200 字）
function summarizeText(text: string, max = 200): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max)}…` : normalized;
}

// 从结构化结果取人物
function extractCharacters(structured: Record<string, unknown> | null): Array<{ name: string; role: string; description: string }> {
  if (!structured || !Array.isArray(structured.characters)) return [];
  return (structured.characters as Array<{ name?: string; role?: string; description?: string }>)
    .filter((c) => c && typeof c.name === 'string' && c.name.trim())
    .map((c) => ({
      name: c.name!.trim(),
      role: (c.role ?? '').trim(),
      description: (c.description ?? '').trim()
    }));
}

// 生成人物关系：显式关系词优先，共现兜底「同场」
function extractRelations(chapters: ChapterBlock[], characters: Array<{ name: string; role: string; description: string }>): Array<{ source: string; target: string; relation: string }> {
  const relations: Array<{ source: string; target: string; relation: string }> = [];
  const seen = new Set<string>();

  for (let i = 0; i < characters.length; i++) {
    for (let j = i + 1; j < characters.length; j++) {
      const a = characters[i]!;
      const b = characters[j]!;
      const key = [a.name, b.name].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);

      // 检测共现文本（含显式关系词）
      const coText = chapters
        .map((c) => c.text)
        .filter((t) => t.includes(a.name) && t.includes(b.name))
        .join('\n');

      let relation = '同场';
      for (const word of RELATION_WORDS) {
        // 关系词需同时涉及两人文本附近：简单启发式——两角色名共现于同一章节，且该章节含关系词
        const hit = chapters.some((c) => c.text.includes(a.name) && c.text.includes(b.name) && c.text.includes(word));
        if (hit) {
          relation = word;
          break;
        }
      }
      relations.push({ source: a.name, target: b.name, relation });
    }
  }
  return relations;
}

// 故事线：按章节主要角色聚类，聚类数限制 1~5
function extractStoryLines(chapters: ChapterBlock[], characters: Array<{ name: string; role: string; description: string }>): Array<{ name: string; description: string; chapter_indexes: number[] }> {
  if (chapters.length === 0) return [];

  const charNames = characters.map((c) => c.name);
  const lines: Array<{ name: string; description: string; chapter_indexes: number[] }> = [];

  // 主题：每章节出现的主要角色
  for (let idx = 0; idx < chapters.length; idx++) {
    const text = chapters[idx]!.text;
    const present = charNames.filter((n) => text.includes(n));
    const themeName = present.length > 0 ? present[0]! : `主线${Math.min(idx + 1, 5)}`;

    // 合并到已有线或新建
    let line = lines.find((l) => l.name === themeName);
    if (!line) {
      if (lines.length >= 5) {
        // 超 5 条：并入最后一条
        line = lines[lines.length - 1]!;
      } else {
        line = { name: themeName, description: `围绕「${themeName}」展开的故事线`, chapter_indexes: [] };
        lines.push(line);
      }
    }
    line.chapter_indexes.push(idx);
  }

  // 描述补充：取首章节摘要
  for (const line of lines) {
    const firstIdx = line.chapter_indexes[0]!;
    line.description = `围绕「${line.name}」展开，起于第${firstIdx + 1}章：${summarizeText(chapters[firstIdx]!.text, 60)}`;
  }
  return lines;
}

export function extractOutline(input: OutlineExtractInput): OutlineExtractResult {
  try {
    const chapters = splitChapters(input.originalText ?? '');
    // 章节数为 0 → no_chapters 降级（不抛错）
    if (chapters.length === 0) {
      return { status: 'failed', reason: 'no_chapters' };
    }

    const characters = extractCharacters(input.structured as Record<string, unknown> | null);
    const structured = input.structured as Record<string, unknown> | null;

    const outline: KnowledgeEntryOutline = {
      chapters: chapters.map((c) => ({
        title: c.title,
        summary: summarizeText(c.text)
      })),
      plot_nodes: chapters.map((c) => ({
        title: c.title,
        summary: summarizeText(c.text),
        chapter_index: c.index
      })),
      character_relations: extractRelations(chapters, characters),
      story_lines: extractStoryLines(chapters, characters)
    };

    return { status: 'ready', outline };
  } catch {
    return { status: 'failed', reason: 'extract_failed' };
  }
}
