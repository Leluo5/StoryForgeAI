import { Injectable } from '@nestjs/common';
import type { KnowledgeEntryStructured, KnowledgeEntryType } from '@storyforge/contracts';

// ============================================================================
// M3c-3 知识库 · T10 分块与结构化合并（F2 §5.3 步骤 2-4）
//
// 本文件定义：
//   - `chunkText`：原始文本按段落 / 标题层级 / 章节切分为块（纯函数，确定性）
//   - `mergeStructured`：多个块的结构化结果合并去重（纯函数，确定性）
//   - `KnowledgeStructureProvider`：端口接口（真实模型实现由 structure.llm.ts 提供）
//   - `MockKnowledgeStructureProvider`：确定性 Mock 实现
//
// 算法依据 F2 §5.3：
//   步骤2 分块：单块 ≤6000 字符，相邻重叠 200 字符；小说按章节标题优先切分。
//   步骤4 合并：分段按顺序拼接并去重标题；核心观点按文本归一化去重；
//              标签取并集并限制 ≤20；论文五要素按块合并取信息量最大者；
//              小说角色按名称合并。
// ============================================================================

/** 分块参数（与 F2 §5.3 一致） */
export const STRUCTURE_CHUNK_MAX = 6000;
export const STRUCTURE_CHUNK_OVERLAP = 200;
/** 单次作业最大处理字符数（F2 §5.3 末段） */
export const STRUCTURE_MAX_INPUT_CHARS = 8_000_000;

/** 结构化管线输入：条目原文 + 上下文 */
export interface StructureInput {
  entryId: string;
  rawContent: string;
  entryType: KnowledgeEntryType;
  title?: string;
  /** 已有关联条目文本（供灵感补充上下文） */
  relatedContexts?: string[];
}

/** 分块结果：文本 + 类型 + 顺序 + 结构化输出 */
export interface StructureBlock {
  text: string;
  type: KnowledgeEntryType;
  order: number;
  /** 该块经结构化产生的局部结构（真实实现注入） */
  structured: KnowledgeEntryStructured;
  /** novel 章节标题块标记（合并阶段用于章节边界） */
  chapterBoundary?: boolean;
}

/** 结构化管线输出：合并后的结构化结果 + 块数 */
export interface StructuredResult {
  structured: KnowledgeEntryStructured;
  blockCount: number;
  /** 合并过程中的警告（如标签超限截断） */
  warnings: string[];
}

/**
 * 端口：结构化 Provider。
 * `structure(entry)` 返回合并后的结构化结果；异常向上抛业务错误码。
 */
export interface KnowledgeStructureProvider {
  structure(entry: StructureInput): Promise<StructuredResult>;
}

export const KNOWLEDGE_STRUCTURE_PROVIDER = Symbol('KNOWLEDGE_STRUCTURE_PROVIDER');

// ───────────────────────────── 分块纯函数 ─────────────────────────────

/** 标题层级检测：`#`~`###` 开头 */
const HEADING_RE = /^(#{1,3})\s+(.+)$/;
/** 小说章节标题：第 X 章 / Chapter X / 卷一 */
const NOVEL_CHAPTER_RE = /^(第\s*[一二三四五六七八九十百千万0-9]+\s*[章节]|Chapter\s+\d+|卷一|卷[一二三四五六七八九十]+)\b/i;

/**
 * 按空行 / 标题 / 章节切分原始文本为块（确定性纯函数）。
 *
 * 依据 F2 §5.3 步骤2：按空行/段落切分，单块 ≤6000 字符，相邻块重叠 200 字符；
 * 小说按章节标题优先切分。每个段落独立成块（超长段落由 splitLongText 再切），
 * 这样合并去重（mergeStructured）保留原文顺序且不丢失内容。
 */
export function chunkText(rawContent: string, input: StructureInput): StructureBlock[] {
  if (!rawContent) return [];

  const isNovel = input.entryType === 'novel';
  const paragraphs = splitParagraphs(rawContent);

  const blocks: StructureBlock[] = [];
  let order = 0;
  for (const para of paragraphs) {
    const trimmed = para.trim();
    // novel 章节标题作为独立块边界（F2 §5.3 步骤2）
    const isChapterBoundary = isNovel && NOVEL_CHAPTER_RE.test(trimmed);
    const pieces = splitLongText(trimmed);
    for (const piece of pieces) {
      blocks.push({
        text: piece,
        type: input.entryType,
        order: order++,
        // 标记是否为章节边界块（供合并阶段参考）
        structured: emptyStructured(input.entryType),
        chapterBoundary: isChapterBoundary
      });
    }
  }
  return blocks;
}

/** 按空行分段 */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** 超长文本按 STRUCTURE_CHUNK_MAX 切分，相邻重叠 STRUCTURE_CHUNK_OVERLAP */
function splitLongText(text: string): string[] {
  if (text.length <= STRUCTURE_CHUNK_MAX) return [text];
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + STRUCTURE_CHUNK_MAX, text.length);
    pieces.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - STRUCTURE_CHUNK_OVERLAP;
  }
  return pieces;
}

