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
import { CharacterEntity } from '../database/character.entity';
import { CharacterRelationEntity } from '../database/character-relation.entity';
import { CharacterRelationTypeEntity } from '../database/character-relation-type.entity';
import type { RelationLineStyle, RelationOrigin } from '../database/character-enums';
import { WorkEntity } from '../database/work.entity';
import { AuditService } from '../revision/audit.service';
import { computePairKey } from './character-candidate.normalize';

// F2 §5.3：关系颜色按类型顺序轮转；调色板 8 色
export const RELATION_COLOR_PALETTE = [
  '#FF6B6B',
  '#4ECDC4',
  '#45B7D1',
  '#96CEB4',
  '#FFEAA7',
  '#DDA0DD',
  '#98D8C8',
  '#F7DC6F'
] as const;

export interface RelationTypeInput {
  label: string;
  group_key: string;
  group_label: string;
  directed: boolean;
  reverse_label?: string | null;
  sort_order?: number;
}

export interface RelationInput {
  source_id: string;
  target_id: string;
  type_id: string;
  label: string;
  reverse_label?: string | null;
  color?: string;
  line_style?: RelationLineStyle;
  tag?: string;
  origin?: RelationOrigin;
}

export interface RelationCreateResult {
  created: boolean;
  id: string;
}

// ──────────────────── 关系类型服务 ────────────────────

@Injectable()
export class CharacterRelationTypeService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  private async assertOwnedWork(manager: EntityManager, authorId: string, workId: string): Promise<void> {
    const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('作品不存在');
  }

  async list(authorId: string, workId: string): Promise<CharacterRelationTypeEntity[]> {
    await this.assertOwnedWork(this.dataSource.manager, authorId, workId);
    return this.dataSource
      .getRepository(CharacterRelationTypeEntity)
      .find({ where: { work_id: workId }, order: { sort_order: 'ASC', created_at: 'ASC' } });
  }

  async create(authorId: string, workId: string, input: RelationTypeInput): Promise<CharacterRelationTypeEntity> {
    if (!input.label.trim()) throw new BadRequestException('label 不能为空');
    if (!input.group_key.trim() || !input.group_label.trim()) throw new BadRequestException('group_key/group_label 必填');
    if (!input.directed) {
      // DB CHECK：无方向类型 reverse_label 必须为空
      if (input.reverse_label && input.reverse_label.trim()) {
        throw new BadRequestException('无方向类型 reverse_label 必须为空');
      }
    }

    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const repo = manager.getRepository(CharacterRelationTypeEntity);
      const entity = repo.create({
        id: randomUUID(),
        work_id: workId,
        code: `custom_${Date.now().toString(36)}`,
        label: input.label.trim(),
        group_key: input.group_key.trim(),
        group_label: input.group_label.trim(),
        directed: input.directed,
        reverse_label: input.directed ? (input.reverse_label?.trim() ?? null) : null,
        is_builtin: false,
        sort_order: input.sort_order ?? 100
      });
      const saved = await repo.save(entity);
      await this.audit.record(
        authorId,
        'relation_type_create',
        'relation_type',
        saved.id,
        { label: saved.label, group_key: saved.group_key, directed: saved.directed },
        workId,
        manager
      );
      return saved;
    });
  }

  async update(
    authorId: string,
    workId: string,
    typeId: string,
    input: Partial<RelationTypeInput>
  ): Promise<CharacterRelationTypeEntity> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const repo = manager.getRepository(CharacterRelationTypeEntity);
      const type = await repo.findOneBy({ id: typeId, work_id: workId });
      if (!type) throw new NotFoundException('关系类型不存在');

      // 不允许修改 directed / reverse_label 影响已有实例——
      // 因为已有实例保存了 directed 快照
      if (input.directed !== undefined && input.directed !== type.directed) {
        const refCount = await manager
          .getRepository(CharacterRelationEntity)
          .count({ where: { type_id: type.id } });
        if (refCount > 0) {
          throw new ConflictException({ code: 'RELATION_TYPE_HAS_INSTANCES', message: '类型已有实例，禁止修改方向' });
        }
      }

      // 内置类型允许改名/改 group，但不允许删
      if (input.label !== undefined) type.label = input.label.trim();
      if (input.group_key !== undefined) type.group_key = input.group_key.trim();
      if (input.group_label !== undefined) type.group_label = input.group_label.trim();
      if (input.sort_order !== undefined) type.sort_order = input.sort_order;
      if (input.directed !== undefined) type.directed = input.directed;
      if (input.reverse_label !== undefined) {
        if (!type.directed && input.reverse_label?.trim()) {
          throw new BadRequestException('无方向类型 reverse_label 必须为空');
        }
        type.reverse_label = input.reverse_label?.trim() ?? null;
      }
      const saved = await repo.save(type);
      await this.audit.record(
        authorId,
        'relation_type_update',
        'relation_type',
        saved.id,
        { label: saved.label, directed: saved.directed },
        workId,
        manager
      );
      return saved;
    });
  }

  async delete(authorId: string, workId: string, typeId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const repo = manager.getRepository(CharacterRelationTypeEntity);
      const type = await repo.findOneBy({ id: typeId, work_id: workId });
      if (!type) throw new NotFoundException('关系类型不存在');
      if (type.is_builtin) {
        throw new ConflictException({ code: 'RELATION_TYPE_BUILTIN', message: '内置类型不可删除' });
      }
      const refCount = await manager
        .getRepository(CharacterRelationEntity)
        .count({ where: { type_id: type.id } });
      if (refCount > 0) {
        throw new ConflictException({ code: 'RELATION_TYPE_HAS_INSTANCES', message: '类型已被引用，禁止删除' });
      }
      await repo.delete({ id: type.id });
      await this.audit.record(
        authorId,
        'relation_type_delete',
        'relation_type',
        type.id,
        { label: type.label },
        workId,
        manager
      );
    });
  }
}

