// M3c-3 知识库 · 结构化管线 handler（F2 §5.3）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.3、§5.4、§5.5
//
// 职责：单个条目结构化管线入口——分块→逐块结构化(报进度)→合并→大纲(小说)→向量→灵感自动关联→落库。
// 由 KnowledgeJobWorker 按 kind='structure' 分派调用；restructure 复用同一管线（D07）。
//
// 关键约定：
//  - structured/outline/structure_status/structure_error/outline_status/search_text 直接 repo 更新
//    （updateEntry 不暴露 outline/outline_status/structure_error 写入）。
//  - 失败：structure_status='failed' + structure_error，保留原文；不抛错阻塞调用方（作业已 markFailed）。
//  - 向量失败不回滚结构化（作业失败可重试）。
//  - 灵感自动关联：findSimilar 前10候选→score≥0.35→前3→写 kind='inspiration_auto'，先删旧自动关联。
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { createHash } from 'node:crypto';
import type { KnowledgeEntryType, KnowledgeEntryStructured } from '@storyforge/contracts';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { KnowledgeEntryEmbeddingEntity } from '../database/knowledge-entry-embedding.entity';
import { KnowledgeEntryLinkEntity } from '../database/knowledge-entry-link.entity';
import { KnowledgeJobService } from './jobs.processor';
import { KnowledgeEntriesService, hashContent } from './entries.service';
import { extractOutline } from './outline.extractor';
import { chunkText, mergeStructured } from './structure.provider';
import { findSimilar } from './similarity';
import {
  KNOWLEDGE_STRUCTURE_PROVIDER,
  type KnowledgeStructureProvider
} from './structure.provider';
import {
  KNOWLEDGE_EMBEDDING_PROVIDER,
  type KnowledgeEmbeddingProvider
} from './embedding.provider';

// 灵感自动关联参数（F2 §5.5，服务常量便于后续调参）
const SIMILAR_TOP_K = 10;
const SIMILAR_THRESHOLD = 0.35;
const SIMILAR_MAX_RESULTS = 3;
const EMBEDDING_DIM = 1024;
const EMBEDDING_MODEL = 'mock-bge-m3-1024';

export interface StructureHandlerInput {
  entryId: string;
  rawContent: string;
  entryType: KnowledgeEntryType;
  title?: string;
  scope: 'global' | 'work';
  workId?: string | null;
  ownerId: string;
}

@Injectable()
export class KnowledgeStructureHandler {
  constructor(
    private readonly dataSource: DataSource,
    private readonly jobService: KnowledgeJobService,
    @Inject(KNOWLEDGE_STRUCTURE_PROVIDER)
    private readonly structureProvider: KnowledgeStructureProvider,
    @Inject(KNOWLEDGE_EMBEDDING_PROVIDER)
    private readonly embeddingProvider: KnowledgeEmbeddingProvider,
    private readonly entriesService: KnowledgeEntriesService
  ) {}