// ───────────────────────────── 合并纯函数 ─────────────────────────────

/** 生成指定类型的空结构化结果 */
export function emptyStructured(type: KnowledgeEntryType): KnowledgeEntryStructured {
  switch (type) {
    case 'paper':
      return { entry_type: 'paper', research_question: '', method: '', findings: '', contributions: '', limitations: '', keywords: [] };
    case 'novel':
      return { entry_type: 'novel', characters: [], plot_summary: '', narrative_style: '', worldview: '' };
    case 'inspiration':
      return { entry_type: 'inspiration', completion: '', matched_entry_ids: [], independent: false };
    case 'setting':
      return { entry_type: 'setting', sections: [], key_points: [], tags: [] };
    case 'article':
    default:
      return { entry_type: 'article', sections: [], key_points: [], tags: [] };
  }
}

/** 文本归一化（去空白、去标点、小写）用于去重比较 */
function normalizeText(s: string): string {
  return s.replace(/\s+/g, '').replace(/[，。！？；：、,.!?;:()（）"'“”]/g, '').toLowerCase();
}

/** 判断字符串信息量（长度作为信息量代理） */
function infoScore(s: string): number {
  return s.length;
}

/** 合并多个块的结构化结果（确定性纯函数，保留原文顺序） */
export function mergeStructured(blocks: StructureBlock[], input: StructureInput): StructuredResult {
  const warnings: string[] = [];
  const type = input.entryType;

  switch (type) {
    case 'paper':
      return mergePaper(blocks, warnings);
    case 'novel':
      return mergeNovel(blocks, warnings);
    case 'inspiration':
      return mergeInspiration(blocks, warnings);
    case 'setting':
      return mergeArticleLike(blocks, 'setting', warnings);
    case 'article':
    default:
      return mergeArticleLike(blocks, 'article', warnings);
  }
}

/** 合并文章 / 设定集（sections + key_points + tags） */
function mergeArticleLike(blocks: StructureBlock[], type: 'article' | 'setting', warnings: string[]): StructuredResult {
  const sections: { heading: string; content: string }[] = [];
  const keyPoints: string[] = [];
  const tags: string[] = [];

  const seenSections = new Set<string>();
  const seenKeyPoints = new Set<string>();
  const seenTags = new Set<string>();

  for (const block of blocks) {
    const s = block.structured;
    if (s.entry_type !== type) continue;
    for (const sec of (s as { sections?: { heading: string; content: string }[] }).sections ?? []) {
      const key = normalizeText(sec.heading);
      if (seenSections.has(key)) continue;
      seenSections.add(key);
      sections.push(sec);
    }
    for (const kp of (s as { key_points?: string[] }).key_points ?? []) {
      const key = normalizeText(kp);
      if (seenKeyPoints.has(key)) continue;
      seenKeyPoints.add(key);
      keyPoints.push(kp);
    }
    for (const tag of (s as { tags?: string[] }).tags ?? []) {
      const key = normalizeText(tag);
      if (seenTags.has(key)) continue;
      seenTags.add(key);
      tags.push(tag);
    }
  }

  // 标签并集限制 ≤20
  if (tags.length > 20) {
    warnings.push('TAGS_TRUNCATED');
    tags.length = 20;
  }

  return {
    structured: { entry_type: type, sections, key_points: keyPoints, tags },
    blockCount: blocks.length,
    warnings
  };
}

/** 合并论文（五要素取信息量最大者 + keywords 去重） */
function mergePaper(blocks: StructureBlock[], warnings: string[]): StructuredResult {
  let researchQuestion = '';
  let method = '';
  let findings = '';
  let contributions = '';
  let limitations = '';
  const keywords: string[] = [];
  const seenKeywords = new Set<string>();

  for (const block of blocks) {
    const s = block.structured;
    if (s.entry_type !== 'paper') continue;
    const p = s as { research_question: string; method: string; findings: string; contributions: string; limitations: string; keywords?: string[] };
    if (infoScore(p.research_question) > infoScore(researchQuestion)) researchQuestion = p.research_question;
    if (infoScore(p.method) > infoScore(method)) method = p.method;
    if (infoScore(p.findings) > infoScore(findings)) findings = p.findings;
    if (infoScore(p.contributions) > infoScore(contributions)) contributions = p.contributions;
    if (infoScore(p.limitations) > infoScore(limitations)) limitations = p.limitations;
    for (const kw of p.keywords ?? []) {
      const key = normalizeText(kw);
      if (seenKeywords.has(key)) continue;
      seenKeywords.add(key);
      keywords.push(kw);
    }
  }

  if (keywords.length > 20) {
    warnings.push('KEYWORDS_TRUNCATED');
    keywords.length = 20;
  }

  return {
    structured: {
      entry_type: 'paper',
      research_question: researchQuestion,
      method,
      findings,
      contributions,
      limitations,
      keywords
    },
    blockCount: blocks.length,
    warnings
  };
}

/** 合并小说（角色按名称合并 + 情节/叙事/世界观取信息量最大） */
function mergeNovel(blocks: StructureBlock[], warnings: string[]): StructuredResult {
  const characters: { name: string; role: string; description: string }[] = [];
  const seenChars = new Map<string, number>();
  let plotSummary = '';
  let narrativeStyle = '';
  let worldview = '';

  for (const block of blocks) {
    const s = block.structured;
    if (s.entry_type !== 'novel') continue;
    const n = s as {
      characters?: { name: string; role: string; description: string }[];
      plot_summary: string;
      narrative_style: string;
      worldview: string;
    };
    for (const ch of n.characters ?? []) {
      const key = normalizeText(ch.name);
      if (seenChars.has(key)) {
        // 已有角色：补充更详细描述 / 角色
        const idx = seenChars.get(key)!;
        const existing = characters[idx];
        if (!existing) continue;
        if (ch.description.length > existing.description.length) existing.description = ch.description;
        if (!existing.role && ch.role) existing.role = ch.role;
      } else {
        seenChars.set(key, characters.length);
        characters.push({ ...ch });
      }
    }
    if (infoScore(n.plot_summary) > infoScore(plotSummary)) plotSummary = n.plot_summary;
    if (infoScore(n.narrative_style) > infoScore(narrativeStyle)) narrativeStyle = n.narrative_style;
    if (infoScore(n.worldview) > infoScore(worldview)) worldview = n.worldview;
  }

  return {
    structured: {
      entry_type: 'novel',
      characters,
      plot_summary: plotSummary,
      narrative_style: narrativeStyle,
      worldview
    },
    blockCount: blocks.length,
    warnings
  };
}

/** 合并灵感（completion 取信息量最大 + matched_entry_ids 去重） */
function mergeInspiration(blocks: StructureBlock[], warnings: string[]): StructuredResult {
  let completion = '';
  let independent = false;
  const matched: string[] = [];
  const seen = new Set<string>();

  for (const block of blocks) {
    const s = block.structured;
    if (s.entry_type !== 'inspiration') continue;
    const ins = s as { completion: string; matched_entry_ids?: string[]; independent?: boolean };
    if (infoScore(ins.completion) > infoScore(completion)) completion = ins.completion;
    for (const id of ins.matched_entry_ids ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      matched.push(id);
    }
    independent = independent || ins.independent === true;
  }

  return {
    structured: { entry_type: 'inspiration', completion, matched_entry_ids: matched.slice(0, 3), independent },
    blockCount: blocks.length,
    warnings
  };
}

// ───────────────────────────── Mock 实现（确定性） ─────────────────────────────

/**
 * Mock 结构化 Provider：确定性输出，不依赖外部 LLM。
 * 用于打通闭环（录入 → 识别 → 结构化可走通），结果可编辑确认入库。
 * M3b 接入真实模型时替换为 structure.llm.ts 实现，不改知识库业务逻辑。
 */
@Injectable()
export class MockKnowledgeStructureProvider implements KnowledgeStructureProvider {
  async structure(entry: StructureInput): Promise<StructuredResult> {
    // 分块（确定性）
    const blocks = chunkText(entry.rawContent, entry);
    if (blocks.length === 0) {
      return { structured: emptyStructured(entry.entryType), blockCount: 0, warnings: [] };
    }

    // 每块生成确定性局部结构（Mock：以块文本为原料，不调用外部模型）
    for (const block of blocks) {
      block.structured = this.structureBlock(block, entry);
    }

    // 合并（确定性）
    return mergeStructured(blocks, entry);
  }

  /** Mock 单块结构化：按类型生成确定性局部结构 */
  private structureBlock(block: StructureBlock, entry: StructureInput): KnowledgeEntryStructured {
    const text = block.text.trim();
    switch (entry.entryType) {
      case 'paper':
        return {
          entry_type: 'paper',
          research_question: text.slice(0, 80),
          method: '',
          findings: text.slice(0, 80),
          contributions: '',
          limitations: '',
          keywords: []
        };
      case 'novel':
        return {
          entry_type: 'novel',
          characters: [],
          plot_summary: text.slice(0, 60),
          narrative_style: entry.title ?? '',
          worldview: ''
        };
      case 'inspiration':
        return {
          entry_type: 'inspiration',
          completion: text,
          matched_entry_ids: [],
          independent: true
        };
      case 'setting':
        return {
          entry_type: 'setting',
          sections: [{ heading: entry.title ?? '设定', content: text.slice(0, 200) }],
          key_points: text.slice(0, 40) ? [text.slice(0, 40)] : [],
          tags: []
        };
      case 'article':
      default:
        return {
          entry_type: 'article',
          sections: [{ heading: entry.title ?? '正文', content: text.slice(0, 200) }],
          key_points: text.slice(0, 40) ? [text.slice(0, 40)] : [],
          tags: []
        };
    }
  }
}
