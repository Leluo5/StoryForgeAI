// M3c-3 知识库 T14 真实模型接入 · 真实 KnowledgeLlmProvider（Coze→OpenAI 回退链）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.5 + §11.6（D19 真实模型门禁）
// 行为：实现 KnowledgeLlmProvider 6 方法，内部按凭据可用性选择 Coze / OpenAI 兼容；
//       产出与 Mock 同形状的旧型结构化（paragraphs/key_points/...），JSON 解析失败降级
//       Mock 启发式（保证不丢内容、不阻塞入库，D19 质量门禁由解析成功与否体现）。
// 设计：模块层已按「凭据存在→真实、缺失→Mock」装配；本 Provider 假设至少一个底层可用。
import type {
  ArticleStructured,
  InspirationStructured,
  NovelStructured,
  PaperStructured
} from '@storyforge/contracts';
import type { KnowledgeLlmContext, KnowledgeLlmProvider } from './knowledge-llm.provider';
import type { KnowledgeCozeClient } from './knowledge-coze.client';
import type { KnowledgeOpenAiClient } from './knowledge-openai.client';
import { KnowledgeModelError } from './knowledge-openai.client';

/** 真实 LLM Provider 底层：Coze / OpenAI 至少其一可用（模块层已按凭据装配） */
export interface RealLlmDeps {
  coze?: KnowledgeCozeClient | null;
  openai?: KnowledgeOpenAiClient | null;
  logger: { warn: (message: string) => void };
}

