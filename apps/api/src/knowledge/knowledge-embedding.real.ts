// M3c-3 知识库 T14 真实模型接入 · 真实嵌入 Provider（OpenAI /v1/embeddings，降级 Mock）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.5（vector(1024)、L2 归一化）
// 行为：优先 OpenAI 兼容 /v1/embeddings（dimensions=1024 对齐）；上游不可用时降级
//       Mock 特征哈希（确定性），保证灵感关联不因模型故障而阻塞入库。
import type { KnowledgeEmbeddingProvider } from './embedding.provider';
import type { KnowledgeOpenAiClient } from './knowledge-openai.client';
import { MockEmbeddingProvider, EMBEDDING_DIM } from './embedding.mock';

/** 真实嵌入 Provider 依赖：OpenAI 客户端（可能为 null，此时纯降级 Mock） */
export interface RealEmbeddingDeps {
  openai?: KnowledgeOpenAiClient | null;
  logger: { warn: (message: string) => void };
}

/** 截断/补齐到 EMBEDDING_DIM，并 L2 归一化（对齐 Mock 与 pgvector 余弦距离约定） */
function normalizeToDim(vec: number[]): number[] {
  const out = new Array<number>(EMBEDDING_DIM).fill(0);
  const n = Math.min(vec.length, EMBEDDING_DIM);
  for (let i = 0; i < n; i++) out[i] = vec[i] ?? 0;
  let normSq = 0;
  for (const x of out) normSq += x * x;
  const norm = Math.sqrt(normSq);
  if (norm === 0) return out;
  return out.map((x) => x / norm);
}

/**
 * 真实嵌入 Provider：OpenAI /v1/embeddings（1024 维）→ 降级 Mock。
 * 与 LlmEmbeddingProvider（空数组降级）不同：本实现降级为确定性 Mock，
 * 保证向量关联可用（D12/D13），仅在完全无凭据时由模块层回退 MockEmbeddingProvider。
 */
export class RealEmbeddingProvider implements KnowledgeEmbeddingProvider {
  private readonly fallback = new MockEmbeddingProvider();

  constructor(private readonly deps: RealEmbeddingDeps) {}

  async embed(texts: string[]): Promise<number[][]> {
    if (this.deps.openai) {
      try {
        const vecs = await this.deps.openai.embed(texts);
        return vecs.map((v) => normalizeToDim(v));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.logger.warn(`[knowledge-embedding] 真实嵌入失败，降级 Mock（${texts.length} 条）：${message}`);
      }
    }
    return this.fallback.embed(texts);
  }
}
