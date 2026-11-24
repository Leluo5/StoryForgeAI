// M3c-3 知识库 T11 条目 CRUD 与 search_text 重算（改写旧 knowledge.service）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.1、§2.2.1、§4.1
//
// 边界（L2 服务层）：纯数据访问 + 归属校验 + 业务规则；不写 controller 路由，不写前端。
// 本服务聚焦条目生命周期（创建/读取/更新/软删/恢复/收藏/置顶/版本校验）与 search_text 重算；
// 标签本体按名复用（knowledge_tags），条目-标签关联写 knowledge_entry_tags；
// 标签服务、引用/副本、回收站彻底删除、四维检索、上传解析、导入导出分别由 T15~T20 实现。

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { createHash } from 'node:crypto';
import type {
  KnowledgeEntryCreateRequest,
  KnowledgeEntryDetail,
  KnowledgeEntryPatchRequest,
  KnowledgeEntrySummary,
  KnowledgeEntryType,
  KnowledgeSearchQuery,
  KnowledgeSearchResponse
} from '@storyforge/contracts';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { KnowledgeTagEntity } from '../database/knowledge-tag.entity';
import { KnowledgeEntryTagEntity } from '../database/knowledge-entry-tag.entity';
import { WorkEntity } from '../database/work.entity';
import { classifyEntryType } from './classify';
import { normalizeTitleKey } from './knowledge.service';
import { decodeCursor, encodeCursor, KNOWLEDGE_EXCERPT_MAX } from '@storyforge/contracts';

// ───────────────────────────── 内容哈希归一化（§2.2.1） ─────────────────────────────
// content_hash = sha256( NFKC(原文) → 统一换行(CRLF/CR→LF) → 去首尾空白 )
export function normalizeContentForHash(rawContent: string): string {
  return rawContent.normalize('NFKC').replace(/\r\n?/g, '\n').trim();
}

export function hashContent(rawContent: string): string {
  return createHash('sha256').update(normalizeContentForHash(rawContent), 'utf8').digest('hex');
}

// search_text 构成：标题 + 标签名 + 结构化摘要 + 原文前 2000 字（§2.2.1）
const SEARCH_TEXT_ORIGINAL_MAX = 2000;

// 从结构化结果提取摘要文本（各类型通用：取 sections 拼接 / 五要素 / 情节摘要 / completion）
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

// 计算 search_text 聚合值
function computeSearchText(
  title: string,
  tagNames: string[],
  structured: Record<string, unknown> | null,
  originalText: string
): string {
  const excerpt = extractStructuredSummary(structured);
  const parts = [
    title,
    ...tagNames,
    excerpt,
    originalText.slice(0, SEARCH_TEXT_ORIGINAL_MAX)
  ];
  return parts.filter((p) => p && p.length > 0).join(' ');
}

// 条目 → 摘要（列表 / 检索；不含原文）
function toSummary(entity: KnowledgeEntryEntity, tagNames: string[]): KnowledgeEntrySummary {
  return {
    kind: 'entry',
    id: entity.id,
    entry_type: entity.entry_type as KnowledgeEntryType,
    title: entity.title,
    excerpt: entity.original_text.slice(0, KNOWLEDGE_EXCERPT_MAX),
    tags: tagNames,
    structure_status: entity.structure_status as KnowledgeEntrySummary['structure_status'],
    ...(entity.outline_status ? { outline_status: entity.outline_status as KnowledgeEntrySummary['outline_status'] } : {}),
    favorite: entity.favorite,
    pinned: entity.pinned,
    created_at: entity.created_at.toISOString(),
    updated_at: entity.updated_at.toISOString()
  };
}

// 条目 → 详情（含原文 / 结构化 / 大纲 / 版本）
function toDetail(entity: KnowledgeEntryEntity, tagNames: string[]): KnowledgeEntryDetail {
  const base = toSummary(entity, tagNames);
  return {
    ...base,
    original_text: entity.original_text,
    structured: entity.structured as KnowledgeEntryDetail['structured'],
    outline: entity.outline as KnowledgeEntryDetail['outline'],
    version: entity.version,
    content_hash: entity.content_hash,
    ...(entity.source_entry_id ? { source_entry_id: entity.source_entry_id } : {})
  };
}

