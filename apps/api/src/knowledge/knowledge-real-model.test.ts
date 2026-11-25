// TDD · M3b 关联 D19 真实模型门禁
// 覆盖：RealKnowledgeLlmProvider（Coze→OpenAI 回退链、JSON 解析容错、降级启发式）、
//       RealEmbeddingProvider（OpenAI 嵌入 → 失败降级 Mock、1024 维归一化）、
//       模块装配（buildLlmProvider / buildEmbeddingProvider 凭据缺失回退 Mock）。
import { describe, it, expect, vi } from 'vitest';
import type { KnowledgeLlmContext } from './knowledge-llm.provider';
import { RealKnowledgeLlmProvider } from './knowledge-llm.real';
import { RealEmbeddingProvider } from './knowledge-embedding.real';
import { KnowledgeOpenAiClient, KnowledgeModelError } from './knowledge-openai.client';
import { KnowledgeCozeClient } from './knowledge-coze.client';
import { MockEmbeddingProvider, EMBEDDING_DIM } from './embedding.mock';
import { MockKnowledgeLlmProvider } from './knowledge-llm.provider';
import { buildLlmProvider, buildEmbeddingProvider } from './knowledge.module';

const silentLogger = { warn: () => undefined, log: () => undefined };

function ctx(overrides: Partial<KnowledgeLlmContext> = {}): KnowledgeLlmContext {
  return { rawContent: '第一段。\n\n第二段。', source: 'article', ...overrides };
}

// ───────────────────────────── OpenAI 客户端 ─────────────────────────────

describe('KnowledgeOpenAiClient', () => {
  it('凭据缺失抛 NOT_CONFIGURED', () => {
    expect(() => new KnowledgeOpenAiClient({ baseUrl: '', apiKey: '', model: '' })).toThrow(KnowledgeModelError);
    try {
      new KnowledgeOpenAiClient({ baseUrl: '', apiKey: '', model: '' });
    } catch (e) {
      expect((e as KnowledgeModelError).code).toBe('NOT_CONFIGURED');
    }
  });

  it('base() 补全 /v1 前缀（不双前缀）', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));
    const client = new KnowledgeOpenAiClient({ baseUrl: 'https://gw.example.com', apiKey: 'k', model: 'gpt-4o-mini' }, fetcher as never);
    await client.chat({ system: 's', user: 'u' });
    expect(fetcher.mock.calls[0]![0]).toBe('https://gw.example.com/v1/chat/completions');
  });

  it('chat 返回 message.content', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '答案' } }] }), { status: 200 }));
    const client = new KnowledgeOpenAiClient({ baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'm' }, fetcher as never);
    await expect(client.chat({ system: 's', user: 'u' })).resolves.toBe('答案');
  });

  it('chat 空内容抛 PARSE', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 }));
    const client = new KnowledgeOpenAiClient({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }, fetcher as never);
    await expect(client.chat({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'PARSE' });
  });

  it('非 2xx 抛 UPSTREAM', async () => {
    const fetcher = vi.fn(async () => new Response('bad gateway', { status: 502 }));
    const client = new KnowledgeOpenAiClient({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }, fetcher as never);
    await expect(client.chat({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'UPSTREAM' });
  });

  it('embed 按 index 排序返回同序向量，且校验数量', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ data: [
        { index: 1, embedding: [2] },
        { index: 0, embedding: [1] }
      ] }), { status: 200 })
    );
    const client = new KnowledgeOpenAiClient({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', embedDimensions: 1024 }, fetcher as never);
    const res = await client.embed(['a', 'b']);
    expect(res).toEqual([[1], [2]]);
  });

  it('embed 数量不符抛 PARSE', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [1] }] }), { status: 200 }));
    const client = new KnowledgeOpenAiClient({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' }, fetcher as never);
    await expect(client.embed(['a', 'b'])).rejects.toMatchObject({ code: 'PARSE' });
  });
});

// ───────────────────────────── Coze 客户端 ─────────────────────────────

