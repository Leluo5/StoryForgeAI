// M3c-3 知识库 T17 回收站与彻底删除
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.8、§4.1、F3 T17 完成标准
// 职责：回收站列表（按删除时间倒序）、恢复（清空 deleted_at 保持结构 + 同内容冲突 409）、
//       彻底删除（confirm=true 二次确认；级联删 entry_tags/links/embedding/相关作业+事件；
//       引用 entry_id 置 NULL 保留快照失效；事务原子；已删条目不参与检索）。
// 边界（L2 服务层）：纯数据访问 + 归属校验 + 业务规则；不写 controller 路由，不写前端。

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException
} from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import type {
  KnowledgeEntrySummary,
  KnowledgeSearchResponse
} from '@storyforge/contracts';
import { knowledgeErrorCode } from '@storyforge/contracts';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { KnowledgeEntryTagEntity } from '../database/knowledge-entry-tag.entity';
import { KnowledgeEntryLinkEntity } from '../database/knowledge-entry-link.entity';
import { KnowledgeEntryEmbeddingEntity } from '../database/knowledge-entry-embedding.entity';
import { KnowledgeJobEntity } from '../database/knowledge-job.entity';
import { KnowledgeTagEntity } from '../database/knowledge-tag.entity';
import { KnowledgeWorkRefEntity } from '../database/knowledge-work-ref.entity';
import { WorkEntity } from '../database/work.entity';

// 契约未定义 CONFIRM_REQUIRED（F3 T17 完成标准要求 422），按 T12 先例以本地常量补充
const CONFIRM_REQUIRED = 'CONFIRM_REQUIRED';

// 彻底删除响应（服务层返回；controller 层按契约序列化）
export interface KnowledgePurgeResult {
  id: string;
  purged_at: string;
  referenced_by: Array<{ work_id: string; work_title: string; ref_count: number }>;
}

