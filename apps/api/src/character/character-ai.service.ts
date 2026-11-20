import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DataSource, In } from 'typeorm';
import type {
  AiDraftInputScope,
  AiDraftKind,
  AiItemKind,
  DuplicateResolution
} from '../database/character-enums';
import { CharacterAiCandidateItemEntity } from '../database/character-ai-candidate-item.entity';
import { CharacterAiDraftEntity } from '../database/character-ai-draft.entity';
import { CharacterEntity } from '../database/character.entity';
import { CharacterRelationEntity } from '../database/character-relation.entity';
import { CharacterRelationTypeEntity } from '../database/character-relation-type.entity';
import { CharacterGrowthEventEntity } from '../database/character-growth-event.entity';
import { WorkEntity } from '../database/work.entity';
import { AuditService } from '../revision/audit.service';
import { computePairKey, normalizeName } from './character-candidate.normalize';
import { RELATION_COLOR_PALETTE } from './character-relation.service';

export interface StartDraftInput {
  kind: AiDraftKind;
  input_scope: AiDraftInputScope;
  input_chapter_id?: string | null;
  idempotency_key: string;
  raw_payload?: Record<string, unknown> | null;
}

export interface CandidateItemPayload {
  kind: AiItemKind;
  payload: Record<string, unknown>;
  dependencies?: number[];
  suspected_duplicates?: Array<Record<string, unknown>>;
}

export interface ConfirmItemOptions {
  resolution?: DuplicateResolution;
  targetCharacterId?: string;
  expectedVersion?: number;
}

export interface ListDraftsQuery {
  limit?: number;
  cursor?: string;
}

const AUTHOR_SET_FIELDS = ['name', 'identity', 'age', 'gender'] as const;

export function mapDraft(entity: CharacterAiDraftEntity): Record<string, unknown> {
  return {
    id: entity.id,
    work_id: entity.work_id,
    kind: entity.kind,
    input_scope: entity.input_scope,
    input_chapter_id: entity.input_chapter_id,
    status: entity.status,
    summary: entity.summary,
    error: entity.error,
    task_id: entity.task_id,
    idempotency_key: entity.idempotency_key,
    created_at: entity.created_at.toISOString(),
    updated_at: entity.updated_at.toISOString()
  };
}

export function mapItem(entity: CharacterAiCandidateItemEntity): Record<string, unknown> {
  return {
    id: entity.id,
    draft_id: entity.draft_id,
    item_index: entity.item_index,
    kind: entity.kind,
    payload: entity.payload,
    dependencies: entity.dependencies,
    suspected_duplicates: entity.suspected_duplicates,
    status: entity.status,
    resolution: entity.resolution,
    resolved_entity_id: entity.resolved_entity_id,
    resolved_at: entity.resolved_at ? entity.resolved_at.toISOString() : null
  };
}

