// M4-T9 知识库旧端点迁移：detect-type / similar / markdown-render
// 依据：docs/04-功能交付档案/M4-迁移切换/11-迁移切换技术方案.md §4.3~§4.5
// 边界（L2 服务层）：复用 classify.ts（类型判定）、embedding + cosine（相似检索）、
// MarkdownIt（正文→HTML 预览，对齐旧 render_body_html）；不写 controller 路由，不落库（render 纯预览）。

import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import MarkdownIt from 'markdown-it';
import type {
  KnowledgeDetectTypeRequest,
  KnowledgeDetectTypeResponse,
  KnowledgeSimilarItem,
  KnowledgeSimilarResponse,
  KnowledgeMarkdownRenderResponse
} from '@storyforge/contracts';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { KnowledgeEntryEmbeddingEntity } from '../database/knowledge-entry-embedding.entity';
import { WorkEntity } from '../database/work.entity';
import { classifyEntryType } from './classify';
import { cosineSimilarity } from './similarity';

// 正文→HTML 渲染器（对齐旧 render_body_html：extra≈GFM 表格/删除线、nl2br≈breaks）
// html:false 禁用内联 HTML（等价旧 safe 剔除 script/on* 等），linkify:false 不自动生成链接
const renderer = new MarkdownIt({ html: false, linkify: false, breaks: true });

@Injectable()
export class KnowledgeToolsService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  // ── detect-type：复用 classify.ts（规则判定，含 manual 显式指定） ──
  async detectType(input: KnowledgeDetectTypeRequest): Promise<KnowledgeDetectTypeResponse> {
    const result = classifyEntryType({
      rawContent: input.raw_content,
      ...(input.title ? { title: input.title } : {}),
      ...(input.file_name ? { fileName: input.file_name } : {}),
      ...(input.manual ? { manualType: input.manual } : {})
    });
    return {
      type: result.type,
      confidence: result.confidence,
      reasons: result.reasons,
      warnings: result.warnings
    };
  }

  // ── similar：目标条目 embedding 与同库候选向量余弦 Top-N ──
  // 降级：目标无 embedding / 候选为空 / 零向量 → 空 items（不报错）
  async similar(
    authorId: string,
    entryId: string,
    opts: { limit: number }
  ): Promise<KnowledgeSimilarResponse> {
    const entryRepo = this.dataSource.getRepository(KnowledgeEntryEntity);
    const target = await entryRepo.findOneBy({ id: entryId });
    if (!target || target.deleted_at) throw new NotFoundException('Knowledge entry not found');

    // 归属校验：global 校验 owner_id；work 校验作品归属
    if (target.library_scope === 'work') {
      const work = await this.dataSource.getRepository(WorkEntity).findOneBy({
        id: target.work_id ?? ''
      });
      if (!work || work.author_id !== authorId) {
        throw new NotFoundException('Knowledge entry not found');
      }
    } else if (target.owner_id !== authorId) {
      throw new NotFoundException('Knowledge entry not found');
    }

    const embRepo = this.dataSource.getRepository(KnowledgeEntryEmbeddingEntity);
    const targetEmb = await embRepo.findOneBy({ entry_id: entryId });
    if (!targetEmb) return { items: [] };
    const query = this.parseVector(targetEmb.embedding);
    if (query.length === 0 || query.every((x) => x === 0)) return { items: [] };

    // 同库候选：同 owner + 同 scope + 未删除 + 排除自身
    const rows = await embRepo
      .createQueryBuilder('emb')
      .innerJoin(KnowledgeEntryEntity, 'e', 'e.id = emb.entry_id')
      .where('emb.owner_id = :ownerId', { ownerId: authorId })
      .andWhere('e.deleted_at IS NULL')
      .andWhere('e.id <> :entryId', { entryId })
      .andWhere('e.library_scope = :scope', { scope: target.library_scope })
      .getMany();
    if (rows.length === 0) return { items: [] };

    const scored = rows
      .map((r) => ({
        entry_id: r.entry_id,
        score: cosineSimilarity(query, this.parseVector(r.embedding))
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit);

    if (scored.length === 0) return { items: [] };

    // 回填条目摘要
    const ids = scored.map((s) => s.entry_id);
    const entries = await entryRepo
      .createQueryBuilder('e')
      .where('e.id IN (:...ids)', { ids })
      .getMany();
    const byId = new Map(entries.map((e) => [e.id, e]));
    const items: KnowledgeSimilarItem[] = scored.map((s) => {
      const e = byId.get(s.entry_id);
      return {
        entry_id: s.entry_id,
        title: e?.title ?? '',
        entry_type: e?.entry_type as KnowledgeSimilarItem['entry_type'],
        excerpt: (e?.original_text ?? '').slice(0, 200),
        score: Number(s.score.toFixed(4))
      };
    });

    return { items };
  }

  // ── markdown-render：正文→HTML 预览（纯渲染，不落库） ──
  markdownRender(text: string): KnowledgeMarkdownRenderResponse {
    if (!text) return { html: '' };
    return { html: renderer.render(text) };
  }

  private parseVector(s: string): number[] {
    const trimmed = s.trim();
    if (trimmed.startsWith('[')) return JSON.parse(trimmed) as number[];
    return trimmed
      .split(',')
      .map((x) => Number(x.trim()))
      .filter((n) => Number.isFinite(n));
  }
}
