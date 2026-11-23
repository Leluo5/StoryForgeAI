import { Inject, Injectable } from '@nestjs/common';
import type { KnowledgeType } from '@storyforge/contracts';
import { KNOWLEDGE_LLM_PROVIDER, type KnowledgeLlmProvider } from './knowledge-llm.provider';

// linkInspiration 只依赖条目的 id + raw_content（检索列表项已含 id，raw_content 可为空）
type LinkableEntry = { id: string; raw_content?: string };

/** 无嵌入服务时用 TF-IDF + 余弦兜底（对齐旧 F5 §4.4） */

export function tokenize(text: string): string[] {
  // 中文按字 + 英文按词，去停用词/空白
  const lower = text.toLowerCase();
  const words = lower.match(/[a-z0-9]+/g) ?? [];
  const chars = lower.match(/[\u4e00-\u9fa5]/g) ?? [];
  return [...words, ...chars].filter((t) => t.length > 0);
}

export function tfidfSimilarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const setA = new Set(ta);
  const setB = new Set(tb);
  // 交集 / 并集的 Jaccard 变体（轻量相似度）
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

const TOP_N = 3;
const SIM_THRESHOLD = 0.15;

@Injectable()
export class KnowledgeLinkerService {
  constructor(@Inject(KNOWLEDGE_LLM_PROVIDER) private readonly llm: KnowledgeLlmProvider) {}

  /**
   * 灵感自动关联：在已有条目中检索相似度，前 TOP_N 建立关联；
   * 基于已有知识上下文补充灵感。返回 { related_ids, enriched_text }。
   */
  async linkInspiration(
    rawContent: string,
    existingEntries: LinkableEntry[]
  ): Promise<{ related_ids: string[]; enriched_text: string }> {
    // TF-IDF 相似度兜底
    const scored = existingEntries
      .map((entry) => ({ id: entry.id, score: tfidfSimilarity(rawContent, entry.raw_content ?? '') }))
      .filter((s) => s.score >= SIM_THRESHOLD)
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_N);
    const relatedIds = scored.map((s) => s.id);

    // 基于已有知识上下文补充完善灵感（Mock 保持原文；真实实现走 LLM）
    const relatedContexts = relatedIds
      .map((id) => existingEntries.find((e) => e.id === id)?.raw_content ?? '')
      .filter(Boolean);
    const enriched = await this.llm.enrichInspiration({
      rawContent,
      source: 'inspiration',
      relatedContexts
    });
    return { related_ids: relatedIds, enriched_text: enriched.enriched_text };
  }
}
