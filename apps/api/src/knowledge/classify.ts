// M3c-3 知识库 T09 类型识别（纯函数）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.2
// 信号表：论文（文件名/摘要关键词参考文献）→ 小说（章节/对话比例）→ 灵感（短文本/灵感标记）→ 文章（默认）。
// 设定集永不自动识别，仅能由调用方手动指定（manualType）。

import type { KnowledgeEntryType } from '@storyforge/contracts';

export interface ClassifyInput {
  title?: string;
  fileName?: string;
  rawContent: string;
  /** 作者手动指定的类型（setting 的唯一来源）；存在时跳过启发式 */
  manualType?: KnowledgeEntryType;
}

export interface ClassifyResult {
  type: KnowledgeEntryType;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  warnings: string[];
}

const PAPER_FILENAME = /论文|paper|abstract/i;
const PAPER_BODY_MARKERS = ['摘要', '关键词', '参考文献'];
const NOVEL_CHAPTER = /第\s*[一二三四五六七八九十百千万0-9]+\s*[章节]|\bChapter\s+\d+\b/gi;
const INSPIRATION_MARKERS = ['灵感', '想法', '突然想到'];
const DIALOGUE_QUOTES = /[“”"「」]/g;

function countMatches(text: string, regex: RegExp): number {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function hasMarkerCount(text: string, markers: string[], threshold: number): boolean {
  return markers.filter((marker) => text.includes(marker)).length >= threshold;
}

function dialogueQuoteRatio(text: string): number {
  if (text.length === 0) return 0;
  const quotes = text.match(DIALOGUE_QUOTES);
  return quotes ? quotes.length / text.length : 0;
}

/**
 * 启发式条目类型识别。
 * 优先级：手动指定 > 论文 > 小说 > 灵感 > 文章（默认）。
 */
export function classifyEntryType(input: ClassifyInput): ClassifyResult {
  const { fileName, rawContent, manualType } = input;
  const reasons: string[] = [];
  const warnings: string[] = [];

  // 手动指定优先（setting 仅能由此进入）
  if (manualType) {
    return { type: manualType, confidence: 'high', reasons: ['手动指定'], warnings: [] };
  }

  const content = rawContent ?? '';
  const normalizedFileName = (fileName ?? '').toLowerCase();

  // 论文：文件名含 论文/paper/abstract，或正文含 ≥2 个 摘要/关键词/参考文献
  if (PAPER_FILENAME.test(normalizedFileName)) {
    reasons.push('文件名含论文/paper/abstract');
  } else if (hasMarkerCount(content, PAPER_BODY_MARKERS, 2)) {
    reasons.push('正文含摘要/关键词/参考文献≥2');
  }
  if (reasons.some((r) => r.startsWith('文件名含') || r.startsWith('正文含摘要'))) {
    return { type: 'paper', confidence: 'high', reasons, warnings };
  }

  // 小说：章节标记 ≥2，或对话引号比例高且长度 >5000
  const chapterCount = countMatches(content, NOVEL_CHAPTER);
  const isLong = content.length > 5000;
  const highDialogue = dialogueQuoteRatio(content) > 0.05;
  if (chapterCount >= 2) {
    reasons.push(`章节标记≥2（${chapterCount}处）`);
    return { type: 'novel', confidence: 'high', reasons, warnings };
  }
  if (isLong && highDialogue) {
    reasons.push('对话引号比例高且长度>5000');
    return { type: 'novel', confidence: 'high', reasons, warnings };
  }

  // 灵感：长度 <800 且含灵感标记，或仅一段短文本（无空行）
  const isShort = content.length < 800;
  const hasInspirationMarker = INSPIRATION_MARKERS.some((m) => content.includes(m));
  const singleShortParagraph = isShort && !content.includes('\n\n');
  if (isShort && hasInspirationMarker) {
    reasons.push('短文本且含灵感/想法/突然想到');
    return { type: 'inspiration', confidence: 'high', reasons, warnings };
  }
  if (singleShortParagraph && content.trim().length > 0) {
    reasons.push('仅一段短文本');
    return { type: 'inspiration', confidence: 'medium', reasons, warnings };
  }

  // 默认文章：无强信号，置信度低并提示不确定
  reasons.push('无信号，默认文章');
  warnings.push('KNOWLEDGE_TYPE_UNCERTAIN');
  return { type: 'article', confidence: 'low', reasons, warnings };
}