// ──────────────────── 关系实例服务 ────────────────────

@Injectable()
export class CharacterRelationService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CharacterRelationTypeService) private readonly types: CharacterRelationTypeService
  ) {}

  private async assertOwnedWork(manager: EntityManager, authorId: string, workId: string): Promise<void> {
    const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('作品不存在');
  }

  async list(authorId: string, workId: string): Promise<CharacterRelationEntity[]> {
    await this.assertOwnedWork(this.dataSource.manager, authorId, workId);
    return this.dataSource
      .getRepository(CharacterRelationEntity)
      .find({ where: { work_id: workId }, order: { created_at: 'ASC' } });
  }

  /** 创建关系实例；UNIQUE (work_id, pair_key, type_id) 冲突返回既有 id（created=false） */
  async create(
    authorId: string,
    workId: string,
    input: RelationInput
  ): Promise<RelationCreateResult> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      if (input.source_id === input.target_id) {
        throw new BadRequestException({ code: 'RELATION_SELF', message: '不能与自己建立关系' });
      }

      const typeRepo = manager.getRepository(CharacterRelationTypeEntity);
      const type = await typeRepo.findOneBy({ id: input.type_id, work_id: workId });
      if (!type) throw new NotFoundException('关系类型不存在');

      // 方向快照：读取时的 type.directed
      const directed = type.directed;

      const charRepo = manager.getRepository(CharacterEntity);
      const chars = await charRepo.find({
        where: { id: In([input.source_id, input.target_id]), work_id: workId }
      });
      if (chars.length !== 2) throw new NotFoundException('角色不存在或跨作品');
      const archived = chars.filter((c) => c.status !== 'active');
      if (archived.length > 0) {
        throw new ConflictException({ code: 'CHARACTER_NOT_WRITABLE', message: '归档/合并角色不可新增关系' });
      }

      // 无方向关系 reverse_label 必须为空
      if (!directed && input.reverse_label && input.reverse_label.trim()) {
        throw new BadRequestException('无方向关系 reverse_label 必须为空');
      }

      const pairKey = computePairKey(input.source_id, input.target_id);
      const repo = manager.getRepository(CharacterRelationEntity);

      // 调色板轮转：同 work 同 type 下已存在的颜色数模 8
      const paletteIndex = (await repo.count({ where: { work_id: workId, type_id: type.id } })) % RELATION_COLOR_PALETTE.length;
      const color = input.color?.trim() || RELATION_COLOR_PALETTE[paletteIndex]!;

      const label = input.label.trim();
      const existing = await repo.findOneBy({ work_id: workId, pair_key: pairKey, type_id: type.id });
      if (existing) {
        return { created: false, id: existing.id };
      }

      const entity = repo.create({
        id: randomUUID(),
        work_id: workId,
        source_id: input.source_id,
        target_id: input.target_id,
        type_id: type.id,
        directed,
        pair_key: pairKey,
        label,
        reverse_label: directed ? (input.reverse_label?.trim() ?? null) : null,
        color,
        line_style: input.line_style ?? 'solid',
        tag: input.tag?.trim() || label,
        origin: input.origin ?? 'manual'
      });
      const saved = await repo.save(entity);
      await this.audit.record(
        authorId,
        'relation_create',
        'character_relation',
        saved.id,
        { type_code: type.code, directed, pair_key: pairKey, label },
        workId,
        manager
      );
      return { created: true, id: saved.id };
    });
  }

  async update(
    authorId: string,
    workId: string,
    relationId: string,
    input: Partial<RelationInput>
  ): Promise<CharacterRelationEntity> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const repo = manager.getRepository(CharacterRelationEntity);
      const rel = await repo.findOneBy({ id: relationId, work_id: workId });
      if (!rel) throw new NotFoundException('关系不存在');

      if (input.label !== undefined) rel.label = input.label.trim();
      if (input.color !== undefined) rel.color = input.color.trim();
      if (input.line_style !== undefined) rel.line_style = input.line_style;
      if (input.tag !== undefined) rel.tag = input.tag.trim();
      // directed / pair_key / type_id / source_id / target_id 不可改（方向快照一旦落下不改）
      // reverse_label 仅 directed 关系可改
      if (input.reverse_label !== undefined) {
        if (!rel.directed && input.reverse_label?.trim()) {
          throw new BadRequestException('无方向关系 reverse_label 必须为空');
        }
        rel.reverse_label = input.reverse_label?.trim() ?? null;
      }
      const saved = await repo.save(rel);
      await this.audit.record(
        authorId,
        'relation_update',
        'character_relation',
        saved.id,
        { label: saved.label },
        workId,
        manager
      );
      return saved;
    });
  }

  async delete(authorId: string, workId: string, relationId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const repo = manager.getRepository(CharacterRelationEntity);
      const rel = await repo.findOneBy({ id: relationId, work_id: workId });
      if (!rel) throw new NotFoundException('关系不存在');
      await repo.delete({ id: relationId });
      await this.audit.record(
        authorId,
        'relation_delete',
        'character_relation',
        rel.id,
        { pair_key: rel.pair_key },
        workId,
        manager
      );
    });
  }
}
