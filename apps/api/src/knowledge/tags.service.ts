// M3c-3 知识库 T15 标签服务（改写旧 linker 相关逻辑）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.2、§2.2.3、§2.2.4
// 职责：标签 CRUD 与重命名（重命名批量刷新相关条目 search_text）；
//       标签删除级联清理条目关联，不删除条目本身；同名标签按库隔离（大小写不敏感）。
// 边界（L2 服务层）：纯数据访问 + 归属校验 + 业务规则；不写 controller 路由，不写前端。

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { DataSource, EntityManager, In, Not } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type { KnowledgeTag } from '@storyforge/contracts';
import { knowledgeErrorCode } from '@storyforge/contracts';
import { KnowledgeTagEntity } from '../database/knowledge-tag.entity';
import { KnowledgeEntryTagEntity } from '../database/knowledge-entry-tag.entity';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { WorkEntity } from '../database/work.entity';
import { normalizeTitleKey } from './knowledge.service';

// search_text 构成（与 entries.service 的 computeSearchText 一致，避免循环依赖）
const SEARCH_TEXT_ORIGINAL_MAX = 2000;

function extractStructuredSummary(structured: Record<string, unknown> | null): string {
  if (!structured) return '';
  const parts: string[] = [];
  if (Array.isArray(structured.sections)) {
    for (const s of structured.sections as Array<{ heading?: string; content?: string }>) {
      if (s.heading) parts.push(s.heading);
      if (s.content) parts.push(s.content);
    }
  }
  if (typeof structured.key_points === 'string') parts.push(structured.key_points);
  if (Array.isArray(structured.key_points)) {
    for (const k of structured.key_points as string[]) parts.push(k);
  }
  if (typeof structured.findings === 'string') parts.push(structured.findings);
  if (typeof structured.plot_summary === 'string') parts.push(structured.plot_summary);
  if (typeof structured.completion === 'string') parts.push(structured.completion);
  return parts.join(' ');
}

function computeSearchText(
  title: string,
  tagNames: string[],
  structured: Record<string, unknown> | null,
  originalText: string
): string {
  const excerpt = extractStructuredSummary(structured);
  const parts = [title, ...tagNames, excerpt, originalText.slice(0, SEARCH_TEXT_ORIGINAL_MAX)];
  return parts.filter((p) => p && p.length > 0).join(' ');
}

// 库归属校验：global 校验 owner_id；work 校验 works.author_id
async function assertOwnedLibrary(
  manager: EntityManager,
  authorId: string,
  scope: 'global' | 'work',
  workId?: string | null
): Promise<void> {
  if (scope === 'global') return;
  if (!workId) throw new NotFoundException('work_id is required for work scope');
  const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId });
  if (!work || work.author_id !== authorId) {
    throw new NotFoundException('Work not found or not owned by current author');
  }
}

