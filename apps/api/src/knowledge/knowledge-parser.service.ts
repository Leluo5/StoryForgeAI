import { Inject, Injectable } from '@nestjs/common';
import type {
  ArticleStructured,
  InspirationStructured,
  KnowledgeStructured,
  KnowledgeType,
  NovelStructured,
  PaperStructured
} from '@storyforge/contracts';
import { KNOWLEDGE_LLM_PROVIDER, type KnowledgeLlmContext, type KnowledgeLlmProvider } from './knowledge-llm.provider';
import { KnowledgeOutlineService } from './knowledge-outline.service';

/** 类型识别不确定（前端弹确认框手动指定） */
export class TypeUncertainError extends Error {
  constructor() {
    super('知识类型无法自动确定，请手动指定');
    this.name = 'TypeUncertainError';
  }
}

/** 拆分失败：降级为原文存储 */
export interface ParsedEntry {
  type: KnowledgeType;
  structured: KnowledgeStructured;
  degraded: boolean;
}

// 超大文本分块阈值与块大小（对齐旧 F5 §4.6）
const CHUNK_THRESHOLD = 6000;
const CHUNK_SIZE = 3000;

@Injectable()
export class KnowledgeParserService {
  constructor(
    @Inject(KNOWLEDGE_LLM_PROVIDER) private readonly llm: KnowledgeLlmProvider,
    @Inject(KnowledgeOutlineService) private readonly outline: KnowledgeOutlineService
  ) {}

  /**
   * 类型识别：手动指定优先；否则 LLM 判定；不确定抛 TypeUncertainError。
   */
  async detectType(
    context: KnowledgeLlmContext,
    manual?: KnowledgeType
  ): Promise<KnowledgeType> {
    if (manual) return manual;
    const result = await this.llm.detectType(context);
    if (result.type === 'uncertain') throw new TypeUncertainError();
    return result.type;
  }

  /**
   * 拆分引擎：按类型分派；失败降级原文存储；parseNovel 成功后自动触发大纲。
   * 返回 { type, structured, degraded }。
   */
  async parseEntry(
    context: KnowledgeLlmContext,
    manualType?: KnowledgeType
  ): Promise<ParsedEntry> {
    const type = await this.detectType(context, manualType);
    try {
      let structured: KnowledgeStructured;
      if (type === 'article') {
        structured = await this.parseArticle(context);
      } else if (type === 'paper') {
        structured = await this.parsePaper(context);
      } else if (type === 'novel') {
        structured = await this.parseNovel(context);
      } else {
        structured = await this.parseInspiration(context);
      }
      return { type, structured, degraded: false };
    } catch {
      // 拆分失败：降级原文存储，不阻断录入
      return { type, structured: { raw: context.rawContent, parse_degraded: true }, degraded: true };
    }
  }

  /**
   * 文章拆分：分块（>阈值）逐块解析再合并。
   */
  async parseArticle(context: KnowledgeLlmContext): Promise<ArticleStructured> {
    if (context.rawContent.length <= CHUNK_THRESHOLD) {
      return this.llm.parseArticle(context);
    }
    return this.parseInChunks(context, (chunkCtx) => this.llm.parseArticle(chunkCtx), (chunks) => ({
      paragraphs: chunks.flatMap((c) => c.paragraphs),
      key_points: chunks.flatMap((c) => c.key_points).slice(0, 10),
      summary: chunks[0]?.summary ?? '',
      tag_list: chunks.flatMap((c) => c.tag_list).slice(0, 20)
    }));
  }

  async parsePaper(context: KnowledgeLlmContext): Promise<PaperStructured> {
    if (context.rawContent.length <= CHUNK_THRESHOLD) {
      return this.llm.parsePaper(context);
    }
    return this.parseInChunks(context, (chunkCtx) => this.llm.parsePaper(chunkCtx), (chunks) => ({
      research_question: chunks[0]?.research_question ?? '',
      research_method: chunks[0]?.research_method ?? '',
      core_conclusion: chunks[chunks.length - 1]?.core_conclusion ?? '',
      limitation: chunks[chunks.length - 1]?.limitation ?? '',
      design_insight: chunks[0]?.design_insight ?? ''
    }));
  }

  async parseNovel(context: KnowledgeLlmContext): Promise<NovelStructured> {
    if (context.rawContent.length <= CHUNK_THRESHOLD) {
      return this.llm.parseNovel(context);
    }
    return this.parseInChunks(context, (chunkCtx) => this.llm.parseNovel(chunkCtx), (chunks) => ({
      characters: chunks.flatMap((c) => c.characters).slice(0, 50),
      plot_lines: chunks.flatMap((c) => c.plot_lines).slice(0, 100),
      narrative_style: chunks.flatMap((c) => c.narrative_style).slice(0, 20),
      world_setting: chunks[0]?.world_setting ?? ''
    }));
  }

  async parseInspiration(context: KnowledgeLlmContext): Promise<InspirationStructured> {
    return this.llm.parseInspiration(context);
  }

  /**
   * 自动触发大纲提取：parseNovel 成功后调用（DoD #11）。
   * 由 controller/service 在 novel commit 后触发；此处提供便捷方法。
   */
  async triggerOutlineForNovel(context: KnowledgeLlmContext, novelStructured: NovelStructured): Promise<NovelStructured> {
    const outline = await this.outline.extractOutline(context);
    if (!outline.outline) return novelStructured; // 失败/无章节则保留拆文结果
    return { ...novelStructured, outline: outline.outline };
  }

  /** 超大文本分块：按 CHUNK_SIZE 切块，逐块解析，合并结果 */
  private async parseInChunks<T>(
    context: KnowledgeLlmContext,
    parseChunk: (chunkCtx: KnowledgeLlmContext) => Promise<T>,
    merge: (chunks: T[]) => T
  ): Promise<T> {
    const chunks: T[] = [];
    for (let i = 0; i < context.rawContent.length; i += CHUNK_SIZE) {
      const slice = context.rawContent.slice(i, i + CHUNK_SIZE);
      chunks.push(await parseChunk({ ...context, rawContent: slice }));
    }
    return merge(chunks);
  }
}
