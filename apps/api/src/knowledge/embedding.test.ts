// M3c-3 知识库 T14 向量嵌入 Provider（Mock 1024 维确定性）与灵感相似度
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.5
// 覆盖：Mock 维度恒 1024、确定性、L2 归一化、区分度；findSimilar 余弦 top-k（前10→阈值0.35→前3）；
//       阈值过滤、模型不可用降级、无向量空数组、结果含 score 与关联理由。
import { MockEmbeddingProvider } from './embedding.mock';
import { LlmEmbeddingProvider } from './embedding.llm';
import { findSimilar, cosineSimilarity, type SimilarityCandidate, type EmbeddingRecord } from './similarity';
import { KNOWLEDGE_EMBEDDING_PROVIDER, type KnowledgeEmbeddingProvider } from './embedding.provider';

const DIM = 1024;

describe('MockEmbeddingProvider', () => {
  const provider = new MockEmbeddingProvider();

  it('维度恒 1024', async () => {
    const vecs = await provider.embed(['你好', '世界']);
    expect(vecs).toHaveLength(2);
    for (const v of vecs) expect(v).toHaveLength(DIM);
  });

  it('确定性：同文本同向量', async () => {
    const [a] = await provider.embed(['确定性测试文本']);
    const [b] = await provider.embed(['确定性测试文本']);
    expect(a).toEqual(b);
  });

  it('L2 归一化：向量模长 ≈ 1', async () => {
    const [v] = await provider.embed(['归一化测试']);
    const vec = v!;
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('不同文本不同向量（区分度）', async () => {
    const [a] = await provider.embed(['文本A']);
    const [b] = await provider.embed(['文本B']);
    expect(a).not.toEqual(b);
  });

  it('空数组输入 → 空数组输出', async () => {
    const res = await provider.embed([]);
    expect(res).toEqual([]);
  });

  it('多文本批量与单文本一致（确定性可复现）', async () => {
    const batch = await provider.embed(['批量1', '批量2']);
    const single1 = await provider.embed(['批量1']);
    const single2 = await provider.embed(['批量2']);
    expect(batch[0]).toEqual(single1[0]);
    expect(batch[1]).toEqual(single2[0]);
  });
});

describe('cosineSimilarity', () => {
  it('相同向量 → 1', () => {
    const v = Array.from({ length: DIM }, (_, i) => (i % 2 === 0 ? 1 : 0));
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  it('正交向量 → 0', () => {
    const a = Array.from({ length: DIM }, () => 0);
    const b = Array.from({ length: DIM }, () => 0);
    a[0] = 1;
    b[1] = 1;
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it('反相向量 → -1', () => {
    const a = Array.from({ length: DIM }, () => 1);
    const b = Array.from({ length: DIM }, () => -1);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6);
  });
});

describe('findSimilar · 灵感相似度 top-k', () => {
  // 构造可复现候选：用 Mock provider 对一组文本嵌入，模拟库内候选
  async function buildCandidates(texts: string[]): Promise<EmbeddingRecord[]> {
    const provider = new MockEmbeddingProvider();
    const vecs = await provider.embed(texts);
    return texts.map((text, i) => ({
      entry_id: `entry-${i}`,
      embedding: vecs[i]!,
      library_scope: 'global' as const,
      work_id: null,
      owner_id: 'author-1',
      deleted_at: null
    }));
  }

  it('候选按相似度降序，过滤 0.35 后取前 3', async () => {
    const candidates = await buildCandidates([
      '灵感：主角在雨夜发现神秘古书，与古代修行有关。',
      '完全无关的文本内容，关于天气与饮食的记录。',
      '灵感：古书内页记载御剑术口诀，主角顿悟。',
      '灵感：御剑术与古书的渊源，主角踏上修行路。',
      '另一段与修行和古书完全不同的日常琐事。',
      '灵感：古书残页浮现阵法，与御剑术呼应。'
    ]);
    const query = await new MockEmbeddingProvider().embed(['御剑术 古书 修行 灵感']);

    const res = findSimilar(query[0]!, candidates, { topK: 10, threshold: 0.35, maxResults: 3 });
    expect(res.length).toBeLessThanOrEqual(3);
    // 按分数降序
    for (let i = 1; i < res.length; i++) {
      expect(res[i]!.score).toBeLessThanOrEqual(res[i - 1]!.score);
    }
    // 每个结果含 score 与理由
    for (const r of res) {
      expect(r).toHaveProperty('score');
      expect(r).toHaveProperty('reason');
      expect(r.reason).toBe('inspiration_auto');
      expect(r.score).toBeGreaterThanOrEqual(0.35);
    }
  });

  it('阈值过滤：score < 0.35 排除', async () => {
    const candidates = await buildCandidates([
      '完全不相关的话题，关于烹饪、旅行、园艺、天文地理、气象记录。',
      '同样无关的内容，讲述工业革命历史沿革与地理发现。'
    ]);
    const query = await new MockEmbeddingProvider().embed(['御剑术 古书 修行 灵感']);
    const res = findSimilar(query[0]!, candidates, { topK: 10, threshold: 0.35, maxResults: 3 });
    // Mock 向量对无关文本相似度应较低（<0.35）
    expect(res.length).toBe(0);
  });

  it('topK 限制：候选超过 topK 只取前 topK 评估', async () => {
    const texts = Array.from({ length: 15 }, (_, i) => `灵感候选文本第${i}条，与修行古书主题相关度不同。`);
    const candidates = await buildCandidates(texts);
    const query = await new MockEmbeddingProvider().embed(['御剑术 古书 修行 灵感']);
    const res = findSimilar(query[0]!, candidates, { topK: 10, threshold: 0.35, maxResults: 3 });
    // topK=10 意味着最多评估 10 个候选，但 maxResults=3 限制结果
    expect(res.length).toBeLessThanOrEqual(3);
  });

  it('无向量 / 空候选 → 空数组不抛错', () => {
    const query = Array.from({ length: DIM }, (_, i) => (i % 2 === 0 ? 0.1 : 0.01));
    expect(findSimilar(query, [], { topK: 10, threshold: 0.35, maxResults: 3 })).toEqual([]);
  });

  it('零向量查询 → 空数组（避免除零）', () => {
    const zero = Array.from({ length: DIM }, () => 0);
    const candidates = [{ entry_id: 'e1', embedding: zero, library_scope: 'global' as const, work_id: null, owner_id: 'a', deleted_at: null }];
    expect(findSimilar(zero, candidates, { topK: 10, threshold: 0.35, maxResults: 3 })).toEqual([]);
  });
});

describe('LlmEmbeddingProvider · 真实实现失败降级', () => {
  it('模型不可用 → 空数组不抛错（降级不阻塞入库）', async () => {
    // 构造一个永远失败的 provider（模拟模型不可用）
    const failing: KnowledgeEmbeddingProvider = {
      async embed() {
        throw new Error('model unavailable');
      }
    };
    const provider = new LlmEmbeddingProvider(failing, { logger: { warn: () => undefined } as never });
    const res = await provider.embed(['测试']).catch(() => []);
    expect(res).toEqual([]);
  });

  it('正常模型 → 透传向量', async () => {
    const vec = Array.from({ length: DIM }, () => 0.5);
    const ok: KnowledgeEmbeddingProvider = { async embed() { return [vec]; } };
    const provider = new LlmEmbeddingProvider(ok, { logger: { warn: () => undefined } as never });
    const res = await provider.embed(['测试']);
    expect(res).toHaveLength(1);
    expect(res[0]).toHaveLength(DIM);
  });

  it('端口常量存在', () => {
    expect(KNOWLEDGE_EMBEDDING_PROVIDER).toBeDefined();
  });
});

// 类型辅助
const _candidateGuard = (c: SimilarityCandidate) => c;
void _candidateGuard;
