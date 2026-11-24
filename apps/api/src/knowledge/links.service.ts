// M3c-3 知识库 T15 跨条目关联服务（改写旧 linker 相关逻辑）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.3、§2.2.5
// 职责：跨条目关联的建立 / 断开；双向 OR 语义（A→B 与 B→A 等价）；同条目内防重；
//       两端同库校验；关联计数与列表按目标端返回。
// 边界（L2 服务层）：纯数据访问 + 归属校验 + 业务规则；不写 controller 路由，不写前端。

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type { KnowledgeLink } from '@storyforge/contracts';
import { knowledgeErrorCode } from '@storyforge/contracts';
import { KnowledgeEntryLinkEntity } from '../database/knowledge-entry-link.entity';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { WorkEntity } from '../database/work.entity';

@Injectable()
export class KnowledgeLinksService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  // 读取归属条目（含软删检查），返回条目用于同库校验
  private async mustFindActiveEntry(
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

  // ───────────────────────────── 条目全部关联（双向） ─────────────────────────────

  async listLinks(authorId: string, entryId: string): Promise<KnowledgeLink[]> {
    return this.dataSource.transaction(async (manager) => {
      await this.mustFindActiveEntry(manager, authorId, entryId);
      const repo = manager.getRepository(KnowledgeEntryLinkEntity);
      // 双向：source = entryId OR target = entryId
      const rows = await repo
        .createQueryBuilder('l')
        .where('l.source_entry_id = :eid OR l.target_entry_id = :eid', { eid: entryId })
        .orderBy('l.created_at', 'DESC')
        .getMany();

      const result: KnowledgeLink[] = [];
      for (const row of rows) {
        const otherId = row.source_entry_id === entryId ? row.target_entry_id : row.source_entry_id;
        const other = await manager.getRepository(KnowledgeEntryEntity).findOneBy({ id: otherId });
        if (!other) continue; // 目标条目已删，跳过
        const source = row.source_entry_id === entryId ? await manager.getRepository(KnowledgeEntryEntity).findOneBy({ id: row.source_entry_id }) : other;
        const target = row.source_entry_id === entryId ? other : await manager.getRepository(KnowledgeEntryEntity).findOneBy({ id: row.target_entry_id });
        result.push({
          id: row.id,
          source_entry_id: row.source_entry_id,
          target_entry_id: row.target_entry_id,
          kind: row.kind as KnowledgeLink['kind'],
          ...(row.score !== null && row.score !== undefined ? { score: Number(row.score) } : {}),
          source_title: source?.title ?? '',
          target_title: target?.title ?? '',
          created_at: row.created_at.toISOString()
        });
      }
      return result;
    });
  }

  // ───────────────────────────── 手动建立关联 ─────────────────────────────

  async createLink(
    authorId: string,
    input: { source_entry_id: string; target_entry_id: string }
  ): Promise<KnowledgeLink> {
    return this.dataSource.transaction(async (manager) => {
      if (input.source_entry_id === input.target_entry_id) {
        throw new ConflictException({
          code: knowledgeErrorCode.KNOWLEDGE_LINK_SELF,
          message: '不能与条目自身建立关联',
          details: {}
        });
      }
      const source = await this.mustFindActiveEntry(manager, authorId, input.source_entry_id);
      const target = await this.mustFindActiveEntry(manager, authorId, input.target_entry_id);

      // 两端同库校验：同 library_scope，作品库还需同 work_id
      const sameScope = source.library_scope === target.library_scope;
      const sameWork = source.library_scope !== 'work' || (source.work_id !== null && source.work_id === target.work_id);
      if (!sameScope || !sameWork) {
        throw new ConflictException({
          code: knowledgeErrorCode.KNOWLEDGE_LINK_CROSS_LIBRARY,
          message: '关联两端必须属于同一库',
          details: {}
        });
      }

      const repo = manager.getRepository(KnowledgeEntryLinkEntity);
      // 双向幂等：A→B 或 B→A 已存在则返回既有（409 携带既有 id，F2 §4.3 约定）
      const existing = await repo
        .createQueryBuilder('l')
        .where(
          '(l.source_entry_id = :a AND l.target_entry_id = :b) OR (l.source_entry_id = :b AND l.target_entry_id = :a)',
          { a: input.source_entry_id, b: input.target_entry_id }
        )
        .andWhere('l.kind = :kind', { kind: 'manual' })
        .getOne();
      if (existing) {
        throw new ConflictException({
          code: knowledgeErrorCode.KNOWLEDGE_LINK_EXISTS,
          message: '关联已存在',
          details: { link_id: existing.id }
        });
      }

      const link = repo.create({
        id: randomUUID(),
        owner_id: authorId,
        library_scope: source.library_scope,
        work_id: source.work_id,
        source_entry_id: input.source_entry_id,
        target_entry_id: input.target_entry_id,
        kind: 'manual',
        score: null,
        created_by: authorId
      });
      await repo.save(link).catch((err: { code?: string }) => {
        if (err?.code === '23505') {
          throw new ConflictException({
            code: knowledgeErrorCode.KNOWLEDGE_LINK_EXISTS,
            message: '关联已存在',
            details: {}
          });
        }
        throw err;
      });

      return {
        id: link.id,
        source_entry_id: link.source_entry_id,
        target_entry_id: link.target_entry_id,
        kind: 'manual',
        source_title: source.title,
        target_title: target.title,
        created_at: link.created_at.toISOString()
      };
    });
  }

  // ───────────────────────────── 解除关联（幂等） ─────────────────────────────

  async deleteLink(authorId: string, linkId: string): Promise<{ ok: true }> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(KnowledgeEntryLinkEntity);
      const link = await repo.findOneBy({ id: linkId });
      if (!link) return { ok: true }; // 幂等：不存在返回 200 当前状态
      if (link.owner_id !== authorId) throw new NotFoundException('Link not found');
      await repo.remove(link);
      return { ok: true };
    });
  }
}
