// M3c-3 知识库 T14 Mock 向量嵌入 Provider
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.5
// Mock 特性：维度恒 1024、确定性（同文本同向量）、L2 归一化、特征哈希（unigram+bigram）保证区分度
import { Injectable } from '@nestjs/common';
import type { KnowledgeEmbeddingProvider } from './embedding.provider';

export const EMBEDDING_DIM = 1024;

// FNV-1a 32 位哈希：确定性、无碰撞概率低，用于特征→维度映射
function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// 特征哈希：unigram + bigram 各自映射到 [0, DIM)，累加权重
// 共享字符/字词越多 → 向量方向越接近 → 余弦相似度越高，保证同主题文本可被召回
function textToFeatureVec(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIM).fill(0);
  const chars = Array.from(text);
  for (let i = 0; i < chars.length; i++) {
    vec[fnv1a(chars[i]!) % EMBEDDING_DIM]! += 1;
    if (i + 1 < chars.length) {
      vec[fnv1a(chars[i]! + chars[i + 1]!) % EMBEDDING_DIM]! += 1;
    }
  }
  return vec;
}

// L2 归一化：零向量原样返回（避免除零），其余缩放为单位模长
function normalize(vec: number[]): number[] {
  let normSq = 0;
  for (const x of vec) normSq += x * x;
  const norm = Math.sqrt(normSq);
  if (norm === 0) return vec;
  return vec.map((x) => x / norm);
}

/**
 * Mock 嵌入 Provider：确定性输出（不依赖外部模型）。
 * M3a 打通闭环用；M3b 接入真实模型时替换实现，不改知识库业务逻辑。
 */
@Injectable()
export class MockEmbeddingProvider implements KnowledgeEmbeddingProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => normalize(textToFeatureVec(t)));
  }
}