@Injectable()
export class KnowledgeTrashService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  // ═══════════════════════════════════════════════════════════════════
  // 回收站列表（按删除时间倒序；默认排除常规列表）
  // ═══════════════════════════════════════════════════════════════════

  async listTrash(authorId: string, scope: 'global' | 'work', workId?: string): Promise<KnowledgeSearchResponse> {
    const repo = this.dataSource.getRepository(KnowledgeEntryEntity);
    const qb = repo.createQueryBuilder('k');
    qb.where('k.library_scope = :scope', { scope });
    qb.andWhere('k.deleted_at IS NOT NULL');

    if (scope === 'global') {
      qb.andWhere('k.owner_id = :authorId', { authorId });
    } else {
      if (!workId) throw new NotFoundException('work_id is required for work scope');
      const work = await this.dataSource.getRepository(WorkEntity).findOneBy({ id: workId });
      if (!work || work.author_id !== authorId) throw new NotFoundException('Work not found');
      qb.andWhere('k.work_id = :workId', { workId });
    }

    // 删除时间倒序，id 兜底稳定排序
    qb.orderBy('k.deleted_at', 'DESC').addOrderBy('k.id', 'DESC');

    const entities = await qb.getMany();
    const items: KnowledgeEntrySummary[] = [];
    for (const entity of entities) {
      items.push({
        kind: 'entry',
        id: entity.id,
        entry_type: entity.entry_type as KnowledgeEntrySummary['entry_type'],
        title: entity.title,
        excerpt: entity.original_text.slice(0, 160),
        tags: await this.loadTagNames(entity.id),
        structure_status: entity.structure_status as KnowledgeEntrySummary['structure_status'],
        ...(entity.outline_status ? { outline_status: entity.outline_status as KnowledgeEntrySummary['outline_status'] } : {}),
        favorite: entity.favorite,
        pinned: entity.pinned,
        created_at: entity.created_at.toISOString(),
        updated_at: entity.updated_at.toISOString()
      });
    }
    return { items, total: items.length, next_cursor: null };
  }

  // ═══════════════════════════════════════════════════════════════════
  // 恢复（清空 deleted_at；与库内现有同内容条目冲突 → 409）
  // ═══════════════════════════════════════════════════════════════════

  async restore(authorId: string, entryId: string): Promise<{ ok: true }> {
    return this.dataSource.transaction(async (manager) => {
      const entity = await this.mustFindTrashed(manager, authorId, entryId);
      if (!entity.deleted_at) {
        throw new ConflictException({
          code: knowledgeErrorCode.KNOWLEDGE_ENTRY_NOT_DELETED,
          message: 'Entry is not in recycle bin',
          details: { entry_id: entryId }
        });
      }
      // 恢复期间若库内新建了同内容条目 → 409（§5.8）
      const dupWhere = entity.library_scope === 'global'
        ? { owner_id: authorId, content_hash: entity.content_hash, library_scope: 'global' as const, deleted_at: IsNull() }
        : { work_id: entity.work_id ?? '', content_hash: entity.content_hash, library_scope: 'work' as const, deleted_at: IsNull() };
      const dup = await manager.getRepository(KnowledgeEntryEntity).findOneBy(dupWhere);
      if (dup) {
        throw new ConflictException({
          code: knowledgeErrorCode.KNOWLEDGE_ENTRY_DUPLICATE,
          message: 'Duplicate knowledge entry on restore',
          details: { content_hash: entity.content_hash, entry_id: dup.id }
        });
      }
      entity.deleted_at = null;
      entity.deleted_by = null;
      await manager.save(entity);
      return { ok: true };
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 彻底删除（confirm=true 二次确认；级联清理 + 引用失效；事务原子）
  // ═══════════════════════════════════════════════════════════════════

  async purge(
    authorId: string,
    entryId: string,
    input: { confirm?: boolean }
  ): Promise<KnowledgePurgeResult> {
    if (input?.confirm !== true) {
      throw new UnprocessableEntityException({
        code: CONFIRM_REQUIRED,
        message: 'Permanent deletion requires confirm=true',
        details: { entry_id: entryId }
      });
    }
    return this.dataSource.transaction(async (manager) => {
      const entity = await this.mustFindTrashed(manager, authorId, entryId);
      if (!entity.deleted_at) {
        throw new NotFoundException('Entry is not in recycle bin');
      }

      // 统计引用作品（删除前）
      const refs = await manager.getRepository(KnowledgeWorkRefEntity).find({ where: { entry_id: entryId } });
      const workIds = [...new Set(refs.map((r) => r.work_id))];
      const workTitles: Record<string, string> = {};
      if (workIds.length) {
        const works = await manager.getRepository(WorkEntity).find({ where: { id: In(workIds) } });
        for (const w of works) workTitles[w.id] = w.title;
      }
      const referenced_by = workIds.map((wid) => ({
        work_id: wid,
        work_title: workTitles[wid] ?? '',
        ref_count: refs.filter((r) => r.work_id === wid).length
      }));

      // 级联：跨条目关联（两端任一指向条目）
      const linkRepo = manager.getRepository(KnowledgeEntryLinkEntity);
      await linkRepo.delete({ source_entry_id: entryId });
      await linkRepo.delete({ target_entry_id: entryId });
      // 级联：标签关联
      await manager.getRepository(KnowledgeEntryTagEntity).delete({ entry_id: entryId });
      // 级联：向量
      await manager.getRepository(KnowledgeEntryEmbeddingEntity).delete({ entry_id: entryId });
      // 级联：相关作业（连带 job_events ON DELETE CASCADE）
      await manager.getRepository(KnowledgeJobEntity).delete({ entry_id: entryId });
      // 引用：entry_id 置 NULL（FK SET NULL 语义，保留快照 → invalid）
      await manager.getRepository(KnowledgeWorkRefEntity).update(
        { entry_id: entryId },
        { entry_id: null }
      );
      // 物理删除条目
      await manager.getRepository(KnowledgeEntryEntity).delete({ id: entryId });

      return { id: entryId, purged_at: new Date().toISOString(), referenced_by };
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 内部
  // ═══════════════════════════════════════════════════════════════════

  // 在事务内读取回收站条目（归属校验）
  private async mustFindTrashed(
    manager: EntityManager,
    authorId: string,
    entryId: string
  ): Promise<KnowledgeEntryEntity> {
    const repo = manager.getRepository(KnowledgeEntryEntity);
    const entity = await repo.findOneBy({ id: entryId });
    if (!entity) throw new NotFoundException('Knowledge entry not found');
    if (entity.library_scope === 'global') {
      if (entity.owner_id !== authorId) throw new NotFoundException('Knowledge entry not found');
    } else {
      const work = await manager.getRepository(WorkEntity).findOneBy({ id: entity.work_id ?? '' });
      if (!work || work.author_id !== authorId) throw new NotFoundException('Knowledge entry not found');
    }
    return entity;
  }

  private async loadTagNames(entryId: string): Promise<string[]> {
    const rows = await this.dataSource.getRepository(KnowledgeEntryTagEntity).find({
      where: { entry_id: entryId }
    });
    if (!rows.length) return [];
    const tagIds = rows.map((r) => r.tag_id);
    const tags = await this.dataSource.getRepository(KnowledgeTagEntity).find({
      where: { id: In(tagIds) }
    });
    return tags.map((t) => t.name).sort();
  }
}
