import { Inject, Injectable } from '@nestjs/common';
import type { NovelOutline } from '@storyforge/contracts';
import { KNOWLEDGE_LLM_PROVIDER, type KnowledgeLlmContext, type KnowledgeLlmProvider } from './knowledge-llm.provider';

export type OutlineResult =
  | { outline: NovelOutline; error?: never }
  | { outline?: never; error: 'outline_failed' | 'no_chapters' };

@Injectable()
export class KnowledgeOutlineService {
  constructor(@Inject(KNOWLEDGE_LLM_PROVIDER) private readonly llm: KnowledgeLlmProvider) {}

  /**
   * 四维度大纲提取：章节 / 情节节点 / 人物关系 / 核心故事线。
   * 失败返回 { error: 'outline_failed' }；无章节结构返回 { error: 'no_chapters' }。
   * 依赖 LLM；Mock 下返回确定性空骨架（可编辑）。
   */
  async extractOutline(context: KnowledgeLlmContext): Promise<OutlineResult> {
    try {
      const novel = await this.llm.parseNovel(context);
      const chapters = this.detectChapters(context.rawContent);
      // 章节结构是大纲核心维度：无章节标题即无大纲价值（DoD #11）
      if (chapters.length === 0) {
        return { error: 'no_chapters' };
      }
      const outline: NovelOutline = {
        chapters,
        plot_nodes: novel.plot_lines.map((line, i) => ({
          id: `pn_${i + 1}`,
          label: line.slice(0, 20) || `情节${i + 1}`,
          type: 'main'
        })),
        character_relations: [],
        core_storylines: { main: chapters[0]?.summary ?? '', branches: [], hidden: [] }
      };
      return { outline };
    } catch {
      return { error: 'outline_failed' };
    }
  }

  /** 从原文识别章节标题（Markdown 标题 / 中文「第X章」/ 数字编号），供大纲 chapters */
  private detectChapters(rawContent: string): NovelOutline['chapters'] {
    const lines = rawContent.split(/\n/);
    const chapters: NovelOutline['chapters'] = [];
    let order = 1;
    for (const line of lines) {
      const trimmed = line.trim().replace(/^#+\s*/, '');
      if (/^第[一二三四五六七八九十百0-9]+[章回卷]/.test(trimmed) || /^第[一二三四五六七八九十百0-9]+章/.test(trimmed)) {
        chapters.push({ title: trimmed.slice(0, 50), summary: '', order: order++ });
      }
    }
    return chapters;
  }
}
