import { Injectable } from '@nestjs/common';
import type {
  ArticleStructured,
  InspirationStructured,
  NovelStructured,
  PaperStructured
} from '@storyforge/contracts';

/**
 * 知识库 LLM Provider 输入：原文 + 上下文（标题/来源/已有关联）。
 * 与章节 AI（AiModelProvider）领域解耦；M3b 接入 Coze 时实现本接口。
 */
export interface KnowledgeLlmContext {
  rawContent: string;
  title?: string;
  source: string;
  /** 已有关联条目（供灵感补充上下文） */
  relatedContexts?: string[];
}

/**
 * 知识库 LLM 能力：类型识别 / 四类拆分 / 大纲提取 / 灵感补充。
 * M3a 用 Mock 确定性输出打通闭环；M3b 接 Coze 时替换实现。
 */
export interface KnowledgeLlmProvider {
  detectType(context: KnowledgeLlmContext): Promise<{ type: 'article' | 'paper' | 'novel' | 'inspiration' | 'uncertain' }>;
  parseArticle(context: KnowledgeLlmContext): Promise<ArticleStructured>;
  parsePaper(context: KnowledgeLlmContext): Promise<PaperStructured>;
  parseNovel(context: KnowledgeLlmContext): Promise<NovelStructured>;
  parseInspiration(context: KnowledgeLlmContext): Promise<InspirationStructured>;
  enrichInspiration(context: KnowledgeLlmContext): Promise<{ enriched_text: string; related_ids: string[] }>;
}

export const KNOWLEDGE_LLM_PROVIDER = Symbol('KNOWLEDGE_LLM_PROVIDER');

/**
 * Mock 知识库 LLM Provider：确定性输出（不依赖外部 LLM）。
 * 用于 M3a 打通闭环（录入→识别→拆分→关联可走通），结果可编辑确认入库。
 * M3b 接入 Coze 后替换为真实实现，不改知识库业务逻辑。
 */
@Injectable()
export class MockKnowledgeLlmProvider implements KnowledgeLlmProvider {
  async detectType(context: KnowledgeLlmContext): Promise<{ type: 'article' | 'paper' | 'novel' | 'inspiration' | 'uncertain' }> {
    // Mock 启发式：标题含"论文/研究"→paper；含"小说/章"→novel；其余按长度/特征，默认 article
    const text = `${context.title ?? ''} ${context.rawContent.slice(0, 200)}`;
    if (/论文|研究|实验|调查/.test(text)) return { type: 'paper' };
    // novel：章节结构/剧情类关键词（排除"文章"里的"章"字，用「第N章」或独立词判定）
    if (/小说|第[一二三四五六七八九十百]+章|卷|剧情|主角/.test(text)) return { type: 'novel' };
    if (/灵感|想法|点子/.test(text)) return { type: 'inspiration' };
    return { type: 'article' };
  }

  async parseArticle(context: KnowledgeLlmContext): Promise<ArticleStructured> {
    const paragraphs = context.rawContent
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .filter(Boolean);
    return {
      paragraphs: paragraphs.length ? paragraphs : [context.rawContent.trim()],
      key_points: paragraphs.slice(0, 3).map((p) => p.slice(0, 40)),
      summary: paragraphs[0]?.slice(0, 120) ?? '',
      tag_list: []
    };
  }

  async parsePaper(context: KnowledgeLlmContext): Promise<PaperStructured> {
    const paragraphs = context.rawContent.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    return {
      research_question: paragraphs[0]?.slice(0, 80) ?? '',
      research_method: paragraphs[1]?.slice(0, 80) ?? '',
      core_conclusion: paragraphs[2]?.slice(0, 80) ?? '',
      limitation: paragraphs[3]?.slice(0, 80) ?? '',
      design_insight: paragraphs[4]?.slice(0, 80) ?? ''
    };
  }

  async parseNovel(context: KnowledgeLlmContext): Promise<NovelStructured> {
    const paragraphs = context.rawContent.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    return {
      characters: [],
      plot_lines: paragraphs.map((p) => p.slice(0, 60)),
      narrative_style: [],
      world_setting: context.title ?? ''
    };
  }

  async parseInspiration(context: KnowledgeLlmContext): Promise<InspirationStructured> {
    return {
      raw_text: context.rawContent,
      enriched_text: context.rawContent,
      related_ids: []
    };
  }

  async enrichInspiration(context: KnowledgeLlmContext): Promise<{ enriched_text: string; related_ids: string[] }> {
    const ctx = context.relatedContexts ?? [];
    return {
      enriched_text: context.rawContent,
      related_ids: []
      // 真实实现会基于 ctx 补充；Mock 保持原文
    };
  }
}