  /**
   * 结构化管线入口。jobId 为空表示同步路径（restructure 直接调用，不报进度）。
   * 返回结构化结果；失败时内部捕获并落库 failed 状态，不抛错（由调用方决定作业状态）。
   */
  async handle(jobId: string | null, input: StructureHandlerInput): Promise<{
    ok: boolean;
    structured: KnowledgeEntryStructured | null;
    error?: { code: string; message: string; reason?: string };
  }> {
    const started = Date.now();
    try {
      // 1. 读条目校验未删
      const entry = await this.assertActiveEntry(input.entryId, input.ownerId);

      // 2. 分块（确定性纯函数）
      const blocks = chunkText(input.rawContent, {
        entryId: input.entryId,
        rawContent: input.rawContent,
        entryType: input.entryType,
        ...(input.title ? { title: input.title } : {}),
        relatedContexts: []
      });
      if (blocks.length === 0) {
        const emptyErr = { code: 'KNOWLEDGE_TEXT_EMPTY', message: '内容为空，无法结构化' };
        await this.markFailed(input.entryId, emptyErr);
        if (jobId) {
          await this.jobService.markFailed(jobId, emptyErr).catch(() => undefined);
        }
        return { ok: false, structured: null, error: emptyErr };
      }

      // 3. 逐块结构化 + 报进度
      const total = blocks.length;
      for (let i = 0; i < total; i++) {
        const block = blocks[i]!;
        const result = await this.structureProvider.structure({
          entryId: input.entryId,
          rawContent: block.text,
          entryType: input.entryType,
          ...(input.title ? { title: input.title } : {}),
          relatedContexts: []
        });
        block.structured = result.structured;
        block.order = i;
        if (jobId) {
          await this.jobService.reportProgress(jobId, {
            stage: 'structure',
            processed: i + 1,
            total,
            percent: Math.round(((i + 1) / total) * 100)
          });
        }
      }

      // 4. 合并
      const merged = mergeStructured(blocks, {
        entryId: input.entryId,
        rawContent: input.rawContent,
        entryType: input.entryType,
        ...(input.title ? { title: input.title } : {}),
        relatedContexts: []
      });
      const structured = merged.structured;

      // 5. 大纲（仅小说）
      let outline: Record<string, unknown> | null = null;
      let outlineStatus: string | null = null;
      if (input.entryType === 'novel') {
        const outlineResult = extractOutline({
          entryType: input.entryType,
          originalText: input.rawContent,
          structured
        });
        if (outlineResult.status === 'ready') {
          outline = outlineResult.outline as unknown as Record<string, unknown>;
          outlineStatus = 'ready';
        } else {
          outline = null;
          outlineStatus = 'failed';
        }
      }

      // 6. 向量 + 灵感自动关联
      let inspirationMeta: { completion: string; independent: boolean; matched: string[] } | null = null;
      try {
        inspirationMeta = await this.embedAndAutoLink(jobId, input, entry, structured);
      } catch {
        // 向量失败不回滚结构化（F2 §5.3 步骤6）
        inspirationMeta = null;
      }

      // 7. 落库（同事务：structured/outline/structure_status/search_text）
      await this.persist(input.entryId, structured, outline, outlineStatus, input.ownerId, inspirationMeta);

      // 8. 审计：结构化完成（controller/审计在 service 层；此处仅记录耗时供调用方）
      if (jobId) {
        await this.jobService.finishSucceeded(jobId, {
          entry_id: input.entryId,
          elapsed_ms: Date.now() - started,
          block_count: total
        });
      }

      return { ok: true, structured };
    } catch (err) {
      const error = this.toError(err);
      // 失败：structure_status='failed' + structure_error，保留原文
      await this.markFailed(input.entryId, error);
      if (jobId) {
        await this.jobService.markFailed(jobId, error).catch(() => undefined);
      }
      return { ok: false, structured: null, error };
    }
  }

  // ───────────────────────────── 内部 ─────────────────────────────

  private async assertActiveEntry(entryId: string, ownerId: string): Promise<KnowledgeEntryEntity> {
    const entry = await this.dataSource.getRepository(KnowledgeEntryEntity).findOneBy({ id: entryId });
    if (!entry || entry.deleted_at) {
      throw new Error('KNOWLEDGE_ENTRY_NOT_FOUND');
    }
    if (entry.owner_id !== ownerId) {
      throw new Error('KNOWLEDGE_ENTRY_NOT_FOUND');
    }
    return entry;
  }

  private async embedAndAutoLink(
    jobId: string | null,
    input: StructureHandlerInput,
    entry: KnowledgeEntryEntity,
    structured: KnowledgeEntryStructured
  ): Promise<{ completion: string; independent: boolean; matched: string[] }> {
    // 嵌入文本：结构化摘要 + 原文前 2000 字
    const embedText = this.buildEmbedText(entry, structured);
    const vectors = await this.embeddingProvider.embed([embedText]);
    const vector = vectors[0] ?? [];
    await this.upsertEmbedding(input.entryId, input.ownerId, embedText, vector);

    // 灵感自动关联
    if (input.entryType !== 'inspiration') {
      return { completion: '', independent: false, matched: [] };
    }

    // 查询同库候选向量（排除自身 + 未删除）
    const candidates = await this.loadCandidates(input);
    const matches = findSimilar(vector, candidates, {
      topK: SIMILAR_TOP_K,
      threshold: SIMILAR_THRESHOLD,
      maxResults: SIMILAR_MAX_RESULTS
    });
    const matched = matches.map((m) => m.entry_id);

    // 写自动关联：先删旧 inspiration_auto，再写新
    await this.replaceAutoLinks(input.entryId, matches);
    return {
      completion: matched.length > 0 ? this.buildCompletion(matches) : '',
      independent: matched.length === 0,
      matched
    };
  }