@Injectable()
export class CharacterAiService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  private async assertOwnedWork(manager: EntityManager, authorId: string, workId: string): Promise<void> {
    const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('作品不存在');
  }

  private async nextRelationColor(manager: EntityManager, workId: string): Promise<string> {
    const rels = await manager
      .getRepository(CharacterRelationEntity)
      .createQueryBuilder('r')
      .where('r.work_id = :workId', { workId })
      .orderBy('r.created_at', 'DESC')
      .take(1)
      .getOne();
    if (!rels) return RELATION_COLOR_PALETTE[0]!;
    const idx = RELATION_COLOR_PALETTE.indexOf(rels.color as (typeof RELATION_COLOR_PALETTE)[number]);
    return RELATION_COLOR_PALETTE[(idx + 1) % RELATION_COLOR_PALETTE.length]!;
  }

  // ──────────────────── 1. 草稿发起 ────────────────────

  async startDraft(
    authorId: string,
    workId: string,
    input: StartDraftInput
  ): Promise<CharacterAiDraftEntity> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      if (!input.idempotency_key.trim()) {
        throw new BadRequestException('idempotency_key 不能为空');
      }

      const draftRepo = manager.getRepository(CharacterAiDraftEntity);
      // 幂等优先：同 idempotency_key 重放返回既有草稿（任何状态）
      const existingKeyed = await draftRepo.findOne({
        where: { work_id: workId, idempotency_key: input.idempotency_key }
      });
      if (existingKeyed) return existingKeyed;

      const existingPending = await draftRepo.findOne({
        where: { work_id: workId, kind: input.kind, status: 'pending' }
      });
      if (existingPending) {
        throw new ConflictException({
          code: 'AI_DRAFT_PENDING_EXISTS',
          draft_id: existingPending.id,
          message: `作品已有 ${input.kind} 类型的草稿，先处理掉再发起新的`
        });
      }

      const saved = await draftRepo.save(
        draftRepo.create({
          id: randomUUID(),
          work_id: workId,
          kind: input.kind,
          input_scope: input.input_scope,
          input_chapter_id: input.input_chapter_id ?? null,
          status: 'pending',
          raw_payload: input.raw_payload ?? null,
          summary: null,
          error: null,
          task_id: null,
          idempotency_key: input.idempotency_key.trim()
        })
      );
      await this.audit.record(
        authorId, 'character_ai_draft_start', 'character_ai_draft', saved.id,
        { kind: saved.kind, input_scope: saved.input_scope }, workId, manager
      );
      return saved;
    });
  }

  // ──────────────────── 2. 任务完成落库 ────────────────────

  async commitTaskResult(
    authorId: string,
    workId: string,
    draftId: string,
    items: CandidateItemPayload[]
  ): Promise<CharacterAiDraftEntity> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const draftRepo = manager.getRepository(CharacterAiDraftEntity);
      const itemRepo = manager.getRepository(CharacterAiCandidateItemEntity);
      const draft = await draftRepo.findOneBy({ id: draftId, work_id: workId });
      if (!draft) throw new NotFoundException('草稿不存在');
      if (draft.status !== 'pending') {
        throw new ConflictException({
          code: 'AI_DRAFT_INVALID_STATUS',
          message: `草稿状态 ${draft.status} 不可落库`
        });
      }

      if (items.length === 0) {
        draft.status = 'succeeded';
        draft.summary = { empty: true, item_count: 0 };
        const saved = await draftRepo.save(draft);
        await this.audit.record(
          authorId, 'character_ai_draft_commit', 'character_ai_draft', saved.id,
          { empty: true, item_count: 0 }, workId, manager
        );
        return saved;
      }

      const entities = items.map((it, idx) =>
        itemRepo.create({
          id: randomUUID(),
          draft_id: draft.id,
          item_index: idx,
          kind: it.kind,
          payload: it.payload,
          dependencies: it.dependencies ?? [],
          suspected_duplicates: it.suspected_duplicates ?? [],
          status: 'pending',
          resolution: null,
          resolved_entity_id: null,
          resolved_at: null
        })
      );
      await itemRepo.save(entities);

      draft.status = 'succeeded';
      draft.summary = { empty: false, item_count: entities.length };
      const saved = await draftRepo.save(draft);
      await this.audit.record(
        authorId, 'character_ai_draft_commit', 'character_ai_draft', saved.id,
        { item_count: entities.length }, workId, manager
      );
      return saved;
    });
  }

  // ──────────────────── 3. 读取 ────────────────────

  async getDraft(authorId: string, workId: string, draftId: string): Promise<CharacterAiDraftEntity> {
    await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const d = await manager.getRepository(CharacterAiDraftEntity).findOneBy({ id: draftId, work_id: workId });
      if (!d) throw new NotFoundException('草稿不存在');
    });
    return this.dataSource.getRepository(CharacterAiDraftEntity).findOneByOrFail({ id: draftId });
  }

  async listItems(authorId: string, workId: string, draftId: string): Promise<CharacterAiCandidateItemEntity[]> {
    await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const d = await manager.getRepository(CharacterAiDraftEntity).findOneBy({ id: draftId, work_id: workId });
      if (!d) throw new NotFoundException('草稿不存在');
    });
    return this.dataSource
      .getRepository(CharacterAiCandidateItemEntity)
      .find({ where: { draft_id: draftId }, order: { item_index: 'ASC' } });
  }

  // ──────────────────── 4. 依赖校验 ────────────────────

  private async assertDependenciesSatisfied(
    manager: EntityManager,
    item: CharacterAiCandidateItemEntity
  ): Promise<void> {
    if (item.kind !== 'relation' && item.kind !== 'growth') return;
    if (!item.dependencies.length) return;
    const charItems = await manager
      .getRepository(CharacterAiCandidateItemEntity)
      .find({
        where: {
          draft_id: item.draft_id,
          item_index: In(item.dependencies),
          kind: 'character'
        }
      });
    const unconfirmed = charItems.filter((ci) => ci.status !== 'pending' && ci.status !== 'confirmed' ? false : ci.status !== 'confirmed');
    if (unconfirmed.length) {
      throw new ConflictException({
        code: 'AI_ITEM_DEPENDENCY_NOT_READY',
        item_index: item.item_index,
        unresolved_deps: unconfirmed.map((c) => c.item_index),
        message: '依赖角色条目未确认'
      });
    }
  }

  // ──────────────────── 5. resolveDepCharId ────────────────────

  private async resolveDepCharId(
    manager: EntityManager,
    item: CharacterAiCandidateItemEntity,
    payload: Record<string, unknown>,
    primaryKey: 'source_id' | 'target_id' | 'character_id',
    fallbackDeps: number[]
  ): Promise<string | null> {
    const direct = payload[primaryKey] as string | undefined;
    if (typeof direct === 'string' && direct) return direct;
    if (!fallbackDeps.length) return null;
    const itemRepo = manager.getRepository(CharacterAiCandidateItemEntity);
    const depItems = await itemRepo.find({
      where: {
        draft_id: item.draft_id,
        kind: 'character',
        item_index: In(fallbackDeps)
      }
    });
    const confirmed = depItems.find((d) => d.status === 'confirmed' && d.resolved_entity_id);
    return confirmed?.resolved_entity_id ?? null;
  }

  // ──────────────────── 6. 条目确认 ────────────────────

  async confirmItem(
    authorId: string,
    workId: string,
    draftId: string,
    itemIndex: number,
    options?: DuplicateResolution | ConfirmItemOptions
  ): Promise<CharacterAiCandidateItemEntity> {
    const opts: ConfirmItemOptions = typeof options === 'string' ? { resolution: options } : (options ?? {});
    const resolution = opts.resolution;
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const itemRepo = manager.getRepository(CharacterAiCandidateItemEntity);
      const item = await itemRepo.findOneBy({ draft_id: draftId, item_index: itemIndex });
      if (!item) throw new NotFoundException('候选条目不存在');
      if (item.status === 'confirmed') return item; // 幂等
      if (item.status !== 'pending') {
        throw new ConflictException({ code: 'AI_ITEM_ALREADY_RESOLVED', message: `条目已 ${item.status}` });
      }
      if (item.suspected_duplicates.length > 0 && !resolution) {
        throw new ConflictException({
          code: 'AI_DUPLICATE_RESOLUTION_REQUIRED',
          item_index: itemIndex,
          message: '疑似重复条目必须指定 resolution: create | merge | keep_independent'
        });
      }
      await this.assertDependenciesSatisfied(manager, item);

      // merge 模式：expected_version 校验目标角色版本
      let mergeTargetId: string | undefined;
      if (resolution === 'merge') {
        mergeTargetId =
          opts.targetCharacterId ??
          (typeof item.suspected_duplicates[0]?.['character_id'] === 'string'
            ? (item.suspected_duplicates[0]['character_id'] as string)
            : undefined);
        if (opts.expectedVersion !== undefined) {
          if (!mergeTargetId) {
            throw new ConflictException({ code: 'CHARACTER_VERSION_CONFLICT', current_version: null });
          }
          const target = await manager
            .getRepository(CharacterEntity)
            .createQueryBuilder('c')
            .setLock('pessimistic_write')
            .where('c.id = :id AND c.work_id = :workId', { id: mergeTargetId, workId })
            .getOne();
          if (!target) throw new NotFoundException('合并目标角色不存在');
          if (target.version !== opts.expectedVersion) {
            throw new ConflictException({
              code: 'CHARACTER_VERSION_CONFLICT',
              current_version: target.version
            });
          }
        }
      }

      const createdId = await this.applyConfirm(manager, workId, item, resolution, mergeTargetId);
      item.status = 'confirmed';
      item.resolution = resolution ?? null;
      item.resolved_entity_id = createdId;
      item.resolved_at = new Date();
      const saved = await itemRepo.save(item);
      await this.audit.record(
        authorId, 'character_ai_item_confirm', 'character_ai_candidate_item', saved.id,
        { kind: saved.kind, resolution, resolved_entity_id: createdId, item_index: saved.item_index },
        workId, manager
      );
      await this.autoCommitDraftIfReady(manager, draftId);
      return saved;
    });
  }

  async rejectItem(
    authorId: string,
    workId: string,
    draftId: string,
    itemIndex: number
  ): Promise<CharacterAiCandidateItemEntity> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const itemRepo = manager.getRepository(CharacterAiCandidateItemEntity);
      const item = await itemRepo.findOneBy({ draft_id: draftId, item_index: itemIndex });
      if (!item) throw new NotFoundException('候选条目不存在');
      if (item.status === 'rejected') return item;
      if (item.status !== 'pending') {
        throw new ConflictException({ code: 'AI_ITEM_ALREADY_RESOLVED', message: `条目已 ${item.status}` });
      }
      item.status = 'rejected';
      item.resolved_at = new Date();
      const saved = await itemRepo.save(item);
      await this.audit.record(
        authorId, 'character_ai_item_reject', 'character_ai_candidate_item', saved.id,
        { item_index: saved.item_index, kind: saved.kind }, workId, manager
      );
      await this.autoCommitDraftIfReady(manager, draftId);
      return saved;
    });
  }

  // ──────────────────── 7. 应用确认 ────────────────────

  private async applyConfirm(
    manager: EntityManager,
    workId: string,
    item: CharacterAiCandidateItemEntity,
    resolution?: DuplicateResolution,
    mergeTargetId?: string
  ): Promise<string | null> {
    switch (item.kind) {
      case 'character':
        return this.confirmCharacterItem(manager, workId, item, resolution, mergeTargetId);
      case 'relation':
        return this.confirmRelationItem(manager, workId, item);
      case 'growth':
        return this.confirmGrowthItem(manager, workId, item);
      case 'merge':
        return null;
      default:
        return null;
    }
  }

  private async confirmCharacterItem(
    manager: EntityManager,
    workId: string,
    item: CharacterAiCandidateItemEntity,
    resolution?: DuplicateResolution,
    mergeTargetId?: string
  ): Promise<string> {
    const payload = item.payload as Record<string, unknown>;
    const charRepo = manager.getRepository(CharacterEntity);

    // merge：只填空字段；目标优先显式 targetCharacterId，否则首个疑似重复
    if (resolution === 'merge' && (mergeTargetId || item.suspected_duplicates.length)) {
      const targetId =
        mergeTargetId ??
        (item.suspected_duplicates[0]!['character_id'] as string);
      const target = await charRepo.findOneByOrFail({ id: targetId, work_id: workId });
      let changed = false;
      for (const f of AUTHOR_SET_FIELDS) {
        const val = payload[f];
        const cur = target[f];
        if (val !== undefined && val !== null && (cur === null || cur === '' || cur === undefined)) {
          (target as unknown as Record<string, unknown>)[f] = val;
          changed = true;
        }
      }
      if (typeof payload.personality === 'string' && payload.personality && !target.personality) {
        target.personality = payload.personality;
        changed = true;
      }
      if (typeof payload.experience === 'string' && payload.experience && !target.experience) {
        target.experience = payload.experience;
        changed = true;
      }
      if (changed) target.version = target.version + 1;
      const saved = await charRepo.save(target);
      return saved.id;
    }

    // create / keep_independent：新建
    const name = (payload.name as string ?? '').trim();
    if (!name) throw new BadRequestException('character 候选缺失 name');
    const saved = await charRepo.save(
      charRepo.create({
        id: randomUUID(),
        work_id: workId,
        name,
        name_key: normalizeName(name),
        identity: (payload.identity as string | null) ?? null,
        age: (payload.age as number | null) ?? null,
        gender: (payload.gender as string | null) ?? null,
        personality: (payload.personality as string) ?? '',
        experience: (payload.experience as string) ?? '',
        country_region: (payload.country_region as string | null) ?? null,
        faith: (payload.faith as string | null) ?? null,
        faction: (payload.faction as string | null) ?? null,
        race: (payload.race as string | null) ?? null,
        occupation: (payload.occupation as string | null) ?? null,
        age_band: (payload.age_band as string | null) ?? null,
        attributes: Array.isArray(payload.attributes) ? (payload.attributes as never[]) : [],
        avatar_asset_id: null,
        status: 'active',
        merged_into_id: null,
        archived_at: null,
        archived_by: null,
        origin: 'ai',
        version: 1
      })
    );
    return saved.id;
  }

  private async confirmRelationItem(
    manager: EntityManager,
    workId: string,
    item: CharacterAiCandidateItemEntity
  ): Promise<string | null> {
    const payload = item.payload as Record<string, unknown>;
    const typeRepo = manager.getRepository(CharacterRelationTypeEntity);
    const relRepo = manager.getRepository(CharacterRelationEntity);

    const sourceId = await this.resolveDepCharId(manager, item, payload, 'source_id', item.dependencies);
    const targetId = await this.resolveDepCharId(manager, item, payload, 'target_id', item.dependencies);
    if (!sourceId || !targetId) return null;
    if (sourceId === targetId) return null;

    let typeId: string | undefined;
    if (typeof payload.type_code === 'string') {
      const t = await typeRepo.findOneBy({ work_id: workId, code: payload.type_code });
      if (t) typeId = t.id;
    }
    let directed = false;
    if (!typeId) {
      const t = await typeRepo.findOne({ where: { work_id: workId } });
      if (!t) return null;
      typeId = t.id;
      directed = t.directed;
    } else {
      const t = await typeRepo.findOneByOrFail({ id: typeId });
      directed = t.directed;
    }

    const label = (payload.label as string | undefined) ?? '关联';
    const pair_key = computePairKey(sourceId, targetId);
    const existing = await relRepo.findOneBy({ work_id: workId, pair_key, type_id: typeId });
    if (existing) return existing.id;

    const color = await this.nextRelationColor(manager, workId);
    const saved = await relRepo.save(
      relRepo.create({
        id: randomUUID(),
        work_id: workId,
        source_id: sourceId,
        target_id: targetId,
        type_id: typeId,
        directed,
        pair_key,
        label,
        reverse_label: null,
        color,
        line_style: 'solid',
        tag: label,
        origin: 'ai'
      })
    );
    return saved.id;
  }

  private async confirmGrowthItem(
    manager: EntityManager,
    workId: string,
    item: CharacterAiCandidateItemEntity
  ): Promise<string | null> {
    const payload = item.payload as Record<string, unknown>;
    const charId = await this.resolveDepCharId(manager, item, payload, 'character_id', item.dependencies);
    if (!charId) return null;
    const title = (payload.title as string ?? '').trim();
    if (!title) throw new BadRequestException('growth 候选缺失 title');
    const repo = manager.getRepository(CharacterGrowthEventEntity);
    const saved = await repo.save(
      repo.create({
        id: randomUUID(),
        work_id: workId,
        character_id: charId,
        title,
        content: (payload.content as string) ?? '',
        event_time: (payload.event_time as string | null) ?? null,
        plot_node_id: null,
        plot_node_title: null,
        chapter_id: null,
        status: 'active',
        archived_at: null,
        origin: 'ai'
      })
    );
    return saved.id;
  }

  // ──────────────────── 8. 自动 committed ────────────────────

  private async autoCommitDraftIfReady(manager: EntityManager, draftId: string): Promise<void> {
    const itemRepo = manager.getRepository(CharacterAiCandidateItemEntity);
    const items = await itemRepo.find({ where: { draft_id: draftId } });
    if (!items.length) return;
    if (items.some((i) => i.status === 'pending')) return;
    const draftRepo = manager.getRepository(CharacterAiDraftEntity);
    const draft = await draftRepo.findOneBy({ id: draftId });
    if (!draft || draft.status !== 'succeeded') return;
    draft.status = 'committed';
    await draftRepo.save(draft);
  }

  // ──────────────────── 9. 丢弃 ────────────────────

  async discardDraft(
    authorId: string,
    workId: string,
    draftId: string
  ): Promise<CharacterAiDraftEntity> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const draftRepo = manager.getRepository(CharacterAiDraftEntity);
      const itemRepo = manager.getRepository(CharacterAiCandidateItemEntity);
      const draft = await draftRepo.findOneBy({ id: draftId, work_id: workId });
      if (!draft) throw new NotFoundException('草稿不存在');
      if (draft.status === 'discarded') return draft; // 幂等
      if (draft.status === 'committed') {
        throw new ConflictException({ code: 'AI_DRAFT_ALREADY_COMMITTED', message: '草稿已提交不可丢弃' });
      }
      draft.status = 'discarded';
      const saved = await draftRepo.save(draft);
      await itemRepo
        .createQueryBuilder()
        .update({ status: 'skipped' })
        .where('draft_id = :id AND status = :status', { id: saved.id, status: 'pending' })
        .execute();
      await this.audit.record(
        authorId, 'character_ai_draft_discard', 'character_ai_draft', saved.id,
        { kind: saved.kind }, workId, manager
      );
      return saved;
    });
  }

  // ──────────────────── 10. 草稿列表（游标分页） ────────────────────

  async listDrafts(
    authorId: string,
    workId: string,
    query: ListDraftsQuery = {}
  ): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
    await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
    });
    const limit = query.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException('limit 必须为 1~100 的整数');
    }
    const offset = query.cursor ? Number(query.cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new BadRequestException('cursor 非法');
    }
    const repo = this.dataSource.getRepository(CharacterAiDraftEntity);
    const [rows, total] = await repo.findAndCount({
      where: { work_id: workId },
      order: { created_at: 'DESC', id: 'DESC' },
      skip: offset,
      take: limit
    });
    return {
      items: rows.map(mapDraft),
      next_cursor: offset + limit < total ? String(offset + limit) : null
    };
  }

  // ──────────────────── 11. 任务绑定 / 失败 ────────────────────

  async linkTask(
    draftId: string,
    taskId: string,
    actor?: { authorId: string; workId: string }
  ): Promise<CharacterAiDraftEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(CharacterAiDraftEntity);
      const draft = await repo.findOneBy({ id: draftId });
      if (!draft) throw new NotFoundException('草稿不存在');
      if (actor) await this.assertOwnedWork(manager, actor.authorId, actor.workId);
      draft.task_id = taskId;
      const saved = await repo.save(draft);
      if (actor) {
        await this.audit.record(
          actor.authorId, 'character_ai_draft_link_task', 'character_ai_draft', saved.id,
          { task_id: taskId }, actor.workId, manager
        );
      }
      return saved;
    });
  }

  async markFailed(
    draftId: string,
    error: Record<string, unknown>,
    actor?: { authorId: string; workId: string }
  ): Promise<CharacterAiDraftEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(CharacterAiDraftEntity);
      const draft = await repo.findOneBy({ id: draftId });
      if (!draft) throw new NotFoundException('草稿不存在');
      if (actor) await this.assertOwnedWork(manager, actor.authorId, actor.workId);
      if (draft.status !== 'pending') return draft;
      draft.status = 'failed';
      draft.error = error;
      const saved = await repo.save(draft);
      if (actor) {
        await this.audit.record(
          actor.authorId, 'character_ai_draft_failed', 'character_ai_draft', saved.id,
          { error }, actor.workId, manager
        );
      }
      return saved;
    });
  }

  // ──────────────────── 12. 批量确认（先全量预校验，再逐条执行） ────────────────────

  async confirmBatch(
    authorId: string,
    workId: string,
    draftId: string,
    itemIds: string[],
    resolutions?: Array<{ item_id: string; action: DuplicateResolution; target_character_id?: string }>
  ): Promise<{ items: Record<string, unknown>[]; confirmed: number }> {
    const ids = Array.from(new Set(itemIds));
    if (ids.length === 0) throw new BadRequestException('item_ids 不能为空');

    // 预校验：全部属于该草稿，且 pending/confirmed
    await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const draft = await manager
        .getRepository(CharacterAiDraftEntity)
        .findOneBy({ id: draftId, work_id: workId });
      if (!draft) throw new NotFoundException('草稿不存在');
      const items = await manager
        .getRepository(CharacterAiCandidateItemEntity)
        .find({ where: { draft_id: draftId, id: In(ids) } });
      if (items.length !== ids.length) throw new NotFoundException('候选条目不存在');
      const invalid = items.filter((i) => i.status !== 'pending' && i.status !== 'confirmed');
      if (invalid.length > 0) {
        throw new ConflictException({
          code: 'AI_ITEM_ALREADY_RESOLVED',
          item_ids: invalid.map((i) => i.id)
        });
      }
    });

    const resolutionMap = new Map((resolutions ?? []).map((r) => [r.item_id, r]));
    const results: CharacterAiCandidateItemEntity[] = [];
    for (const id of ids) {
      const item = await this.dataSource
        .getRepository(CharacterAiCandidateItemEntity)
        .findOneBy({ id, draft_id: draftId });
      if (!item) throw new NotFoundException('候选条目不存在');
      const resolution = resolutionMap.get(id);
      const options: ConfirmItemOptions = {
        ...(resolution ? { resolution: resolution.action } : {}),
        ...(resolution?.target_character_id
          ? { targetCharacterId: resolution.target_character_id }
          : {})
      };
      results.push(await this.confirmItem(authorId, workId, draftId, item.item_index, options));
    }
    return {
      items: results.map(mapItem),
      confirmed: results.filter((i) => i.status === 'confirmed').length
    };
  }
}