@Injectable()
export class KnowledgeTagsService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  // 标签唯一性查询条件（按库隔离 + 大小写不敏感 name_key）
  private tagWhere(
    authorId: string,
    scope: 'global' | 'work',
    workId: string | null,
    nameKey: string
  ): { owner_id?: string; library_scope: 'global' | 'work'; work_id?: string; name_key: string } {
    return scope === 'global'
      ? { owner_id: authorId, library_scope: 'global' as const, name_key: nameKey }
      : { work_id: workId ?? '', library_scope: 'work' as const, name_key: nameKey };
  }

  // ───────────────────────────── 标签列表（含条目数） ─────────────────────────────

  async listTags(
    authorId: string,
    scope: 'global' | 'work',
    workId?: string
  ): Promise<KnowledgeTag[]> {
    const repo = this.dataSource.getRepository(KnowledgeTagEntity);
    const where = scope === 'global'
      ? { owner_id: authorId, library_scope: scope }
      : { work_id: workId ?? '', library_scope: scope };
    const tags = await repo.find({ where, order: { name: 'ASC' } });

    // 每个标签的条目数（软删不计入？F2 未明说，统一按未删除条目计数）
    const result: KnowledgeTag[] = [];
    for (const tag of tags) {
      const count = await this.dataSource
        .getRepository(KnowledgeEntryTagEntity)
        .createQueryBuilder('ket')
        .innerJoin(KnowledgeEntryEntity, 'k', 'k.id = ket.entry_id')
        .where('ket.tag_id = :tagId', { tagId: tag.id })
        .andWhere('k.deleted_at IS NULL')
        .getCount();
      result.push({ id: tag.id, name: tag.name, entry_count: count });
    }
    return result;
  }

  // ───────────────────────────── 新建标签 ─────────────────────────────

  async createTag(
    authorId: string,
    input: { scope: 'global' | 'work'; work_id?: string; name: string }
  ): Promise<KnowledgeTag> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedLibrary(manager, authorId, input.scope, input.work_id);
      const name = input.name.trim();
      if (!name) throw new NotFoundException('Tag name is required');
      const nameKey = normalizeTitleKey(name);
      const repo = manager.getRepository(KnowledgeTagEntity);
      const where = this.tagWhere(authorId, input.scope, input.work_id ?? null, nameKey);
      const existing = await repo.findOneBy(where);
      if (existing) {
        throw new ConflictException({
          code: knowledgeErrorCode.KNOWLEDGE_TAG_NAME_EXISTS,
          message: '同名标签已存在',
          details: { tag_id: existing.id }
        });
      }
      const tag = repo.create({
        id: randomUUID(),
        owner_id: authorId,
        library_scope: input.scope,
        work_id: input.scope === 'work' ? (input.work_id ?? '') : null,
        name,
        name_key: nameKey
      });
      await repo.save(tag).catch((err: { code?: string }) => {
        // 并发同名：唯一索引冲突则重查并报 409
        if (err?.code === '23505') {
          throw new ConflictException({
            code: knowledgeErrorCode.KNOWLEDGE_TAG_NAME_EXISTS,
            message: '同名标签已存在',
            details: {}
          });
        }
        throw err;
      });
      return { id: tag.id, name: tag.name, entry_count: 0 };
    });
  }

  // ───────────────────────────── 重命名（刷新相关条目 search_text） ─────────────────────────────

  async renameTag(authorId: string, tagId: string, newName: string): Promise<KnowledgeTag> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(KnowledgeTagEntity);
      const tag = await repo.findOneBy({ id: tagId });
      if (!tag || tag.owner_id !== authorId) {
        throw new NotFoundException('Tag not found');
      }
      const name = newName.trim();
      if (!name) throw new NotFoundException('Tag name is required');
      const nameKey = normalizeTitleKey(name);

      // 同名（不同标签）冲突：排除自身
      const dupWhere = this.tagWhere(authorId, tag.library_scope as 'global' | 'work', tag.work_id, nameKey);
      const dup = await repo.findOne({ where: { ...dupWhere, id: Not(tag.id) } });
      if (dup) {
        throw new ConflictException({
          code: knowledgeErrorCode.KNOWLEDGE_TAG_NAME_EXISTS,
          message: '同名标签已存在',
          details: { tag_id: dup.id }
        });
      }

      const oldName = tag.name;
      tag.name = name;
      tag.name_key = nameKey;
      await repo.save(tag).catch((err: { code?: string }) => {
        if (err?.code === '23505') {
          throw new ConflictException({
            code: knowledgeErrorCode.KNOWLEDGE_TAG_NAME_EXISTS,
            message: '同名标签已存在',
            details: {}
          });
        }
        throw err;
      });

      // 刷新绑定该标签的所有条目 search_text（名称变了，标签名进入 search_text）
      const bound = await manager.getRepository(KnowledgeEntryTagEntity).find({ where: { tag_id: tag.id } });
      if (bound.length > 0) {
        const entryIds = bound.map((b) => b.entry_id);
        await this.refreshSearchTextForEntries(manager, entryIds);
      }

      const count = bound.length;
      return { id: tag.id, name: tag.name, entry_count: count };
    });
  }

  // ───────────────────────────── 删除标签（级联清理，不删条目） ─────────────────────────────

  async deleteTag(authorId: string, tagId: string): Promise<{ ok: true }> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(KnowledgeTagEntity);
      const tag = await repo.findOneBy({ id: tagId });
      if (!tag || tag.owner_id !== authorId) {
        throw new NotFoundException('Tag not found');
      }
      // 记录绑定条目以刷新 search_text
      const bound = await manager.getRepository(KnowledgeEntryTagEntity).find({ where: { tag_id: tag.id } });
      const entryIds = bound.map((b) => b.entry_id);
      // FK ON DELETE CASCADE 清理 entry_tags；显式 delete 保证删除顺序
      await manager.getRepository(KnowledgeEntryTagEntity).delete({ tag_id: tag.id });
      await repo.remove(tag);
      if (entryIds.length > 0) {
        await this.refreshSearchTextForEntries(manager, entryIds);
      }
      return { ok: true };
    });
  }

  // 对一组条目重算 search_text（读取各条目全部标签名后重算）
  private async refreshSearchTextForEntries(
    manager: EntityManager,
    entryIds: string[]
  ): Promise<void> {
    const entryRepo = manager.getRepository(KnowledgeEntryEntity);
    const etRepo = manager.getRepository(KnowledgeEntryTagEntity);
    const tagRepo = manager.getRepository(KnowledgeTagEntity);
    for (const entryId of entryIds) {
      const entry = await entryRepo.findOneBy({ id: entryId });
      if (!entry) continue;
      const rows = await etRepo.find({ where: { entry_id: entryId } });
      const tagIds = rows.map((r) => r.tag_id);
      const tags = tagIds.length > 0 ? await tagRepo.find({ where: { id: In(tagIds) } }) : [];
      const tagNames = tags.map((t) => t.name).sort();
      entry.search_text = computeSearchText(entry.title, tagNames, entry.structured, entry.original_text);
      await entryRepo.save(entry);
    }
  }
}