  private buildEmbedText(entry: KnowledgeEntryEntity, structured: KnowledgeEntryStructured): string {
    const parts: string[] = [entry.title];
    const s = structured as Record<string, unknown>;
    if (Array.isArray(s.sections)) {
      for (const sec of s.sections as Array<{ heading?: string; content?: string }>) {
        if (sec.heading) parts.push(sec.heading);
        if (sec.content) parts.push(sec.content);
      }
    }
    if (typeof s.key_points === 'string') parts.push(s.key_points);
    if (Array.isArray(s.key_points)) parts.push((s.key_points as string[]).join(' '));
    if (typeof s.findings === 'string') parts.push(s.findings);
    if (typeof s.plot_summary === 'string') parts.push(s.plot_summary);
    parts.push(entry.original_text.slice(0, 2000));
    return parts.filter(Boolean).join(' ');
  }

  private async upsertEmbedding(
    entryId: string,
    ownerId: string,
    sourceText: string,
    vector: number[]
  ): Promise<void> {
    const sourceHash = createHash('sha256').update(sourceText, 'utf8').digest('hex');
    const existing = await this.dataSource.getRepository(KnowledgeEntryEmbeddingEntity).findOneBy({ entry_id: entryId });
    if (existing && existing.source_hash === sourceHash) return;

    const vecStr = `[${vector.map((x) => Number(x.toFixed(8))).join(',')}]`;
    const repo = this.dataSource.getRepository(KnowledgeEntryEmbeddingEntity);
    if (existing) {
      await repo.update(entryId, {
        embedding: vecStr,
        source_hash: sourceHash,
        model: EMBEDDING_MODEL,
        dim: EMBEDDING_DIM
      });
    } else {
      await repo.save(
        repo.create({
          entry_id: entryId,
          owner_id: ownerId,
          model: EMBEDDING_MODEL,
          dim: EMBEDDING_DIM,
          embedding: vecStr,
          source_hash: sourceHash
        })
      );
    }
  }

  private async loadCandidates(input: StructureHandlerInput): Promise<Array<{
    entry_id: string;
    embedding: number[];
    library_scope: 'global' | 'work';
    work_id: string | null;
    owner_id: string;
    deleted_at: Date | null;
  }>> {
    const rows = await this.dataSource
      .getRepository(KnowledgeEntryEmbeddingEntity)
      .createQueryBuilder('emb')
      .innerJoin(KnowledgeEntryEntity, 'e', 'e.id = emb.entry_id')
      .where('emb.owner_id = :ownerId', { ownerId: input.ownerId })
      .andWhere('e.deleted_at IS NULL')
      .andWhere('e.id <> :entryId', { entryId: input.entryId })
      .andWhere('e.library_scope = :scope', { scope: input.scope })
      .getMany();
    return rows.map((r) => ({
      entry_id: r.entry_id,
      embedding: this.parseVector(r.embedding),
      library_scope: (r as unknown as { library_scope?: 'global' | 'work' }).library_scope ?? 'global',
      work_id: null,
      owner_id: r.owner_id,
      deleted_at: null
    }));
  }

  private parseVector(s: string): number[] {
    const trimmed = s.trim();
    if (trimmed.startsWith('[')) return JSON.parse(trimmed) as number[];
    return trimmed.split(',').map((x) => Number(x.trim())).filter((n) => Number.isFinite(n));
  }

  private async replaceAutoLinks(
    inspirationEntryId: string,
    matches: Array<{ entry_id: string; score: number; reason: string }>
  ): Promise<void> {
    const repo = this.dataSource.getRepository(KnowledgeEntryLinkEntity);
    // 先删该灵感条目的旧自动关联（灵感恒为 source_entry_id）
    await repo.delete({ source_entry_id: inspirationEntryId, kind: 'inspiration_auto' });
    for (const m of matches) {
      await repo.save(
        repo.create({
          owner_id: (await this.entryOwner(inspirationEntryId)),
          library_scope: 'global',
          work_id: null,
          source_entry_id: inspirationEntryId,
          target_entry_id: m.entry_id,
          kind: 'inspiration_auto',
          score: String(m.score),
          created_by: (await this.entryOwner(inspirationEntryId))
        })
      );
    }
  }

