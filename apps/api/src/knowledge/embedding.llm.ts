// M3c-3 知识库 T14 真实模型嵌入 Provider（LLM/Coze 实现）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.5
// 行为：包装底层 Provider；模型不可用时降级返回空数组并记日志，不抛错、不阻塞入库
import type { KnowledgeEmbeddingProvider } from './embedding.provider';

export interface LlmEmbeddingProviderOptions {
  logger: { warn: (message: string) => void };
}

export class LlmEmbeddingProvider implements KnowledgeEmbeddingProvider {
  constructor(
    private readonly inner: KnowledgeEmbeddingProvider,
    private readonly options: LlmEmbeddingProviderOptions
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    try {
      return await this.inner.embed(texts);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.options.logger.warn(`[knowledge-embedding] 模型不可用，返回空向量（${texts.length} 条）：${message}`);
      return [];
    }
  }
}
