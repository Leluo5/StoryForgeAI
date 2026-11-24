// M3c-3 知识库 T14 向量嵌入 Provider 端口
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.5
// 端口：embed(texts) → 每文本一个向量；实现可为 Mock（确定性）或真实模型（Coze/本地）
export interface KnowledgeEmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

// DI 令牌：知识库向量嵌入 Provider，注入点统一使用此常量
export const KNOWLEDGE_EMBEDDING_PROVIDER = Symbol('KNOWLEDGE_EMBEDDING_PROVIDER');