  private async entryOwner(entryId: string): Promise<string> {
    const e = await this.dataSource.getRepository(KnowledgeEntryEntity).findOneBy({ id: entryId });
    return e?.owner_id ?? '';
  }

  private buildCompletion(matches: Array<{ entry_id: string; score: number; reason: string }>): string {
    return `相似灵感：${matches.map((m) => m.entry_id).join(', ')}`;
  }

  private async persist(
    entryId: string,
    structured: KnowledgeEntryStructured,
    outline: Record<string, unknown> | null,
    outlineStatus: string | null,
    ownerId: string,
    inspirationMeta: { completion: string; independent: boolean; matched: string[] } | null
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(KnowledgeEntryEntity);
      const entity = await repo.findOneBy({ id: entryId });
      if (!entity) throw new Error('KNOWLEDGE_ENTRY_NOT_FOUND');

      // 灵感自动关联回写 structured.completion/independent/matched_entry_ids
      let finalStructured = structured;
      if (inspirationMeta && structured.entry_type === 'inspiration') {
        finalStructured = {
          ...structured,
          completion: inspirationMeta.completion,
          independent: inspirationMeta.independent,
          matched_entry_ids: inspirationMeta.matched
        } as KnowledgeEntryStructured;
      }

      entity.structured = finalStructured as unknown as Record<string, unknown>;
      entity.structure_status = 'ready';
      entity.structure_error = null;
      if (outlineStatus !== null) {
        entity.outline = outline;
        entity.outline_status = outlineStatus;
      }
      // search_text 重算（复用 entriesService 内部逻辑：标题+标签+结构化摘要+原文前2000字）
      entity.search_text = await this.computeSearchText(manager, entity, finalStructured);
      await repo.save(entity);
    });
  }

  private async computeSearchText(
    manager: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    entity: KnowledgeEntryEntity,
    structured: KnowledgeEntryStructured
  ): Promise<string> {
    // 标签名（join knowledge_entry_tags → knowledge_tags）
    const tagRows = await manager.query(
      `SELECT t.name FROM knowledge_entry_tags et
       JOIN knowledge_tags t ON t.id = et.tag_id
       WHERE et.entry_id = $1`,
      [entity.id]
    ) as Array<{ name: string }>;
    const tagNames = (tagRows ?? []).map((r) => r.name);

    const parts: string[] = [entity.title, ...tagNames];
    const s = structured as unknown as Record<string, unknown>;
    const excerpt = this.extractSummary(s);
    if (excerpt) parts.push(excerpt);
    parts.push(entity.original_text.slice(0, 2000));
    return parts.filter((p) => p && p.length > 0).join(' ');
  }

  private extractSummary(structured: Record<string, unknown>): string {
    const parts: string[] = [];
    if (Array.isArray(structured.sections)) {
      for (const s of structured.sections as Array<{ heading?: string; content?: string }>) {
        if (s.heading) parts.push(s.heading);
        if (s.content) parts.push(s.content);
      }
    }
    if (typeof structured.key_points === 'string') parts.push(structured.key_points);
    if (Array.isArray(structured.key_points)) parts.push((structured.key_points as string[]).join(' '));
    if (typeof structured.findings === 'string') parts.push(structured.findings);
    if (typeof structured.plot_summary === 'string') parts.push(structured.plot_summary);
    return parts.join(' ');
  }

  private async markFailed(entryId: string, error: { code: string; message: string; reason?: string }): Promise<void> {
    await this.dataSource.getRepository(KnowledgeEntryEntity).update(entryId, {
      structure_status: 'failed',
      structure_error: { code: error.code, message: error.message, ...(error.reason ? { reason: error.reason } : {}) }
    });
  }

  private toError(err: unknown): { code: string; message: string; reason?: string } {
    if (err instanceof Error) {
      return { code: 'KNOWLEDGE_STRUCTURE_FAILED', message: err.message };
    }
    if (typeof err === 'object' && err !== null) {
      const e = err as { code?: string; message?: string; reason?: string };
      return {
        code: e.code ?? 'KNOWLEDGE_STRUCTURE_FAILED',
        message: e.message ?? '结构化失败',
        ...(e.reason ? { reason: e.reason } : {})
      };
    }
    return { code: 'KNOWLEDGE_STRUCTURE_FAILED', message: '结构化失败' };
  }
}