// 归属校验（§5.1）：global 校验 owner_id；work 校验 works.author_id 且条目 work_id 一致
async function assertOwnedLibrary(
  manager: EntityManager,
  authorId: string,
  scope: 'global' | 'work',
  workId?: string
): Promise<void> {
  if (scope === 'global') return;
  if (!workId) throw new NotFoundException('work_id is required for work scope');
  const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId });
  if (!work || work.author_id !== authorId) {
    throw new NotFoundException('Work not found or not owned by current author');
  }
}

// 在事务内读取归属条目（含软删检查）
async function mustFindOwned(
  manager: EntityManager,
  authorId: string,
  entryId: string,
  scope: 'global' | 'work'
): Promise<KnowledgeEntryEntity> {
  const repo = manager.getRepository(KnowledgeEntryEntity);
  const entity = await repo.findOneBy({ id: entryId });
  if (!entity) throw new NotFoundException('Knowledge entry not found');
  if (entity.library_scope === 'global') {
    if (scope !== 'global') throw new NotFoundException('Knowledge entry not found');
    if (entity.owner_id !== authorId) throw new NotFoundException('Knowledge entry not found');
  } else {
    if (scope !== 'work') throw new NotFoundException('Knowledge entry not found');
    // 作品库条目：校验作品归属 + work_id 一致
    const work = await manager.getRepository(WorkEntity).findOneBy({ id: entity.work_id ?? '' });
    if (!work || work.author_id !== authorId) throw new NotFoundException('Knowledge entry not found');
  }
  return entity;
}

// 读取条目标签名
async function loadTagNames(manager: EntityManager, entryId: string): Promise<string[]> {
  const rows = await manager.getRepository(KnowledgeEntryTagEntity).find({
    where: { entry_id: entryId }
  });
  if (rows.length === 0) return [];
  const tagIds = rows.map((r) => r.tag_id);
  const tags = await manager.getRepository(KnowledgeTagEntity).find({ where: { id: In(tagIds) } });
  return tags.map((t) => t.name).sort();
}

// 确保标签存在并按名返回实体（按库名复用；同名同库不重复）
async function ensureTags(
  manager: EntityManager,
  authorId: string,
  scope: 'global' | 'work',
  workId: string | null,
  names: string[]
): Promise<KnowledgeTagEntity[]> {
  const tagRepo = manager.getRepository(KnowledgeTagEntity);
  const result: KnowledgeTagEntity[] = [];
  for (const rawName of names) {
    const name = rawName.trim();
    if (!name) continue;
    const nameKey = normalizeTitleKey(name);
    const where = scope === 'global'
      ? { owner_id: authorId, library_scope: scope as 'global', name_key: nameKey }
      : { work_id: workId ?? '', library_scope: scope as 'work', name_key: nameKey };
    let tag = await tagRepo.findOneBy(where);
    if (!tag) {
      tag = tagRepo.create({
        id: crypto.randomUUID(),
        owner_id: authorId,
        library_scope: scope,
        work_id: scope === 'work' ? (workId ?? '') : null,
        name,
        name_key: nameKey
      });
      await tagRepo.save(tag).catch((err: { code?: string }) => {
        // 并发同名：唯一索引冲突则重查
        if (err?.code === '23505') return tagRepo.findOneByOrFail(where);
        throw err;
      });
    }
    result.push(tag);
  }
  return result;
}

// 重置条目标签关联为给定标签集
async function replaceEntryTags(
  manager: EntityManager,
  entryId: string,
  authorId: string,
  scope: 'global' | 'work',
  workId: string | null,
  names: string[]
): Promise<string[]> {
  const linkRepo = manager.getRepository(KnowledgeEntryTagEntity);
  await linkRepo.delete({ entry_id: entryId });
  if (names.length === 0) return [];
  const tags = await ensureTags(manager, authorId, scope, workId, names);
  for (const tag of tags) {
    await linkRepo.insert({ entry_id: entryId, tag_id: tag.id }).catch((err: { code?: string }) => {
      if (err?.code === '23505') return; // 已存在
      throw err;
    });
  }
  return tags.map((t) => t.name).sort();
}

