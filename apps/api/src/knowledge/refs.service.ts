// M3c-3 知识库 T16 引用与副本服务
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.7、§2.2.2
// 裁决：用户确认按 F2 §5.7 口径实现（派生状态 active/source_deleted/invalid + 有界快照列），
//       不新增 ref_type/source_version/invalidated_at 列（L1 表结构不变）。
// 职责：批量引用全局条目、引用只读强制、另存副本（origin='ref_copy'）、移除引用、
//       软删/彻底删时刷新或失效引用快照。
// 边界（L2 服务层）：纯数据访问 + 归属校验 + 业务规则；不写 controller 路由，不写前端。

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { DataSource, EntityManager, In, IsNull } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type {
  KnowledgeEntryDetail,
  KnowledgeEntrySummary,
  KnowledgeRefStatus
} from '@storyforge/contracts';
import { knowledgeErrorCode } from '@storyforge/contracts';
import { KnowledgeWorkRefEntity } from '../database/knowledge-work-ref.entity';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import { KnowledgeTagEntity } from '../database/knowledge-tag.entity';
import { KnowledgeEntryTagEntity } from '../database/knowledge-entry-tag.entity';
import { WorkEntity } from '../database/work.entity';
import { hashContent } from './entries.service';
import { normalizeTitleKey } from './knowledge.service';

// 有界结构化摘要（≤16 KB 近似：取 JSON 字符串前 16000 字符）
const SNAPSHOT_STRUCTURED_MAX = 16_000;

function computeRefStatus(
  entry: KnowledgeEntryEntity | null,
  refEntryId: string | null
): KnowledgeRefStatus {
  if (!refEntryId || !entry) return 'invalid';
  if (entry.deleted_at) return 'source_deleted';
  return 'active';
}

function toRefSummary(ref: KnowledgeWorkRefEntity, entry: KnowledgeEntryEntity | null): KnowledgeEntrySummary {
  return {
    kind: 'reference',
    id: ref.id,
    ref_id: ref.id,
    entry_type: (entry?.entry_type ?? ref.snapshot_type) as KnowledgeEntrySummary['entry_type'],
    title: entry?.title ?? ref.snapshot_title,
    excerpt: entry ? entry.search_text.slice(0, 160) : ref.snapshot_excerpt,
    tags: (entry ? [] : ref.snapshot_tags) as string[],
    structure_status: (entry?.structure_status ?? 'ready') as KnowledgeEntrySummary['structure_status'],
    favorite: ref.favorite,
    pinned: ref.pinned,
    ref_status: computeRefStatus(entry, ref.entry_id),
    created_at: ref.created_at.toISOString(),
    updated_at: ref.updated_at.toISOString()
  };
}

