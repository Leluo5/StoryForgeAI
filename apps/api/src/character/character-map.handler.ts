import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { CharacterEntity } from '../database/character.entity';
import { CharacterRelationEntity } from '../database/character-relation.entity';
import { CharacterRelationTypeEntity } from '../database/character-relation-type.entity';
import { seedCharacterRelationTypes } from '../database/character-relation-type.seed';
import { AuditService } from '../revision/audit.service';
import { computePairKey } from './character-candidate.normalize';
import {
  CHARACTER_MAP_MODEL_PROVIDER,
  type CharacterMapCharacterInput,
  type CharacterMapModelProvider,
  type CharacterMapRelationOutput
} from './character-map.model';

export interface CharacterMapTaskContext {
  taskId: string;
  authorId: string;
  workId: string;
  tool: string;
  inputSummary: Record<string, unknown>;
}

export interface CharacterMapHandleResult {
  relations_considered: number;
  relations_created: number;
  relations_skipped_missing_char: number;
  relations_skipped_self: number;
  relations_skipped_dup: number;
  relations_skipped_unknown_type: number;
  [key: string]: number; // 供 processor 展开为事件/审计 payload
}

/**
 * M4-T8 AI 建图任务处理器。
 * 输入 = 已入库角色（character 表 active 行），LLM 只生成关系边写入 character_relation（origin='ai'）。
 * 边界：缺失对端角色跳过该边；自环跳过；无向边去重（computePairKey + UNIQUE 兜底）；
 *       关系类型按 code 精确匹配 → label 模糊匹配 → fallback 第一个类型；匹配不到时跳过。
 */
@Injectable()
export class CharacterMapTaskHandler {
  private readonly logger = new Logger(CharacterMapTaskHandler.name);

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CHARACTER_MAP_MODEL_PROVIDER) private readonly model: CharacterMapModelProvider
  ) {}

  async handle(context: CharacterMapTaskContext): Promise<CharacterMapHandleResult> {
    const { authorId, workId } = context;
    const chars = await this.dataSource
      .getRepository(CharacterEntity)
      .find({ where: { work_id: workId, status: 'active' }, order: { created_at: 'ASC' } });
    if (chars.length < 2) {
      // 角色不足 2 个无法建边，视为成功（空结果），不调用 LLM
      return {
        relations_considered: 0,
        relations_created: 0,
        relations_skipped_missing_char: 0,
        relations_skipped_self: 0,
        relations_skipped_dup: 0,
        relations_skipped_unknown_type: 0
      };
    }

    // 幂等补种归一类型（存量作品首次建图时补齐）
    await seedCharacterRelationTypes(this.dataSource.manager, workId);

    // 已入库角色 → LLM 输入（id + name + 少量上下文）
    const input: CharacterMapCharacterInput[] = chars.map((c) => ({
      id: c.id,
      name: c.name,
      identity: c.identity,
      age_band: c.age_band,
      faction: c.faction
    }));
    const output = await this.model.generateCharacterMap({ workId, characters: input });

    // 角色引用查找表：name（含 name_key）与 id 均可作为 from/to
    const byId = new Map<string, CharacterEntity>();
    const byName = new Map<string, CharacterEntity>();
    for (const c of chars) {
      byId.set(c.id, c);
      byName.set(c.name.toLowerCase(), c);
      if (c.name_key) byName.set(c.name_key.toLowerCase(), c);
    }

    return this.dataSource.transaction(async (manager) => {
      const typeRepo = manager.getRepository(CharacterRelationTypeEntity);
      const relRepo = manager.getRepository(CharacterRelationEntity);
      const types = await typeRepo.find({ where: { work_id: workId }, order: { sort_order: 'ASC' } });
      const fallbackType = types[0] ?? null;

      let created = 0;
      let missingChar = 0;
      let self = 0;
      let dup = 0;
      let unknownType = 0;

      for (const rel of output.relations) {
        const source = this.resolveChar(rel.from, byId, byName);
        const target = this.resolveChar(rel.to, byId, byName);
        if (!source || !target) {
          missingChar++;
          continue; // 缺失对端角色：跳过该边，不报错
        }
        if (source.id === target.id) {
          self++;
          continue; // 自环跳过
        }

        const type = this.resolveType(rel.relation_type, types, fallbackType);
        if (!type) {
          unknownType++;
          continue;
        }

        const pairKey = computePairKey(source.id, target.id);
        const existing = await relRepo.findOneBy({ work_id: workId, pair_key: pairKey, type_id: type.id });
        if (existing) {
          dup++;
          continue; // 无向边去重：同对角色同类型已存在
        }

        const saved = relRepo.create({
          id: randomUUID(),
          work_id: workId,
          source_id: source.id,
          target_id: target.id,
          type_id: type.id,
          directed: type.directed,
          pair_key: pairKey,
          label: type.label,
          reverse_label: type.reverse_label,
          color: this.nextColor(created),
          line_style: 'solid',
          tag: rel.note?.trim() || type.label,
          origin: 'ai'
        });
        await relRepo.save(saved);
        created++;
      }

      await this.audit.record(
        authorId,
        'character_map_generate',
        'character_map',
        workId,
        { relations_considered: output.relations.length, relations_created: created },
        workId,
        manager
      );

      return {
        relations_considered: output.relations.length,
        relations_created: created,
        relations_skipped_missing_char: missingChar,
        relations_skipped_self: self,
        relations_skipped_dup: dup,
        relations_skipped_unknown_type: unknownType
      };
    });
  }

  /** 任务失败时无草稿可标（建图直接落库），best-effort 空实现 */
  async failDraft(_context: CharacterMapTaskContext, _error: Record<string, unknown>): Promise<void> {
    // 建图为单步落库，无草稿状态机可回滚
  }

  private resolveChar(
    ref: string,
    byId: Map<string, CharacterEntity>,
    byName: Map<string, CharacterEntity>
  ): CharacterEntity | null {
    if (!ref || typeof ref !== 'string') return null;
    return byId.get(ref) ?? byName.get(ref.toLowerCase()) ?? null;
  }

  private resolveType(
    raw: string,
    types: CharacterRelationTypeEntity[],
    fallback: CharacterRelationTypeEntity | null
  ): CharacterRelationTypeEntity | null {
    if (!raw || typeof raw !== 'string') return null;
    const needle = raw.trim().toLowerCase();
    if (!needle) return null;
    // code 精确匹配 → label 精确匹配 → label 模糊包含 → fallback 第一个类型
    const byCode = types.find((t) => t.code.toLowerCase() === needle);
    if (byCode) return byCode;
    const byLabel = types.find((t) => t.label.toLowerCase() === needle);
    if (byLabel) return byLabel;
    const byLabelFuzzy = types.find((t) => t.label.toLowerCase().includes(needle));
    if (byLabelFuzzy) return byLabelFuzzy;
    return fallback;
  }

  /** 调色板轮转：同 work 下新建边按创建顺序模 8（与 CharacterRelationService 的 RELATION_COLOR_PALETTE 一致） */
  private nextColor(index: number): string {
    const palette = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F'];
    return palette[index % palette.length]!;
  }
}
