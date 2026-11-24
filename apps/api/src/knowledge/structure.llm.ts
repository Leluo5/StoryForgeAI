import { Injectable } from '@nestjs/common';
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
  type KnowledgeStructureProvider,
  type StructureBlock,
  type StructureInput,
  type StructuredResult
} from './structure.provider';
import type { KnowledgeLlmProvider, KnowledgeLlmContext } from './knowledge-llm.provider';

/**
 * 真实结构化 Provider（M3b 接入 Coze / 真实模型时启用）。
 *
 * 复用旧一代 `KnowledgeLlmProvider` 端口（detectType / parseArticle / parsePaper /
 * parseNovel / parseInspiration / enrichInspiration）：
 *  - 按 entryType 调用对应 parse 方法生成局部结构；
 *  - 逐块结构化，失败块降级为 `event` 兜底（保留原文文本）并记录警告；
 *  - 单次作业超出 F2 §5.3 的 8,000,000 字符上限返回业务错误。
 *
 * 旧 parser 返回旧四类结构（ArticleStructured 等），本文件通过 `adaptToContract`
 * 映射为契约五类结构（F2 §5.2 五类枚举），保持旧一代可编译。
 */
@Injectable()
export class LlmKnowledgeStructureProvider implements KnowledgeStructureProvider {
  constructor(private readonly llm: KnowledgeLlmProvider) {}

  async structure(entry: StructureInput): Promise<StructuredResult> {
    // F2 §5.3：单次作业最多 8,000,000 字符，超出返回业务错误
    if (entry.rawContent.length > 8_000_000) {
      throw new Error('KNOWLEDGE_TEXT_TOO_LARGE');
    }

    const blocks = chunkText(entry.rawContent, entry);
    if (blocks.length === 0) {
      return { structured: emptyFor(entry.entryType), blockCount: 0, warnings: [] };
    }

    const warnings: string[] = [];
    const baseContext: KnowledgeLlmContext = {
      rawContent: entry.rawContent,
      title: entry.title ?? '',
      source: entry.entryType,
      relatedContexts: entry.relatedContexts ?? []
    };

    // 逐块结构化：失败块降级为 event 兜底，不中断整体
    for (const block of blocks) {
      try {
        block.structured = await this.parseBlock(block, baseContext);
      } catch (err) {
        warnings.push(`BLOCK_STRUCTURE_FAILED:${block.order}`);
        block.structured = emptyFor(entry.entryType);
      }
    }

    const merged = mergeStructured(blocks, entry);
    return { ...merged, warnings: [...warnings, ...merged.warnings] };
  }

  /** 按 entryType 调用对应 parse 方法生成局部结构并适配到契约五类 */
  private async parseBlock(block: StructureBlock, baseContext: KnowledgeLlmContext): Promise<KnowledgeEntryStructured> {
    const ctx: KnowledgeLlmContext = { ...baseContext, rawContent: block.text };
    switch (block.type) {
      case 'paper':
        return adaptPaper(await this.llm.parsePaper(ctx));
      case 'novel':
        return adaptNovel(await this.llm.parseNovel(ctx));
      case 'inspiration':
        return adaptInspiration(await this.llm.parseInspiration(ctx));
      case 'article':
      default:
        return adaptArticle(await this.llm.parseArticle(ctx));
    }
  }
}

// ───────────────────────────── 旧结构 → 契约结构适配 ─────────────────────────────

/** 旧 ArticleStructured { paragraphs, key_points, summary, tag_list } → 契约 article */
function adaptArticle(s: ArticleStructured): KnowledgeEntryStructured {
  return {
    entry_type: 'article',
    sections: s.paragraphs.map((p, i) => ({ heading: i === 0 && s.summary ? '摘要' : `段落${i + 1}`, content: p })),
    key_points: s.key_points,
    tags: s.tag_list
  };
}

/** 旧 PaperStructured → 契约 paper（research_method→method, core_conclusion→findings, design_insight→contributions） */
function adaptPaper(s: PaperStructured): KnowledgeEntryStructured {
  return {
    entry_type: 'paper',
    research_question: s.research_question,
    method: s.research_method,
    findings: s.core_conclusion,
    contributions: s.design_insight,
    limitations: s.limitation,
    keywords: []
  };
}

/** 旧 NovelStructured { characters, plot_lines, narrative_style, world_setting } → 契约 novel */
function adaptNovel(s: NovelStructured): KnowledgeEntryStructured {
  return {
    entry_type: 'novel',
    characters: s.characters.map((c) => ({ name: c, role: '', description: '' })),
    plot_summary: Array.isArray(s.plot_lines) ? s.plot_lines.join('\n') : String(s.plot_lines ?? ''),
    narrative_style: Array.isArray(s.narrative_style) ? s.narrative_style.join('\n') : String(s.narrative_style ?? ''),
    worldview: s.world_setting
  };
}

/** 旧 InspirationStructured { raw_text, enriched_text, related_ids } → 契约 inspiration */
function adaptInspiration(s: InspirationStructured): KnowledgeEntryStructured {
  return {
    entry_type: 'inspiration',
    completion: s.enriched_text || s.raw_text,
    matched_entry_ids: s.related_ids,
    independent: true
  };
}

/** 生成指定类型的空结构化结果 */
function emptyFor(type: KnowledgeEntryType): KnowledgeEntryStructured {
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