@Injectable()
export class KnowledgeEntriesService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  // ═══════════════════════════════════════════════════════════════════
  // 创建（粘贴录入；同步建条目 + 标签 + 入队结构化由 T12 处理）
  // ═══════════════════════════════════════════════════════════════════

  async createEntry(authorId: string, input: KnowledgeEntryCreateRequest): Promise<KnowledgeEntryDetail> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedLibrary(manager, authorId, input.scope, input.work_id);
      const workId = input.scope === 'work' ? (input.work_id ?? null) : null;

      // 类型识别：显式指定优先，否则 T09 启发式
      const classified = input.entry_type
        ? { type: input.entry_type as KnowledgeEntryType }
        : classifyEntryType({
            ...(input.title !== undefined ? { title: input.title } : {}),
            rawContent: input.text
          });
      const entryType = classified.type;

      const contentHash = hashContent(input.text);
      const title = (input.title ?? '').trim() || '未命名条目';

      // 去重：库级 / 作品级唯一索引命中 → 409
      const repo = manager.getRepository(KnowledgeEntryEntity);
      const dupWhere = input.scope === 'global'
        ? { owner_id: authorId, content_hash: contentHash, library_scope: 'global' as const, deleted_at: IsNull() }
        : { work_id: workId ?? '', content_hash: contentHash, library_scope: 'work' as const, deleted_at: IsNull() };
      const duplicate = await repo.findOneBy(dupWhere);
      if (duplicate) {
        throw new ConflictException({
          code: 'KNOWLEDGE_ENTRY_DUPLICATE',
          message: 'Duplicate knowledge entry',
          details: { content_hash: contentHash, entry_id: duplicate.id }
        });
      }

      const entity = repo.create();
      entity.id = crypto.randomUUID();
      entity.owner_id = authorId;
      entity.library_scope = input.scope;
      entity.work_id = workId;
      entity.entry_type = entryType;
      entity.title = title;
      entity.title_key = normalizeTitleKey(title);
      entity.original_text = input.text;
      entity.content_hash = contentHash;
      entity.search_text = '';
      entity.structure_status = 'pending';
      entity.outline_status = null;
      entity.favorite = false;
      entity.pinned = false;
      entity.pinned_at = null;
      entity.origin = 'manual';
      entity.source_entry_id = null;
      entity.version = 1;
      entity.deleted_at = null;
      entity.deleted_by = null;

      try {
        await repo.save(entity);
      } catch (err) {
        const e = err as { code?: string };
        if (e?.code === '23505') {
          throw new ConflictException({
            code: 'KNOWLEDGE_ENTRY_DUPLICATE',
            message: 'Duplicate knowledge entry',
            details: { content_hash: contentHash }
          });
        }
        throw err;
      }

      const tagNames = input.tags ?? [];
      await replaceEntryTags(manager, entity.id, authorId, input.scope, workId, tagNames);

      // 初始 search_text
      const finalTags = await loadTagNames(manager, entity.id);
      entity.search_text = computeSearchText(title, finalTags, entity.structured, entity.original_text);
      await repo.save(entity);

      return toDetail(entity, finalTags);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 读取（详情按 library_scope 权限）
  // ═══════════════════════════════════════════════════════════════════

  async getEntry(
    authorId: string,
    entryId: string,
    opts: { scope: 'global' | 'work' }
  ): Promise<KnowledgeEntryDetail> {
    return this.dataSource.transaction(async (manager) => {
      const entity = await mustFindOwned(manager, authorId, entryId, opts.scope);
      if (entity.deleted_at) throw new NotFoundException('Knowledge entry not found');
      const tags = await loadTagNames(manager, entity.id);
      return toDetail(entity, tags);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 更新（乐观锁 + search_text 重算 + 标签差异）
  // ═══════════════════════════════════════════════════════════════════

  async updateEntry(
    authorId: string,
    entryId: string,
    patch: KnowledgeEntryPatchRequest
  ): Promise<KnowledgeEntryDetail> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(KnowledgeEntryEntity);
      const entity = await repo.findOneBy({ id: entryId });
      if (!entity || entity.deleted_at) throw new NotFoundException('Knowledge entry not found');

      // 乐观锁（§4.1 / §8.2）：expected_version 与当前版本不符 → 409
      if (patch.expected_version !== undefined && patch.expected_version !== entity.version) {
        throw new ConflictException({
          code: 'KNOWLEDGE_VERSION_CONFLICT',
          message: 'Knowledge entry version conflict',
          details: { current_version: entity.version }
        });
      }

      const scope = entity.library_scope as 'global' | 'work';
      const workId = entity.work_id;

      // 归属校验（作品库再校验作品归属）
      if (scope === 'work') {
        const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId ?? '' });
        if (!work || work.author_id !== authorId) throw new NotFoundException('Knowledge entry not found');
      } else if (entity.owner_id !== authorId) {
        throw new NotFoundException('Knowledge entry not found');
      }

      let dirty = false;
      if (patch.title !== undefined) {
        entity.title = patch.title.trim() || '未命名条目';
        entity.title_key = normalizeTitleKey(entity.title);
        dirty = true;
      }
      if (patch.original_text !== undefined) {
        entity.original_text = patch.original_text;
        entity.content_hash = hashContent(patch.original_text);
        dirty = true;
      }
      if (patch.structured !== undefined) {
        entity.structured = patch.structured as Record<string, unknown>;
        entity.structure_status = 'ready';
        dirty = true;
      }
      if (patch.outline !== undefined) {
        entity.outline = patch.outline as Record<string, unknown>;
        entity.outline_status = 'ready';
        dirty = true;
      }
      if (patch.entry_type !== undefined) {
        entity.entry_type = patch.entry_type;
        dirty = true;
      }

      let tagNames = await loadTagNames(manager, entity.id);
      if (patch.tags !== undefined) {
        tagNames = await replaceEntryTags(manager, entity.id, authorId, scope, workId, patch.tags);
        dirty = true;
      }

      if (dirty) {
        entity.version += 1;
        entity.search_text = computeSearchText(entity.title, tagNames, entity.structured, entity.original_text);
        await repo.save(entity);
      }

      return toDetail(entity, tagNames);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // 列表（四维过滤 + 游标分页；返回摘要不含原文）
  // ═══════════════════════════════════════════════════════════════════

  async listEntries(authorId: string, query: Partial<KnowledgeSearchQuery>): Promise<KnowledgeSearchResponse> {
    if (!query.scope) throw new NotFoundException('scope is required');
    const scope = query.scope;
    const timeField = query.time_field ?? 'created_at';
    const limit = query.limit ?? 50;

    const repo = this.dataSource.getRepository(KnowledgeEntryEntity);
    const qb = repo.createQueryBuilder('k');
    qb.where('k.library_scope = :scope', { scope });

    if (scope === 'global') {
      qb.andWhere('k.owner_id = :authorId', { authorId });
    } else {
      if (!query.work_id) throw new NotFoundException('work_id is required for work scope');
      // 作品归属校验
      const work = await this.dataSource.getRepository(WorkEntity).findOneBy({ id: query.work_id });
      if (!work || work.author_id !== authorId) throw new NotFoundException('Work not found');
      qb.andWhere('k.work_id = :workId', { workId: query.work_id });
    }

    if (query.deleted === true) {
      qb.andWhere('k.deleted_at IS NOT NULL');
    } else {
      qb.andWhere('k.deleted_at IS NULL');
    }

    if (query.keyword) {
      qb.andWhere('k.search_text ILIKE :kw', { kw: `%${query.keyword}%` });
    }
    if (query.types && query.types.length > 0) {
      qb.andWhere('k.entry_type = ANY(:types)', { types: query.types });
    }
    if (query.favorite !== undefined) {
      qb.andWhere('k.favorite = :fav', { fav: query.favorite });
    }
    if (query.pinned !== undefined) {
      qb.andWhere('k.pinned = :pin', { pin: query.pinned });
    }
    if (query.time_from) {
      const field = timeField === 'updated_at' ? 'k.updated_at' : 'k.created_at';
      qb.andWhere(`${field} >= :from`, { from: query.time_from });
    }
    if (query.time_to) {
      const field = timeField === 'updated_at' ? 'k.updated_at' : 'k.created_at';
      qb.andWhere(`${field} < :to`, { to: query.time_to });
    }
    // 标签过滤：EXISTS 子查询
    if (query.tag_ids && query.tag_ids.length > 0) {
      qb.andWhere(
        `EXISTS (SELECT 1 FROM knowledge_entry_tags ket WHERE ket.entry_id = k.id AND ket.tag_id = ANY(:tagIds))`,
        { tagIds: query.tag_ids }
      );
    }
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      if (decoded) {
        qb.andWhere(
          `(k.pinned DESC, COALESCE(k.pinned_at, k.updated_at) DESC, k.id ASC) < (:pin, :cursorAt, :cursorId)`,
          { pin: false, cursorAt: new Date(decoded.updatedAt), cursorId: decoded.id }
        );
      }
    }

    // 排序：pinned DESC, COALESCE(pinned_at, updated_at) DESC, id ASC
    qb.orderBy('k.pinned', 'DESC')
      .addOrderBy('COALESCE(k.pinned_at, k.updated_at)', 'DESC')
      .addOrderBy('k.id', 'ASC')
      .limit(limit + 1);

    const entities = await qb.getMany();
    const hasMore = entities.length > limit;
    const page = hasMore ? entities.slice(0, limit) : entities;

    const summaries: KnowledgeEntrySummary[] = [];
    for (const entity of page) {
      const tags = await this.loadTagsForEntries(entity.id);
      summaries.push(toSummary(entity, tags));
    }

    const nextCursor = hasMore && page.length > 0
      ? encodeCursor(page[page.length - 1]!.updated_at.toISOString(), page[page.length - 1]!.id)
      : null;

    return { items: summaries, total: summaries.length, next_cursor: nextCursor };
  }

  private async loadTagsForEntries(entryId: string): Promise<string[]> {
    const rows = await this.dataSource.getRepository(KnowledgeEntryTagEntity).find({
      where: { entry_id: entryId }
    });
    if (rows.length === 0) return [];
    const tagIds = rows.map((r) => r.tag_id);
    const tags = await this.dataSource.getRepository(KnowledgeTagEntity).find({
      where: { id: In(tagIds) }
    });
    return tags.map((t) => t.name).sort();
  }

  // ═══════════════════════════════════════════════════════════════════
  // 软删 / 恢复 / 收藏 / 置顶
  // ═══════════════════════════════════════════════════════════════════

  async softDelete(authorId: string, entryId: string): Promise<{ ok: true }> {
    return this.dataSource.transaction(async (manager) => {
      const entity = await this.mustFindActive(manager, authorId, entryId);
      entity.deleted_at = new Date();
      entity.deleted_by = authorId;
      await manager.save(entity);
      return { ok: true };
    });
  }

  async restore(authorId: string, entryId: string): Promise<{ ok: true }> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(KnowledgeEntryEntity);
      const entity = await repo.findOneBy({ id: entryId });
      if (!entity) throw new NotFoundException('Knowledge entry not found');
      if (entity.owner_id !== authorId && entity.library_scope !== 'global') {
        // 作品条目校验作品归属
        const work = await manager.getRepository(WorkEntity).findOneBy({ id: entity.work_id ?? '' });
        if (!work || work.author_id !== authorId) throw new NotFoundException('Knowledge entry not found');
      }
      if (!entity.deleted_at) {
        throw new ConflictException({
          code: 'KNOWLEDGE_ENTRY_NOT_DELETED',
          message: 'Entry is not in recycle bin',
          details: { entry_id: entryId }
        });
      }
      entity.deleted_at = null;
      entity.deleted_by = null;
      await manager.save(entity);
      return { ok: true };
    });
  }

  async setFlags(
    authorId: string,
    entryId: string,
    flags: { favorite?: boolean; pinned?: boolean }
  ): Promise<{ favorite: boolean; pinned: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const entity = await this.mustFindActive(manager, authorId, entryId);
      if (flags.favorite !== undefined) entity.favorite = flags.favorite;
      if (flags.pinned !== undefined) {
        entity.pinned = flags.pinned;
        entity.pinned_at = flags.pinned ? new Date() : null;
      }
      await manager.save(entity);
      return { favorite: entity.favorite, pinned: entity.pinned };
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // search_text 重算（结构化完成 / 标签变更后调用）
  // ═══════════════════════════════════════════════════════════════════

  async refreshSearchText(authorId: string, entryId: string): Promise<{ ok: true }> {
    return this.dataSource.transaction(async (manager) => {
      const entity = await this.mustFindActive(manager, authorId, entryId);
      const tagNames = await loadTagNames(manager, entity.id);
      entity.search_text = computeSearchText(entity.title, tagNames, entity.structured, entity.original_text);
      await manager.save(entity);
      return { ok: true };
    });
  }

  private async mustFindActive(
    manager: EntityManager,
    authorId: string,
    entryId: string
  ): Promise<KnowledgeEntryEntity> {
    const entity = await mustFindOwned(manager, authorId, entryId, 'global').catch(() => null);
    if (entity) return entity;
    // 作品条目路径
    const repo = manager.getRepository(KnowledgeEntryEntity);
    const workEntry = await repo.findOneBy({ id: entryId });
    if (!workEntry) throw new NotFoundException('Knowledge entry not found');
    if (workEntry.library_scope === 'work') {
      const work = await manager.getRepository(WorkEntity).findOneBy({ id: workEntry.work_id ?? '' });
      if (!work || work.author_id !== authorId) throw new NotFoundException('Knowledge entry not found');
      return workEntry;
    }
    throw new NotFoundException('Knowledge entry not found');
  }
}


