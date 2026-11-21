import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { env as defaultEnv } from '../../config/env';
import { CollabUpstreamError, timeoutError, upstreamFailedError } from '../channel/collab-upstream.error';

// FastGPT 客户端所需环境变量子集（便于单测注入替身；显式允许 undefined）
export interface FastGptClientEnv {
  FASTGPT_BASE_URL?: string | undefined;
  FASTGPT_API_KEY?: string | undefined;
  FASTGPT_DATASET_ID?: string | undefined;
  FASTGPT_SEARCH_PATH?: string | undefined;
  COLLAB_HTTP_TIMEOUT_MS?: number | undefined;
}

// 检索条目：只保留 id/title/content/score，容忍上游新增字段（zod passthrough）
export interface FastGptHit {
  id: string;
  title: string;
  content: string;
  score: number | null;
}

// 检索结果（内部）：调用方负责截断/兜底/上限
export interface FastGptSearchResult {
  datasetId: string;
  hits: FastGptHit[];
}

// 响应 zod 解析：容忍上游新增字段（对象 .passthrough()），只取需要的键。
// v4.17.4 实际结构为 { data: { list: [...] } }，条目内容在 q、来源名在 sourceName、score 为分项数组；
// 旧版 / 简化实现返回 { data: [...] }，条目用 content/title 与数字 score —— 两者都接受。
const scorePartSchema = z
  .object({ type: z.string().optional(), value: z.number().optional() })
  .passthrough();

const fastGptHitSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().optional(),
    content: z.string().optional(),
    q: z.string().optional(),
    sourceName: z.string().optional(),
    score: z.union([z.number(), z.string(), z.array(scorePartSchema)]).nullable().optional()
  })
  .passthrough();

const fastGptSearchResponseSchema = z
  .object({
    data: z.union([z.array(fastGptHitSchema), z.object({ list: z.array(fastGptHitSchema) }).passthrough()])
  })
  .passthrough();

function normalizeScore(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (Array.isArray(value)) {
    // v4.17 混合检索返回分项分：[{type:'embedding'|'fullText'|'rrf', value, index}]
    // rrf 是融合排序分，优先使用；缺失时回退到第一个可用的数值
    const parts = value as Array<{ type?: unknown; value?: unknown }>;
    const rrf = parts.find((part) => part && part.type === 'rrf' && typeof part.value === 'number');
    if (rrf) return rrf.value as number;
    const first = parts.find((part) => part && typeof part.value === 'number');
    if (first) return first.value as number;
  }
  return null;
}

// F11 FastGPT 客户端（F2 §5.2）：POST {FASTGPT_BASE_URL}{FASTGPT_SEARCH_PATH}
// 请求体含 datasetId/text/limit/similarity/searchMode；响应经 Zod 解析，容忍上游新增字段。
// 只取 id/title/content/score；title 缺失用 id 兜底由 citation.mapper 处理。
@Injectable()
export class FastGptClient {
  constructor(private readonly envProvider: FastGptClientEnv = defaultEnv) {}

  async search(query: string, limit = 8): Promise<FastGptSearchResult> {
    const {
      FASTGPT_BASE_URL,
      FASTGPT_API_KEY,
      FASTGPT_DATASET_ID,
      FASTGPT_SEARCH_PATH = '/api/core/dataset/searchTest',
      COLLAB_HTTP_TIMEOUT_MS = 120_000
    } = this.envProvider;

    if (!FASTGPT_BASE_URL || !FASTGPT_API_KEY || !FASTGPT_DATASET_ID) {
      throw new CollabUpstreamError('FastGPT 检索未配置', false, 'COLLAB_CHANNEL_NOT_CONFIGURED');
    }

    const url = `${FASTGPT_BASE_URL.replace(/\/+$/, '')}${FASTGPT_SEARCH_PATH.startsWith('/') ? FASTGPT_SEARCH_PATH : `/${FASTGPT_SEARCH_PATH}`}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), COLLAB_HTTP_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${FASTGPT_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          datasetId: FASTGPT_DATASET_ID,
          text: query,
          limit,
          similarity: 0.3,
          // FastGPT v4.17 合法枚举：embedding / keyword / mixedRecall（'hybrid' 会被上游 zod 拒绝）
          searchMode: 'mixedRecall'
        }),
        signal: controller.signal
      });

      if (!response.ok) {
        throw upstreamFailedError(`FastGPT 返回 ${response.status}`);
      }
      const raw = (await response.json()) as unknown;
      const parsed = fastGptSearchResponseSchema.parse(raw);
      const list = Array.isArray(parsed.data) ? parsed.data : parsed.data.list;
      const hits: FastGptHit[] = list.map((item) => ({
        id: item.id,
        // v4.17 用 sourceName 表示来源文件名；旧结构用 title
        title: item.title ?? item.sourceName ?? '',
        // v4.17 用 q 表示片段正文；旧结构用 content
        content: item.content ?? item.q ?? '',
        score: normalizeScore(item.score)
      }));

      return { datasetId: FASTGPT_DATASET_ID, hits };
    } catch (error) {
      if (error instanceof CollabUpstreamError) throw error;
      const isTimeout = error instanceof Error && error.name === 'AbortError';
      if (isTimeout) throw timeoutError(`FastGPT 检索超时 ${COLLAB_HTTP_TIMEOUT_MS}ms`);
      throw upstreamFailedError(`FastGPT 检索失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