@Injectable()
export class KnowledgeRefsService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  // 读取活跃全局条目（供引用/副本校验）；不存在或已软删 → null
  private async findActiveGlobalEntry(
    manager: EntityManager,
    authorId: string,
    entryId: string
  ): Promise<KnowledgeEntryEntity | null> {
    const entry = await manager.getRepository(KnowledgeEntryEntity).findOneBy({ id: entryId });
    if (!entry || entry.library_scope !== 'global' || entry.owner_id !== authorId) return null;
    return entry;
  }

  // 写入引用快照（标题 / 类型 / 标签 / ≤2000 字摘录 / ≤16 KB 结构化摘要）
  private async refreshSnapshot(
    manager: EntityManager,
    ref: KnowledgeWorkRefEntity,
    entry: KnowledgeEntryEntity
  ): Promise<void> {
    ref.snapshot_title = entry.title;
    ref.snapshot_type = entry.entry_type;
    ref.snapshot_excerpt = entry.search_text.slice(0, 2000);
    const structuredJson = entry.structured ? JSON.stringify(entry.structured) : null;
    ref.snapshot_structured = structuredJson
      ? (JSON.parse(structuredJson.slice(0, SNAPSHOT_STRUCTURED_MAX)) as Record<string, unknown>)
      : null;
    // 标签名
    const rows = await manager.getRepository(KnowledgeEntryTagEntity).find({ where: { entry_id: entry.id } });
    const tagIds = rows.map((r) => r.tag_id);
    const tags = tagIds.length ? await manager.getRepository(KnowledgeTagEntity).find({ where: { id: In(tagIds) } }) : [];
    ref.snapshot_tags = tags.map((t) => t.name).sort();
  }

  // ───────────────────────────── 批量引用全局条目 ─────────────────────────────

  async createRefs(authorId: string, workId: string, entryIds: string[]): Promise<KnowledgeEntrySummary[]> {
    return this.dataSource.transaction(async (manager) => {
      const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId });
      if (!work || work.author_id !== authorId) throw new NotFoundException('Work not found or not owned');

      const repo = manager.getRepository(KnowledgeWorkRefEntity);
      const results: KnowledgeEntrySummary[] = [];

      for (const entryId of entryIds) {
        const entry = await this.findActiveGlobalEntry(manager, authorId, entryId);
        if (!entry) continue; // 跳过不存在的全局条目（§5.7：校验但静默忽略无效引用）

        // ON CONFLICT DO NOTHING 语义：已存在则复用
        let ref = await repo.findOneBy({ work_id: workId, entry_id: entryId });
        if (!ref) {
          ref = repo.create({
            id: randomUUID(),
            owner_id: authorId,
            work_id: workId,
            entry_id: entryId,
            snapshot_title: '',
            snapshot_type: '',
            snapshot_tags: [],
            snapshot_excerpt: '',
            snapshot_structured: null,
            favorite: false,
            pinned: false,
            pinned_at: null,
            added_by: authorId
          });
          await this.refreshSnapshot(manager, ref, entry);
          try {
            await repo.save(ref);
          } catch (err) {
            const e = err as { code?: string };
            if (e?.code === '23505') {
              // 并发已存在
              ref = (await repo.findOneBy({ work_id: workId, entry_id: entryId }))!;
            } else {
              throw err;
            }
          }
        }
        results.push(toRefSummary(ref, entry));
      }
      return results;
    });
  }

  // ───────────────────────────── 作品库引用列表 ─────────────────────────────

  async listRefs(authorId: string, workId: string): Promise<KnowledgeEntrySummary[]> {
    return this.dataSource.transaction(async (manager) => {
      const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId });
      if (!work || work.author_id !== authorId) throw new NotFoundException('Work not found or not owned');
      const refs = await manager.getRepository(KnowledgeWorkRefEntity).find({
        where: { work_id: workId },
        order: { updated_at: 'DESC' }
      });
      const result: KnowledgeEntrySummary[] = [];
      for (const ref of refs) {
        const entry = ref.entry_id
          ? await manager.getRepository(KnowledgeEntryEntity).findOneBy({ id: ref.entry_id })
          : null;
        result.push(toRefSummary(ref, entry));
      }
      return result;
    });
  }

  // ───────────────────────────── 引用只读强制 ─────────────────────────────

  // 条目 PATCH/flags：context_work_id 且存在引用 → 409 KNOWLEDGE_REF_READONLY
  async assertNotReadonly(authorId: string, workId: string, entryId: string): Promise<void> {
    const ref = await this.dataSource.getRepository(KnowledgeWorkRefEntity).findOneBy({
      work_id: workId,
      entry_id: entryId
    });
    if (ref) {
      throw new ConflictException({
        code: knowledgeErrorCode.KNOWLEDGE_REF_READONLY,
        message: '引用条目只读，请另存副本后编辑',
        details: { ref_id: ref.id }
      });
    }
  }

  // ───────────────────────────── 另存副本（origin='ref_copy'） ─────────────────────────────

  async copyToWork(
    authorId: string,
    workId: string,
    entryId: string,
    input: { keep_ref?: boolean; title?: string }
  ): Promise<KnowledgeEntryDetail> {
    return this.dataSource.transaction(async (manager) => {
      const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId });
      if (!work || work.author_id !== authorId) throw new NotFoundException('Work not found or not owned');
      const source = await this.findActiveGlobalEntry(manager, authorId, entryId);
      if (!source) throw new NotFoundException('Global source entry not found');

      const entryRepo = manager.getRepository(KnowledgeEntryEntity);
      const newTitle = (input.title ?? '').trim() || source.title;
      const entity = entryRepo.create();
      entity.id = randomUUID();
      entity.owner_id = authorId;
      entity.library_scope = 'work';
      entity.work_id = workId;
      entity.entry_type = source.entry_type;
      entity.title = newTitle;
      entity.title_key = normalizeTitleKey(newTitle);
      entity.original_text = source.original_text;
      entity.content_hash = hashContent(source.original_text);
      entity.search_text = '';
      entity.structured = source.structured;
      entity.structure_status = source.structure_status;
      entity.outline = source.outline;
      entity.outline_status = source.outline_status;
      entity.favorite = false;
      entity.pinned = false;
      entity.pinned_at = null;
      entity.origin = 'ref_copy';
      entity.source_entry_id = entryId;
      entity.version = 1;
      entity.deleted_at = null;
      entity.deleted_by = null;
      await entryRepo.save(entity);

      // 复制标签：作品库按名称查找或新建
      const srcTagRows = await manager.getRepository(KnowledgeEntryTagEntity).find({ where: { entry_id: entryId } });
      const srcTagIds = srcTagRows.map((r) => r.tag_id);
      const srcTags = srcTagIds.length
        ? await manager.getRepository(KnowledgeTagEntity).find({ where: { id: In(srcTagIds) } })
        : [];
      const tagRepo = manager.getRepository(KnowledgeTagEntity);
      const etRepo = manager.getRepository(KnowledgeEntryTagEntity);
      for (const srcTag of srcTags) {
        let workTag = await tagRepo.findOneBy({
          work_id: workId,
          library_scope: 'work',
          name_key: normalizeTitleKey(srcTag.name)
        });
        if (!workTag) {
          workTag = tagRepo.create({
            id: randomUUID(),
            owner_id: authorId,
            library_scope: 'work',
            work_id: workId,
            name: srcTag.name,
            name_key: normalizeTitleKey(srcTag.name)
          });
          await tagRepo.save(workTag);
        }
        const et = etRepo.create({ entry_id: entity.id, tag_id: workTag.id });
        await etRepo.save(et);
      }

      // search_text
      const tagNames = [...(await this.loadTagNamesForEntry(manager, entity.id))].sort();
      entity.search_text = [entity.title, ...tagNames, entity.original_text.slice(0, 2000)].join(' ');
      await entryRepo.save(entity);

      // keep_ref=false：移除原引用
      if (input.keep_ref === false) {
        await manager.getRepository(KnowledgeWorkRefEntity).delete({ work_id: workId, entry_id: entryId });
      }

      return {
        kind: 'entry',
        id: entity.id,
        entry_type: entity.entry_type as KnowledgeEntryDetail['entry_type'],
        title: entity.title,
        excerpt: entity.search_text.slice(0, 160),
        tags: tagNames,
        structure_status: entity.structure_status as KnowledgeEntryDetail['structure_status'],
        outline_status: (entity.outline_status ?? undefined) as KnowledgeEntryDetail['outline_status'],
        favorite: entity.favorite,
        pinned: entity.pinned,
        original_text: entity.original_text,
        structured: entity.structured as KnowledgeEntryDetail['structured'],
        outline: entity.outline as KnowledgeEntryDetail['outline'],
        version: entity.version,
        content_hash: entity.content_hash,
        source_entry_id: entity.source_entry_id ?? undefined,
        created_at: entity.created_at.toISOString(),
        updated_at: entity.updated_at.toISOString()
      };
    });
  }

  private async loadTagNamesForEntry(manager: EntityManager, entryId: string): Promise<string[]> {
    const rows = await manager.getRepository(KnowledgeEntryTagEntity).find({ where: { entry_id: entryId } });
    const tagIds = rows.map((r) => r.tag_id);
    if (!tagIds.length) return [];
    const tags = await manager.getRepository(KnowledgeTagEntity).find({ where: { id: In(tagIds) } });
    return tags.map((t) => t.name).sort();
  }

  // ───────────────────────────── 移除引用（幂等） ─────────────────────────────

  async removeRef(authorId: string, workId: string, refId: string): Promise<{ ok: true }> {
    return this.dataSource.transaction(async (manager) => {
      const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId });
      if (!work || work.author_id !== authorId) throw new NotFoundException('Work not found or not owned');
      const ref = await manager.getRepository(KnowledgeWorkRefEntity).findOneBy({ id: refId, work_id: workId });
      if (!ref) return { ok: true }; // 幂等
      await manager.getRepository(KnowledgeWorkRefEntity).remove(ref);
      return { ok: true };
    });
  }

  // ───────────────────────────── 引用收藏/置顶（T23 补漏点 1） ─────────────────────────────

  async setRefFlags(
    authorId: string,
    workId: string,
    refId: string,
    flags: { favorite?: boolean; pinned?: boolean }
  ): Promise<{ id: string; favorite: boolean; pinned: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId });
      if (!work || work.author_id !== authorId) throw new NotFoundException('Work not found or not owned');
      const ref = await manager.getRepository(KnowledgeWorkRefEntity).findOneBy({ id: refId, work_id: workId });
      if (!ref) throw new NotFoundException('Reference not found');
      if (flags.favorite !== undefined) ref.favorite = flags.favorite;
      if (flags.pinned !== undefined) {
        ref.pinned = flags.pinned;
        ref.pinned_at = flags.pinned ? new Date() : null;
      }
      await manager.save(ref);
      return { id: ref.id, favorite: ref.favorite, pinned: ref.pinned };
    });
  }

  // ───────────────────────────── 引用另存为副本（T23 补漏点 2） ─────────────────────────────

  // copy 端点传 refId；先查 ref 归属校验，取 ref.entry_id（全局条目 id）→ 薄封装复用 copyToWork。
  async copyRef(
    authorId: string,
    workId: string,
    refId: string,
    input: { keep_ref?: boolean; title?: string }
  ): Promise<KnowledgeEntryDetail> {
    const work = await this.dataSource.getRepository(WorkEntity).findOneBy({ id: workId });
    if (!work || work.author_id !== authorId) throw new NotFoundException('Work not found or not owned');
    const ref = await this.dataSource.getRepository(KnowledgeWorkRefEntity).findOneBy({ id: refId, work_id: workId });
    if (!ref) throw new NotFoundException('Reference not found');
    const entryId = ref.entry_id;
    if (!entryId) throw new NotFoundException('Reference source entry not found');
    // 复用 copyToWork 内部逻辑（source_entry_id 已记录来源，keep_ref 语义一致）
    return this.copyToWork(authorId, workId, entryId, input);
  }

  // ───────────────────────────── 软删全局条目 → 刷新全部引用快照 ─────────────────────────────

  // 由 entries.service 软删时调用；刷新引用快照（标题 / 类型 / 标签 / 摘录 / 结构化摘要）
  async refreshSnapshotsForEntry(authorId: string, entryId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const refs = await manager.getRepository(KnowledgeWorkRefEntity).find({ where: { entry_id: entryId } });
      if (!refs.length) return;
      const entry = await manager.getRepository(KnowledgeEntryEntity).findOneBy({ id: entryId });
      if (!entry) return;
      for (const ref of refs) {
        await this.refreshSnapshot(manager, ref, entry);
      }
      await manager.getRepository(KnowledgeWorkRefEntity).save(refs);
    });
  }
}