describe('KnowledgeCozeClient', () => {
  it('凭据缺失抛 NOT_CONFIGURED', () => {
    try {
      new KnowledgeCozeClient({ baseUrl: '', pat: '', botId: '' });
    } catch (e) {
      expect((e as KnowledgeModelError).code).toBe('NOT_CONFIGURED');
    }
  });

  it('chat 发起→轮询→取 assistant answer', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/message/list')) return new Response(JSON.stringify({ code: 0, data: { messages: [{ role: 'assistant', content: '结构化结果' }] } }), { status: 200 });
      if (url.includes('/retrieve')) return new Response(JSON.stringify({ code: 0, data: { status: 'completed' } }), { status: 200 });
      if (url.includes('/v3/chat')) return new Response(JSON.stringify({ code: 0, data: { id: 'c1', conversation_id: 'conv1' } }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    const client = new KnowledgeCozeClient({ baseUrl: 'https://api.coze.cn', pat: 'pat', botId: 'bot', timeoutMs: 3000 }, fetcher as never);
    await expect(client.chat({ system: 's', user: 'u' })).resolves.toBe('结构化结果');
  });

  it('对话失败状态抛 UPSTREAM', async () => {
    const fetcher = vi.fn(async (url: string) => {
      if (url.includes('/retrieve')) return new Response(JSON.stringify({ code: 1, data: { status: 'failed' }, msg: 'boom' }), { status: 200 });
      if (url.includes('/v3/chat')) return new Response(JSON.stringify({ code: 0, data: { id: 'c1', conversation_id: 'conv1' } }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    const client = new KnowledgeCozeClient({ baseUrl: 'https://x', pat: 'p', botId: 'b', timeoutMs: 3000 }, fetcher as never);
    await expect(client.chat({ system: 's', user: 'u' })).rejects.toMatchObject({ code: 'UPSTREAM' });
  });
});

// ───────────────────────────── 真实 LLM Provider（回退链 + 解析） ─────────────────────────────

describe('RealKnowledgeLlmProvider', () => {
  it('Coze 成功 → 不调用 OpenAI（回退链先试 Coze）', async () => {
    const coze = { chat: vi.fn(async () => JSON.stringify({ type: 'article' })) };
    const openai = { chat: vi.fn(async () => 'should not be called') };
    const p = new RealKnowledgeLlmProvider({ coze: coze as never, openai: openai as never, logger: silentLogger });
    const res = await p.detectType(ctx());
    expect(res).toEqual({ type: 'article' });
    expect(coze.chat).toHaveBeenCalled();
    expect(openai.chat).not.toHaveBeenCalled();
  });

  it('Coze 失败 → 回退 OpenAI（warn 记录）', async () => {
    const warn = vi.fn();
    const coze = { chat: vi.fn(async () => { throw new Error('coze down'); }) };
    const openai = { chat: vi.fn(async () => JSON.stringify({ type: 'paper' })) };
    const p = new RealKnowledgeLlmProvider({ coze: coze as never, openai: openai as never, logger: { warn } });
    const res = await p.detectType(ctx());
    expect(res).toEqual({ type: 'paper' });
    expect(warn).toHaveBeenCalled();
  });

  it('均不可用 → 抛 NOT_CONFIGURED', async () => {
    const p = new RealKnowledgeLlmProvider({ coze: null, openai: null, logger: silentLogger });
    await expect(p.detectType(ctx())).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
  });

  it('parseArticle 解析 JSON → 结构', async () => {
    const openai = { chat: vi.fn(async () => JSON.stringify({ paragraphs: ['p1', 'p2'], key_points: ['k'], summary: 's', tag_list: ['t'] })) };
    const p = new RealKnowledgeLlmProvider({ openai: openai as never, logger: silentLogger });
    const res = await p.parseArticle(ctx({ rawContent: 'p1\n\np2' }));
    expect(res.paragraphs).toEqual(['p1', 'p2']);
    expect(res.key_points).toEqual(['k']);
    expect(res.tag_list).toEqual(['t']);
  });

  it('parseArticle 剥代码围栏 + 取首个 {} 子串（容错）', async () => {
    const openai = { chat: vi.fn(async () => '```json\n{"paragraphs":["x"],"key_points":[],"summary":"","tag_list":[]}\n```') };
    const p = new RealKnowledgeLlmProvider({ openai: openai as never, logger: silentLogger });
    const res = await p.parseArticle(ctx());
    expect(res.paragraphs).toEqual(['x']);
  });

  it('JSON 解析失败 → 降级 Mock 启发式（防丢内容）', async () => {
    const openai = { chat: vi.fn(async () => '不是 JSON 的乱码') };
    const p = new RealKnowledgeLlmProvider({ openai: openai as never, logger: silentLogger });
    const res = await p.parseArticle(ctx({ rawContent: '第一段。\n\n第二段。' }));
    expect(res.paragraphs.length).toBeGreaterThan(0);
    expect(res.paragraphs[0]).toBe('第一段。');
  });

  it('parsePaper 五要素提取', async () => {
    const openai = { chat: vi.fn(async () => JSON.stringify({ research_question: 'q', research_method: 'm', core_conclusion: 'c', limitation: 'l', design_insight: 'd' })) };
    const p = new RealKnowledgeLlmProvider({ openai: openai as never, logger: silentLogger });
    const res = await p.parsePaper(ctx());
    expect(res).toMatchObject({ research_question: 'q', research_method: 'm', core_conclusion: 'c', limitation: 'l', design_insight: 'd' });
  });

  it('parseNovel 角色/情节/叙事/世界观', async () => {
    const openai = { chat: vi.fn(async () => JSON.stringify({ characters: ['A'], plot_lines: ['p'], narrative_style: ['n'], world_setting: 'w' })) };
    const p = new RealKnowledgeLlmProvider({ openai: openai as never, logger: silentLogger });
    const res = await p.parseNovel(ctx());
    expect(res.characters).toEqual(['A']);
    expect(res.world_setting).toBe('w');
  });

  it('parseInspiration 补全 enriched_text，解析失败用原文', async () => {
    const openai = { chat: vi.fn(async () => '坏响应') };
    const p = new RealKnowledgeLlmProvider({ openai: openai as never, logger: silentLogger });
    const res = await p.parseInspiration(ctx({ rawContent: '灵感原文' }));
    expect(res.enriched_text).toBe('灵感原文');
    expect(res.related_ids).toEqual([]);
  });

  it('detectType 无法识别 → uncertain', async () => {
    const openai = { chat: vi.fn(async () => JSON.stringify({ type: 'unknown' })) };
    const p = new RealKnowledgeLlmProvider({ openai: openai as never, logger: silentLogger });
    const res = await p.detectType(ctx());
    expect(res.type).toBe('uncertain');
  });
});

// ───────────────────────────── 真实嵌入 Provider ─────────────────────────────

describe('RealEmbeddingProvider', () => {
  it('OpenAI 成功 → 归一化到 1024 维', async () => {
    const openai = { embed: vi.fn(async () => [[0.3, 0.4]]) };
    const p = new RealEmbeddingProvider({ openai: openai as never, logger: silentLogger });
    const res = await p.embed(['a']);
    expect(res[0]).toHaveLength(EMBEDDING_DIM);
    const norm = Math.sqrt(res[0]!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });

  it('OpenAI 失败 → 降级 Mock（warn 记录，向量仍 1024 维）', async () => {
    const warn = vi.fn();
    const openai = { embed: vi.fn(async () => { throw new Error('upstream down'); }) };
    const p = new RealEmbeddingProvider({ openai: openai as never, logger: { warn } });
    const res = await p.embed(['a', 'b']);
    expect(res).toHaveLength(2);
    expect(res[0]).toHaveLength(EMBEDDING_DIM);
    expect(warn).toHaveBeenCalled();
  });

  it('无 openai（null）→ 纯 Mock 确定性', async () => {
    const p = new RealEmbeddingProvider({ openai: null, logger: silentLogger });
    const [a] = await p.embed(['x']);
    const [b] = await p.embed(['x']);
    expect(a).toEqual(b);
  });

  it('超长向量截断到 1024，不足补齐 0 后归一化', async () => {
    const openai = { embed: vi.fn(async () => [Array.from({ length: 2048 }, () => 1)]) };
    const p = new RealEmbeddingProvider({ openai: openai as never, logger: silentLogger });
    const res = await p.embed(['a']);
    expect(res[0]).toHaveLength(EMBEDDING_DIM);
  });
});

// ───────────────────────────── MockEmbeddingProvider 基线 ─────────────────────────────

describe('MockEmbeddingProvider 基线', () => {
  it('维度恒 1024、确定性、L2 归一化', async () => {
    const p = new MockEmbeddingProvider();
    const [a] = await p.embed(['基线文本']);
    const [b] = await p.embed(['基线文本']);
    expect(a).toHaveLength(EMBEDDING_DIM);
    expect(a).toEqual(b);
    const norm = Math.sqrt(a!.reduce((s, x) => s + x * x, 0));
    expect(norm).toBeCloseTo(1, 6);
  });
});

// ───────────────────────────── 模块装配（凭据缺失回退 Mock） ─────────────────────────────

const noopLogger = { warn: () => undefined, log: () => undefined };

describe('buildLlmProvider 装配', () => {
  it('无任何凭据 → MockKnowledgeLlmProvider', () => {
    const p = buildLlmProvider({ mode: 'auto' }, noopLogger);
    expect(p).toBeInstanceOf(MockKnowledgeLlmProvider);
  });

  it('auto + 仅 Coze 凭据 → Real（coze 装配）', () => {
    const p = buildLlmProvider(
      { mode: 'auto', coze: { baseUrl: 'https://api.coze.cn', pat: 'pat', botId: 'bot' } },
      noopLogger
    );
    expect(p).toBeInstanceOf(RealKnowledgeLlmProvider);
    expect(p).not.toBeInstanceOf(MockKnowledgeLlmProvider);
  });

  it('coze 强制但凭据缺失 → Mock', () => {
    const p = buildLlmProvider({ mode: 'coze' }, noopLogger);
    expect(p).toBeInstanceOf(MockKnowledgeLlmProvider);
  });

  it('openai 强制 + 凭据 → Real（openai 装配）', () => {
    const p = buildLlmProvider(
      { mode: 'openai', openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'gpt-4o-mini' } },
      noopLogger
    );
    expect(p).toBeInstanceOf(RealKnowledgeLlmProvider);
  });

  it('openai 强制但凭据缺失 → Mock', () => {
    const p = buildLlmProvider({ mode: 'openai' }, noopLogger);
    expect(p).toBeInstanceOf(MockKnowledgeLlmProvider);
  });
});

describe('buildEmbeddingProvider 装配', () => {
  it('无凭据 → MockEmbeddingProvider', () => {
    const p = buildEmbeddingProvider({}, noopLogger);
    expect(p).toBeInstanceOf(MockEmbeddingProvider);
  });

  it('OpenAI 嵌入凭据 → RealEmbeddingProvider（dim 默认 1024）', () => {
    const p = buildEmbeddingProvider(
      { openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model: 'text-embedding-3-small' } },
      noopLogger
    );
    expect(p).toBeInstanceOf(RealEmbeddingProvider);
  });
});
