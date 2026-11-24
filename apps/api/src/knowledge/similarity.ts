// M3c-3 知识库 T14 向量相似度纯函数
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.5
// 算法：余弦相似度；findSimilar 候选按相似度降序取前 topK → 过滤阈值 → 取前 maxResults

// 库内候选记录：供相似度检索的最小字段（与 knowledge_entry_embeddings 行对应）
export interface EmbeddingRecord {
  entry_id: string;
  embedding: number[];
  library_scope: 'global' | 'work';
  work_id: string | null;
  owner_id: string;
  deleted_at: Date | null;
}

export interface SimilarityCandidate {
  entry_id: string;
  embedding: number[];
}

export interface SimilarityResult {
  entry_id: string;
  score: number;
  reason: 'inspiration_auto';
}

export interface FindSimilarOptions {
  topK: number;
  threshold: number;
  maxResults: number;
}

// 余弦相似度：零向量或维度不匹配返回 0（避免除零），不抛错
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// 灵感相似度召回：topK 候选 → 阈值过滤 → 取前 maxResults，score 保留 4 位小数
// 无向量 / 空候选 / 零向量查询一律返回空数组，不抛错（降级不阻塞入库）
export function findSimilar(
  query: number[],
  candidates: EmbeddingRecord[],
  options: FindSimilarOptions
): SimilarityResult[] {
  const { topK, threshold, maxResults } = options;
  if (query.length === 0 || candidates.length === 0) return [];
  const hasNonZero = query.some((x) => x !== 0);
  if (!hasNonZero) return [];

  const scored = candidates
    .map((c) => ({ entry_id: c.entry_id, score: cosineSimilarity(query, c.embedding) }))
    .sort((a, b) => b.score - a.score);

  return scored
    .slice(0, topK)
    .filter((s) => s.score >= threshold)
    .slice(0, maxResults)
    .map((s) => ({
      entry_id: s.entry_id,
      score: Number(s.score.toFixed(4)),
      reason: 'inspiration_auto' as const
    }));
}