/** 解析 LLM 返回的 JSON 对象（容错：剥代码围栏、取首个 {..}，失败抛错走降级） */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(withoutFence) as Record<string, unknown>;
  } catch {
    // 退而求其次：取首个 { 到最后一个 } 之间的子串
    const start = withoutFence.indexOf('{');
    const end = withoutFence.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(withoutFence.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * 真实 KnowledgeLlmProvider：Coze→OpenAI 回退链。
 * 每个方法先构造提示词（system 约束输出 JSON），调 chat，再解析为结构化类型；
 * 解析失败降级为 Mock 启发式（用导入的静态函数），保证条目不丢内容。
 */
export class RealKnowledgeLlmProvider implements KnowledgeLlmProvider {
  constructor(private readonly deps: RealLlmDeps) {}

  // ───────────────────────────── 底层选择（回退链） ─────────────────────────────

  private async chat(system: string, user: string): Promise<string> {
    if (this.deps.coze) {
      try {
        return await this.deps.coze.chat({ system, user });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.logger.warn(`[knowledge-llm] Coze 调用失败，回退 OpenAI：${message}`);
      }
    }
    if (this.deps.openai) {
      return this.deps.openai.chat({ system, user });
    }
    throw new KnowledgeModelError('真实 LLM 底层不可用（Coze/OpenAI 均未配置）', 'NOT_CONFIGURED');
  }

  // ───────────────────────────── 类型识别 ─────────────────────────────

  async detectType(context: KnowledgeLlmContext): Promise<{ type: 'article' | 'paper' | 'novel' | 'inspiration' | 'uncertain' }> {
    const system =
      '你是知识库类型识别器。根据原文判断条目类型，只输出一个 JSON 对象：{"type":"article|paper|novel|inspiration|uncertain"}，禁止输出其他内容。';
    const user = JSON.stringify({ title: context.title ?? '', source: context.source, rawContent: context.rawContent.slice(0, 4000) });
    const answer = await this.chat(system, user);
    const parsed = parseJsonObject(answer);
    const type = parsed?.type;
    if (type === 'article' || type === 'paper' || type === 'novel' || type === 'inspiration') {
      return { type };
    }
    return { type: 'uncertain' };
  }

  // ───────────────────────────── 文章 ─────────────────────────────

  async parseArticle(context: KnowledgeLlmContext): Promise<ArticleStructured> {
    const system =
      '你是文章结构化器。把原文拆为分段并提取核心观点与标签，只输出 JSON：' +
      '{"paragraphs":string[],"key_points":string[],"summary":string,"tag_list":string[]}，禁止其他内容。';
    const user = JSON.stringify({ title: context.title ?? '', source: context.source, rawContent: context.rawContent.slice(0, 8000) });
    const answer = await this.chat(system, user);
    const parsed = parseJsonObject(answer);
    if (!parsed) return fallbackArticle(context);
    return {
      paragraphs: asStringArray(parsed.paragraphs),
      key_points: asStringArray(parsed.key_points),
      summary: asString(parsed.summary),
      tag_list: asStringArray(parsed.tag_list)
    };
  }

  // ───────────────────────────── 论文 ─────────────────────────────

  async parsePaper(context: KnowledgeLlmContext): Promise<PaperStructured> {
    const system =
      '你是论文结构化器。提取五要素，只输出 JSON：' +
      '{"research_question":string,"research_method":string,"core_conclusion":string,"limitation":string,"design_insight":string}，禁止其他内容。';
    const user = JSON.stringify({ title: context.title ?? '', source: context.source, rawContent: context.rawContent.slice(0, 8000) });
    const answer = await this.chat(system, user);
    const parsed = parseJsonObject(answer);
    if (!parsed) return fallbackPaper(context);
    return {
      research_question: asString(parsed.research_question),
      research_method: asString(parsed.research_method),
      core_conclusion: asString(parsed.core_conclusion),
      limitation: asString(parsed.limitation),
      design_insight: asString(parsed.design_insight)
    };
  }

  // ───────────────────────────── 小说（含四维大纲） ─────────────────────────────

  async parseNovel(context: KnowledgeLlmContext): Promise<NovelStructured> {
    const system =
      '你是小说结构化器。提取角色/情节线/叙事风格/世界观，只输出 JSON：' +
      '{"characters":string[],"plot_lines":string[],"narrative_style":string[],"world_setting":string}，禁止其他内容。';
    const user = JSON.stringify({ title: context.title ?? '', source: context.source, rawContent: context.rawContent.slice(0, 8000) });
    const answer = await this.chat(system, user);
    const parsed = parseJsonObject(answer);
    if (!parsed) return fallbackNovel(context);
    return {
      characters: asStringArray(parsed.characters),
      plot_lines: asStringArray(parsed.plot_lines),
      narrative_style: asStringArray(parsed.narrative_style),
      world_setting: asString(parsed.world_setting)
    };
  }

  // ───────────────────────────── 灵感 ─────────────────────────────

  async parseInspiration(context: KnowledgeLlmContext): Promise<InspirationStructured> {
    const answer = await this.chat(
      '你是灵感补全器。基于原文补充上下文使其更完整，只输出 JSON：{"enriched_text":string,"related_ids":string[]}，禁止其他内容。',
      JSON.stringify({ title: context.title ?? '', source: context.source, rawContent: context.rawContent.slice(0, 4000) })
    );
    const parsed = parseJsonObject(answer);
    return {
      raw_text: context.rawContent,
      enriched_text: asString(parsed?.enriched_text) || context.rawContent,
      related_ids: asStringArray(parsed?.related_ids)
    };
  }

  async enrichInspiration(context: KnowledgeLlmContext): Promise<{ enriched_text: string; related_ids: string[] }> {
    const ctx = context.relatedContexts ?? [];
    const answer = await this.chat(
      '你是灵感补全器。基于原文与已有关联上下文补充灵感，只输出 JSON：{"enriched_text":string,"related_ids":string[]}，禁止其他内容。',
      JSON.stringify({ title: context.title ?? '', source: context.source, rawContent: context.rawContent.slice(0, 4000), relatedContexts: ctx.slice(0, 10) })
    );
    const parsed = parseJsonObject(answer);
    return {
      enriched_text: asString(parsed?.enriched_text) || context.rawContent,
      related_ids: asStringArray(parsed?.related_ids)
    };
  }
}

// ───────────────────────────── 降级（Mock 启发式，防丢内容） ─────────────────────────────

function fallbackArticle(context: KnowledgeLlmContext): ArticleStructured {
  const paragraphs = context.rawContent.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return {
    paragraphs: paragraphs.length ? paragraphs : [context.rawContent.trim()],
    key_points: paragraphs.slice(0, 3).map((p) => p.slice(0, 40)),
    summary: paragraphs[0]?.slice(0, 120) ?? '',
    tag_list: []
  };
}

function fallbackPaper(context: KnowledgeLlmContext): PaperStructured {
  const paragraphs = context.rawContent.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return {
    research_question: paragraphs[0]?.slice(0, 80) ?? '',
    research_method: paragraphs[1]?.slice(0, 80) ?? '',
    core_conclusion: paragraphs[2]?.slice(0, 80) ?? '',
    limitation: paragraphs[3]?.slice(0, 80) ?? '',
    design_insight: paragraphs[4]?.slice(0, 80) ?? ''
  };
}

function fallbackNovel(context: KnowledgeLlmContext): NovelStructured {
  const paragraphs = context.rawContent.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return {
    characters: [],
    plot_lines: paragraphs.map((p) => p.slice(0, 60)),
    narrative_style: [],
    world_setting: context.title ?? ''
  };
}
