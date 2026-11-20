import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DataSource, In } from 'typeorm';
import type {
  Character,
  CharacterAttribute,
  CharacterDossier,
  CharacterOrigin
} from '@storyforge/contracts';
import { CharacterEntity } from '../database/character.entity';
import { CharacterAliasEntity } from '../database/character-alias.entity';
import { CharacterArchiveScanEntity } from '../database/character-archive-scan.entity';
import { CharacterRelationEntity } from '../database/character-relation.entity';
import { CharacterGrowthEventEntity } from '../database/character-growth-event.entity';
import { CharacterTextAnchorEntity } from '../database/character-text-anchor.entity';
import { CharacterViewNodeEntity } from '../database/character-view-node.entity';
import type { ArchiveScanStatus } from '../database/character-enums';
import { PlotNodeCharacterOwnerEntity } from '../database/plot-node-character-owner.entity';
import { PlotNodeEntity } from '../database/plot-node.entity';
import { PlotTreeEntity } from '../database/plot-tree.entity';
import { WorkEntity } from '../database/work.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { AuditService } from '../revision/audit.service';
import {
  ageToBand,
  computePairKey,
  mapCharacter,
  normalizeAliasKey,
  normalizeName
} from './character-candidate.normalize';
import { generateRandomDossier } from './character-random';
import { CharacterAnchorService } from './character-anchor.service';
import { CharacterArchiveScanService } from './character-scan.service';

const ALIAS_MAX = 10;

export interface DuplicateGroup {
  key: string;
  matched_on: 'name' | 'alias';
  character_ids: string[];
}

export interface MergeIntoResult {
  source_id: string;
  target_id: string;
  alias_transferred: number;
  alias_skipped: number;
  growth_transferred: number;
  plot_owner_transferred: number;
  plot_owner_skipped: number;
  relation_transferred: number;
  relation_skipped: number;
  view_node_transferred: number;
  view_node_skipped: number;
  avatar_left: boolean;
}

type WriteableStatus = 'active';

export interface CreateCharacterInput {
  name: string;
  aliases?: string[];
  identity?: string | null;
  age?: number | null;
  gender?: string | null;
  personality?: string;
  experience?: string;
  country_region?: string | null;
  faith?: string | null;
  faction?: string | null;
  race?: string | null;
  occupation?: string | null;
  age_band?: string | null;
  attributes?: CharacterAttribute[];
  origin?: CharacterOrigin;
  expected_version?: number;
}

export interface UpdateCharacterInput {
  name?: string;
  aliases?: string[];
  identity?: string | null;
  age?: number | null;
  gender?: string | null;
  personality?: string;
  experience?: string;
  country_region?: string | null;
  faith?: string | null;
  faction?: string | null;
  race?: string | null;
  occupation?: string | null;
  age_band?: string | null;
  attributes?: CharacterAttribute[];
  expected_version?: number;
}

export interface RandomDossierResponse {
  seed: string;
  dossier: CharacterDossier;
}

export interface ArchiveImpact {
  relations: number;
  growth_events: number;
  chapters: number;
  exclusive_plot_nodes: number;
}

export interface ArchiveScanSummary {
  id: string;
  status: ArchiveScanStatus;
  total_chapters: number;
}

export interface CharacterArchiveResult {
  changed: boolean;
  character: Character;
  impact: ArchiveImpact;
  scan: ArchiveScanSummary;
  version: number;
}

export interface DuplicateCandidate {
  character_id: string;
  name: string;
  matched_on: 'name' | 'alias';
}

export interface CharacterRestoreResult {
  changed: boolean;
  character: Character;
  duplicate_candidates: DuplicateCandidate[];
}

@Injectable()
export class CharacterService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly audit: AuditService,
    @Optional() @Inject(CharacterArchiveScanService) private readonly scans?: CharacterArchiveScanService,
    @Optional() @Inject(CharacterAnchorService) private readonly anchors?: CharacterAnchorService
  ) {}

  // ─────────────────── 私有守卫 ───────────────────

  private async assertOwnedWork(manager: EntityManager, authorId: string, workId: string): Promise<void> {
    const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('作品不存在');
  }

  private async requireCharacter(manager: EntityManager, workId: string, characterId: string): Promise<CharacterEntity> {
    const character = await manager.getRepository(CharacterEntity).findOneBy({ id: characterId, work_id: workId });
    if (!character) throw new NotFoundException('角色不存在');
    return character;
  }

  private assertWriteable(character: CharacterEntity): void {
    if (character.status === 'archived') {
      throw new ConflictException({ code: 'CHARACTER_ARCHIVED', message: '角色已归档，禁止写入' });
    }
    if (character.status === 'merged') {
      throw new ConflictException({ code: 'CHARACTER_MERGED', message: '角色已合并，禁止写入' });
    }
  }

  private assertVersion(expected: number | undefined, actual: number, code: string): void {
    if (expected !== undefined && expected !== actual) {
      throw new ConflictException({ code, current_version: actual });
    }
  }

  private async loadAliases(manager: EntityManager, characterIds: string[]): Promise<Map<string, CharacterAliasEntity[]>> {
    if (characterIds.length === 0) return new Map();
    const aliasRepo = manager.getRepository(CharacterAliasEntity);
    const aliases = await aliasRepo.find({ where: { character_id: In(characterIds) } });
    const grouped = new Map<string, CharacterAliasEntity[]>();
    for (const alias of aliases) {
      const list = grouped.get(alias.character_id) ?? [];
      list.push(alias);
      grouped.set(alias.character_id, list);
    }
    return grouped;
  }

  // ─────────────────── 随机资料（无持久化） ───────────────────

  async randomDossier(seed?: string): Promise<RandomDossierResponse> {
    const { seed: finalSeed, dossier } = generateRandomDossier(seed);
    return { seed: finalSeed, dossier };
  }

  // ─────────────────── 角色 CRUD ───────────────────

  async create(authorId: string, workId: string, input: CreateCharacterInput): Promise<Character> {
    if ((input.aliases ?? []).length > ALIAS_MAX) {
      throw new UnprocessableEntityException({ code: 'CHARACTER_ALIAS_TOO_MANY', max: ALIAS_MAX });
    }
    const version = await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const repo = manager.getRepository(CharacterEntity);
      const nameKey = normalizeName(input.name);
      const age = input.age ?? null;
      const age_band = input.age_band ?? ageToBand(age);
      const entity = repo.create({
        id: randomUUID(),
        work_id: workId,
        name: input.name.trim(),
        name_key: nameKey,
        identity: input.identity ?? null,
        age,
        gender: input.gender ?? null,
        personality: input.personality ?? '',
        experience: input.experience ?? '',
        country_region: input.country_region ?? null,
        faith: input.faith ?? null,
        faction: input.faction ?? null,
        race: input.race ?? null,
        occupation: input.occupation ?? null,
        age_band,
        attributes: input.attributes ?? [],
        avatar_asset_id: null,
        status: 'active',
        merged_into_id: null,
        archived_at: null,
        archived_by: null,
        origin: input.origin ?? 'manual',
        version: 1
      });
      const saved = await repo.save(entity);
      await this.upsertAliases(manager, workId, saved.id, input.aliases ?? []);
      await this.audit.record(authorId, 'character_create', 'character', saved.id, { name: saved.name }, workId, manager);
      return saved;
    });
    const aliases = await this.dataSource.getRepository(CharacterAliasEntity).find({
      where: { character_id: version.id },
      order: { created_at: 'ASC' }
    });
    return mapCharacter(version, aliases);
  }

  async get(authorId: string, workId: string, characterId: string): Promise<Character> {
    await this.assertOwnedWork(this.dataSource.manager, authorId, workId);
    const character = await this.requireCharacter(this.dataSource.manager, workId, characterId);
    const aliases = await this.dataSource.getRepository(CharacterAliasEntity).find({
      where: { character_id: character.id },
      order: { created_at: 'ASC' }
    });
    return mapCharacter(character, aliases);
  }

  async list(authorId: string, workId: string): Promise<Character[]> {
    await this.assertOwnedWork(this.dataSource.manager, authorId, workId);
    const characters = await this.dataSource.getRepository(CharacterEntity).find({
      where: { work_id: workId },
      order: { created_at: 'ASC' }
    });
    const grouped = await this.loadAliases(this.dataSource.manager, characters.map((c) => c.id));
    return characters.map((c) => mapCharacter(c, grouped.get(c.id) ?? []));
  }

  async update(
    authorId: string,
    workId: string,
    characterId: string,
    input: UpdateCharacterInput
  ): Promise<Character> {
    if (input.aliases !== undefined && input.aliases.length > ALIAS_MAX) {
      throw new UnprocessableEntityException({ code: 'CHARACTER_ALIAS_TOO_MANY', max: ALIAS_MAX });
    }
    const saved = await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const repo = manager.getRepository(CharacterEntity);
      const character = await this.requireCharacter(manager, workId, characterId);
      this.assertWriteable(character);
      this.assertVersion(input.expected_version, character.version, 'CHARACTER_VERSION_CONFLICT');

      const patch: Partial<CharacterEntity> = { version: character.version + 1, updated_at: new Date() };
      if (input.name !== undefined) {
        patch.name = input.name.trim();
        patch.name_key = normalizeName(input.name);
      }
      if (input.identity !== undefined) patch.identity = input.identity;
      if (input.age !== undefined) {
        patch.age = input.age;
        if (input.age_band === undefined) patch.age_band = ageToBand(input.age);
      }
      if (input.gender !== undefined) patch.gender = input.gender;
      if (input.personality !== undefined) patch.personality = input.personality;
      if (input.experience !== undefined) patch.experience = input.experience;
      if (input.country_region !== undefined) patch.country_region = input.country_region;
      if (input.faith !== undefined) patch.faith = input.faith;
      if (input.faction !== undefined) patch.faction = input.faction;
      if (input.race !== undefined) patch.race = input.race;
      if (input.occupation !== undefined) patch.occupation = input.occupation;
      if (input.age_band !== undefined) patch.age_band = input.age_band;
      if (input.attributes !== undefined) patch.attributes = input.attributes;

      if (Object.keys(patch).length > 0) {
        await repo.update({ id: character.id }, patch);
      }
      if (input.aliases !== undefined) {
        await this.upsertAliases(manager, workId, character.id, input.aliases);
      }

      const updated = await repo.findOneByOrFail({ id: character.id });
      await this.audit.record(authorId, 'character_update', 'character', character.id, {}, workId, manager);
      return updated;
    });
    const aliases = await this.dataSource.getRepository(CharacterAliasEntity).find({
      where: { character_id: saved.id },
      order: { created_at: 'ASC' }
    });
    return mapCharacter(saved, aliases);
  }

  // ─────────────────── 别名写入（同事务内替换式更新 + 去重 + 上限） ───────────────────

  private async upsertAliases(
    manager: EntityManager,
    workId: string,
    characterId: string,
    aliases: string[]
  ): Promise<void> {
    const unique = Array.from(new Set(aliases.map((a) => a.trim()).filter(Boolean))).slice(0, ALIAS_MAX);
    const aliasRepo = manager.getRepository(CharacterAliasEntity);
    await aliasRepo.delete({ character_id: characterId });
    for (const alias of unique) {
      await aliasRepo.save(
        aliasRepo.create({
          id: randomUUID(),
          work_id: workId,
          character_id: characterId,
          alias,
          alias_key: normalizeName(alias)
        })
      );
    }
  }

  // ─────────────────── 疑似重复检测 ───────────────────

  async findDuplicates(authorId: string, workId: string): Promise<DuplicateGroup[]> {
    await this.assertOwnedWork(this.dataSource.manager, authorId, workId);
    const charRepo = this.dataSource.getRepository(CharacterEntity);
    // merged 角色不参与检测
    const characters = await charRepo.find({
      where: { work_id: workId, status: 'active' },
      select: ['id', 'name', 'name_key', 'status']
    });
    // 收集 name_key 命中：name_key 非空 && 命中 ≥ 2
    const byNameKey = new Map<string, string[]>();
    for (const c of characters) {
      if (!c.name_key) continue;
      const list = byNameKey.get(c.name_key) ?? [];
      list.push(c.id);
      byNameKey.set(c.name_key, list);
    }

    const groups: DuplicateGroup[] = [];
    const seenIds = new Set<string>();

    for (const [key, ids] of byNameKey) {
      if (ids.length >= 2) {
        groups.push({ key, matched_on: 'name', character_ids: ids });
        ids.forEach((id) => seenIds.add(id));
        if (groups.length >= 50) return groups;
      }
    }

    const aliasRepo = this.dataSource.getRepository(CharacterAliasEntity);
    const aliases = await aliasRepo.find({ where: { work_id: workId } });
    const byAliasKey = new Map<string, string[]>();
    for (const a of aliases) {
      if (!a.alias_key) continue;
      const list = byAliasKey.get(a.alias_key) ?? [];
      list.push(a.character_id);
      byAliasKey.set(a.alias_key, list);
    }

    for (const [key, ids] of byAliasKey) {
      const uniqueIds = Array.from(new Set(ids));
      const activeIds = uniqueIds.filter((id) => !seenIds.has(id));
      if (activeIds.length >= 2) {
        groups.push({ key, matched_on: 'alias', character_ids: activeIds });
        activeIds.forEach((id) => seenIds.add(id));
        if (groups.length >= 50) return groups;
      }
    }
    return groups;
  }

  // ─────────────────── 合并转移（单事务，九步） ───────────────────

  async mergeInto(
    authorId: string,
    workId: string,
    sourceId: string,
    targetId: string,
    keepAlias: boolean,
    expectedVersion?: number
  ): Promise<MergeIntoResult> {
    if (sourceId === targetId) {
      throw new UnprocessableEntityException({ code: 'CHARACTER_MERGE_SELF', message: '不能将角色合并到自己' });
    }

    const result = await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const charRepo = manager.getRepository(CharacterEntity);

      // 按 id 升序 FOR UPDATE，防死锁
      const orderedIds = [sourceId, targetId].sort((a, b) => a.localeCompare(b));
      const locked = await charRepo
        .createQueryBuilder('c')
        .setLock('pessimistic_write')
        .where('c.work_id = :workId', { workId })
        .andWhere('c.id IN (:...ids)', { ids: orderedIds })
        .getMany();
      if (locked.length !== 2) throw new NotFoundException('合并角色中至少一个不存在或被锁定');
      const source = locked.find((c) => c.id === sourceId)!;
      const target = locked.find((c) => c.id === targetId)!;

      // 写守卫（允许 merged → 谁也不能写，但 merged 角色不应该被选为 source）
      if (source.status !== 'active') {
        throw new ConflictException({ code: 'CHARACTER_NOT_WRITABLE', message: '来源角色非 active' });
      }
      if (target.status !== 'active') {
        throw new ConflictException({ code: 'CHARACTER_NOT_WRITABLE', message: '目标角色非 active' });
      }
      if (expectedVersion !== undefined && source.version !== expectedVersion) {
        throw new ConflictException({ code: 'CHARACTER_VERSION_CONFLICT', current_version: source.version });
      }

      // 预取目标已有的 alias_key / view 成员 / plot owner 节点 / relation pair_key
      const aliasRepo = manager.getRepository(CharacterAliasEntity);
      const growthRepo = manager.getRepository(CharacterGrowthEventEntity);
      const ownerRepo = manager.getRepository(PlotNodeCharacterOwnerEntity);
      const relationRepo = manager.getRepository(CharacterRelationEntity);
      const viewRepo = manager.getRepository(CharacterViewNodeEntity);

      const targetAliasKeys = new Set(
        (await aliasRepo.find({ where: { character_id: target.id } })).map((a) => a.alias_key)
      );
      const targetOwners = await ownerRepo.find({ where: { character_id: target.id } });
      const targetOwnerNodeIds = new Set(targetOwners.map((o) => o.node_id));
      const targetViewKeys = new Set(
        (await viewRepo.find({ where: { character_id: target.id } })).map((v) => `${v.view_id}~${v.character_id}`)
      );
      const targetRelations = await relationRepo.find({ where: { work_id: workId } });
      const targetRelationKeys = new Set(
        targetRelations.map((r) => `${r.type_id}~${r.pair_key}`)
      );

      let alias_transferred = 0;
      let alias_skipped = 0;
      let growth_transferred = 0;
      let plot_owner_transferred = 0;
      let plot_owner_skipped = 0;
      let relation_transferred = 0;
      let relation_skipped = 0;
      let view_node_transferred = 0;
      let view_node_skipped = 0;

      // Step 1: 转移别名
      if (keepAlias) {
        const sourceAliases = await aliasRepo.find({ where: { character_id: source.id } });
        for (const a of sourceAliases) {
          if (targetAliasKeys.has(a.alias_key)) {
            alias_skipped += 1;
            continue;
          }
          await aliasRepo.save(
            aliasRepo.create({
              id: randomUUID(),
              work_id: workId,
              character_id: target.id,
              alias: a.alias,
              alias_key: a.alias_key
            })
          );
          alias_transferred += 1;
        }
      }
      // 来源别名清空（无论 keepAlias 是否）
      await aliasRepo.delete({ character_id: source.id });

      // Step 2: 转移成长事件（全部）
      const growthUpdate = await growthRepo
        .createQueryBuilder()
        .update()
        .set({ character_id: target.id })
        .where('character_id = :source', { source: source.id })
        .execute();
      growth_transferred = growthUpdate.affected ?? 0;

      // Step 3: 转移 plot 归属
      const sourceOwners = await ownerRepo.find({ where: { character_id: source.id } });
      for (const o of sourceOwners) {
        if (targetOwnerNodeIds.has(o.node_id)) {
          plot_owner_skipped += 1;
          continue;
        }
        await ownerRepo.save(
          ownerRepo.create({
            id: randomUUID(),
            work_id: workId,
            node_id: o.node_id,
            character_id: target.id,
            is_exclusive: o.is_exclusive
          })
        );
        plot_owner_transferred += 1;
      }
      await ownerRepo.delete({ character_id: source.id });

      // Step 4: 转移关系（重算 pair_key，唯一键冲突跳过）
      const sourceRelations = await relationRepo.find({
        where: [{ source_id: source.id }, { target_id: source.id }]
      });
      // 预算目标的 pair_key 覆盖全集，用于前置冲突检测
      const existingPairKeyByType = new Map<string, Set<string>>();
      for (const r of targetRelations) {
        const s = existingPairKeyByType.get(r.type_id) ?? new Set<string>();
        s.add(r.pair_key);
        existingPairKeyByType.set(r.type_id, s);
      }
      for (const r of sourceRelations) {
        let newSource = r.source_id === source.id ? target.id : r.source_id;
        let newTarget = r.target_id === source.id ? target.id : r.target_id;
        // 自关系保护
        if (newSource === newTarget) {
          relation_skipped += 1;
          continue;
        }
        const newPairKey = computePairKey(newSource, newTarget);
        const existingKeys = existingPairKeyByType.get(r.type_id) ?? new Set<string>();
        if (existingKeys.has(newPairKey)) {
          relation_skipped += 1;
          continue;
        }
        // 更新
        const qb = relationRepo.createQueryBuilder().update();
        await qb
          .set({ source_id: newSource, target_id: newTarget, pair_key: newPairKey, updated_at: new Date() })
          .where('id = :id', { id: r.id })
          .execute();
        existingKeys.add(newPairKey);
        relation_transferred += 1;
      }

      // Step 5: 转移视图成员（(view_id, character_id) 唯一键）
      const sourceViewNodes = await viewRepo.find({ where: { character_id: source.id } });
      for (const v of sourceViewNodes) {
        const key = `${v.view_id}~${target.id}`;
        if (targetViewKeys.has(key)) {
          view_node_skipped += 1;
          continue;
        }
        await viewRepo.save(
          viewRepo.create({
            id: randomUUID(),
            view_id: v.view_id,
            character_id: target.id,
            x: v.x,
            y: v.y,
            arranged: v.arranged,
            sort_index: v.sort_index
          })
        );
        view_node_transferred += 1;
      }
      await viewRepo.delete({ character_id: source.id });

      // Step 6: 头像不覆盖（保留目标 active 头像）——不做任何动作

      // Step 7: 来源角色 merged + merged_into_id
      await charRepo.update(
        { id: source.id },
        { status: 'merged', merged_into_id: target.id, version: source.version + 1, updated_at: new Date() }
      );

      // Step 8: 审计
      await this.audit.record(
        authorId,
        'character_merge',
        'character',
        source.id,
        {
          target_id: target.id,
          keep_alias: keepAlias,
          counts: {
            alias_transferred, alias_skipped,
            growth_transferred,
            plot_owner_transferred, plot_owner_skipped,
            relation_transferred, relation_skipped,
            view_node_transferred, view_node_skipped,
            avatar_left: true
          }
        },
        workId,
        manager
      );

      return {
        source_id: source.id,
        target_id: target.id,
        alias_transferred, alias_skipped,
        growth_transferred,
        plot_owner_transferred, plot_owner_skipped,
        relation_transferred, relation_skipped,
        view_node_transferred, view_node_skipped,
        avatar_left: true
      };
    });
    return result;
  }

  // ─────────────────── 归档 / 恢复（F2 §5.5） ───────────────────

  async archive(
    authorId: string,
    workId: string,
    characterId: string,
    expectedVersion?: number
  ): Promise<CharacterArchiveResult> {
    const outcome = await this.dataSource.transaction<{
      changed: boolean;
      version: number;
      impact: ArchiveImpact;
      scan: CharacterArchiveScanEntity;
      scanToRun: string | null;
    }>(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const repo = manager.getRepository(CharacterEntity);
      const character = await repo
        .createQueryBuilder('c')
        .setLock('pessimistic_write')
        .where('c.id = :characterId AND c.work_id = :workId', { characterId, workId })
        .getOne();
      if (!character) throw new NotFoundException('角色不存在');
      if (character.status === 'merged') {
        throw new ConflictException({ code: 'CHARACTER_MERGED', message: '角色已合并，禁止归档' });
      }
      this.assertVersion(expectedVersion, character.version, 'CHARACTER_VERSION_CONFLICT');

      const impact = await this.computeArchiveImpact(manager, workId, characterId);

      // 已归档：幂等返回既有扫描；历史数据无扫描时补建一次
      if (character.status === 'archived') {
        const latest = await manager
          .getRepository(CharacterArchiveScanEntity)
          .findOne({ where: { character_id: characterId }, order: { created_at: 'DESC' } });
        if (latest) {
          return { changed: false, version: character.version, impact, scan: latest, scanToRun: null };
        }
        const created = await this.createOrReusePendingScan(manager, workId, characterId, authorId, impact.chapters);
        return { changed: false, version: character.version, impact, scan: created, scanToRun: created.id };
      }

      await repo.update(
        { id: characterId },
        {
          status: 'archived',
          archived_at: new Date(),
          archived_by: authorId,
          version: character.version + 1,
          updated_at: new Date()
        }
      );
      await manager
        .getRepository(CharacterGrowthEventEntity)
        .createQueryBuilder()
        .update()
        .set({ status: 'archived', archived_at: new Date() })
        .where('character_id = :characterId', { characterId })
        .execute();

      const scan = await this.createOrReusePendingScan(manager, workId, characterId, authorId, impact.chapters);
      await this.audit.record(
        authorId,
        'character_archive',
        'character',
        characterId,
        { impact, scan_id: scan.id },
        workId,
        manager
      );
      return { changed: true, version: character.version + 1, impact, scan, scanToRun: scan.id };
    });

    // 事务提交后异步扫描，不阻塞归档响应
    if (outcome.scanToRun && this.scans) {
      void this.scans.runBatches(authorId, workId, outcome.scanToRun).catch(() => undefined);
    }

    const character = await this.get(authorId, workId, characterId);
    return {
      changed: outcome.changed,
      character,
      impact: outcome.impact,
      scan: {
        id: outcome.scan.id,
        status: outcome.scan.status,
        total_chapters: outcome.scan.total_chapters
      },
      version: outcome.version
    };
  }

  async restore(authorId: string, workId: string, characterId: string): Promise<CharacterRestoreResult> {
    const outcome = await this.dataSource.transaction<{ changed: boolean }>(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const repo = manager.getRepository(CharacterEntity);
      const character = await repo
        .createQueryBuilder('c')
        .setLock('pessimistic_write')
        .where('c.id = :characterId AND c.work_id = :workId', { characterId, workId })
        .getOne();
      if (!character) throw new NotFoundException('角色不存在');
      if (character.status === 'merged') {
        throw new ConflictException({ code: 'CHARACTER_MERGED', message: '已合并角色不可恢复' });
      }
      if (character.status === 'active') {
        return { changed: false };
      }

      await repo.update(
        { id: characterId },
        {
          status: 'active',
          archived_at: null,
          archived_by: null,
          version: character.version + 1,
          updated_at: new Date()
        }
      );
      await manager
        .getRepository(CharacterGrowthEventEntity)
        .createQueryBuilder()
        .update()
        .set({ status: 'active', archived_at: null })
        .where('character_id = :characterId', { characterId })
        .execute();

      // 无锚点服务时在事务内直接失效（测试场景 new CharacterService(ds, audit)）
      if (!this.anchors) {
        await manager
          .getRepository(CharacterTextAnchorEntity)
          .createQueryBuilder()
          .update()
          .set({ status: 'invalid', invalid_reason: 'character_restored' })
          .where('work_id = :workId AND character_id = :characterId AND status = :status', {
            workId,
            characterId,
            status: 'active'
          })
          .execute();
      }

      // 扫描中恢复：pending/running 置 failed
      await manager
        .getRepository(CharacterArchiveScanEntity)
        .createQueryBuilder()
        .update()
        .set({ status: 'failed', finished_at: new Date(), error: { code: 'CHARACTER_RESTORED' } })
        .where('character_id = :characterId AND status IN (:...statuses)', {
          characterId,
          statuses: ['pending', 'running']
        })
        .execute();

      await this.audit.record(authorId, 'character_restore', 'character', characterId, {}, workId, manager);
      return { changed: true };
    });

    if (outcome.changed && this.anchors) {
      await this.anchors.markAnchorsRestored(authorId, workId, characterId);
    }

    const character = await this.get(authorId, workId, characterId);
    const duplicate_candidates = outcome.changed
      ? await this.findDuplicateCandidates(authorId, workId, characterId)
      : [];
    return { changed: outcome.changed, character, duplicate_candidates };
  }

  private async findDuplicateCandidates(
    authorId: string,
    workId: string,
    characterId: string
  ): Promise<DuplicateCandidate[]> {
    const groups = await this.findDuplicates(authorId, workId);
    const related = groups.filter((group) => group.character_ids.includes(characterId));
    const otherIds = new Set<string>();
    for (const group of related) {
      for (const id of group.character_ids) {
        if (id !== characterId) otherIds.add(id);
      }
    }
    const characters = otherIds.size
      ? await this.dataSource.getRepository(CharacterEntity).find({ where: { id: In([...otherIds]) } })
      : [];
    const nameById = new Map(characters.map((c) => [c.id, c.name]));

    const seen = new Set<string>();
    const candidates: DuplicateCandidate[] = [];
    for (const group of related) {
      for (const id of group.character_ids) {
        if (id === characterId || seen.has(id)) continue;
        const name = nameById.get(id);
        if (!name) continue;
        seen.add(id);
        candidates.push({ character_id: id, name, matched_on: group.matched_on });
        if (candidates.length >= 50) return candidates;
      }
    }
    return candidates;
  }

  private async computeArchiveImpact(
    manager: EntityManager,
    workId: string,
    characterId: string
  ): Promise<ArchiveImpact> {
    const relations = await manager.getRepository(CharacterRelationEntity).count({
      where: [{ work_id: workId, source_id: characterId }, { work_id: workId, target_id: characterId }]
    });
    const growth_events = await manager
      .getRepository(CharacterGrowthEventEntity)
      .count({ where: { work_id: workId, character_id: characterId } });
    const chapters = await manager.getRepository(ChapterEntity).count({ where: { work_id: workId } });
    const exclusive_plot_nodes = await this.countExclusiveHiddenNodes(manager, workId, characterId);
    return { relations, growth_events, chapters, exclusive_plot_nodes };
  }

  /**
   * 归档后将被隐藏的专属剧情节点数：
   * 该角色为 is_exclusive 归属者，且这些节点上其他 is_exclusive 归属角色全部非 active。
   */
  private async countExclusiveHiddenNodes(
    manager: EntityManager,
    workId: string,
    characterId: string
  ): Promise<number> {
    const ownerRepo = manager.getRepository(PlotNodeCharacterOwnerEntity);
    const mine = await ownerRepo.find({ where: { work_id: workId, character_id: characterId, is_exclusive: true } });
    const nodeIds = Array.from(new Set(mine.map((o) => o.node_id)));
    if (nodeIds.length === 0) return 0;

    const validNodes = await manager
      .getRepository(PlotNodeEntity)
      .createQueryBuilder('n')
      .innerJoin(PlotTreeEntity, 't', 't.id = n.tree_id AND t.work_id = :workId', { workId })
      .where('n.id IN (:...nodeIds)', { nodeIds })
      .select('n.id', 'id')
      .getRawMany<{ id: string }>();
    const validIds = validNodes.map((n) => n.id);
    if (validIds.length === 0) return 0;

    const allExclusive = await ownerRepo.find({ where: { node_id: In(validIds), is_exclusive: true } });
    const others = allExclusive.filter((o) => o.character_id !== characterId);
    const otherIds = Array.from(new Set(others.map((o) => o.character_id)));
    const characters = otherIds.length
      ? await manager.getRepository(CharacterEntity).find({ where: { id: In(otherIds) } })
      : [];
    const statusById = new Map(characters.map((c) => [c.id, c.status]));

    let count = 0;
    for (const nodeId of validIds) {
      const nodeOthers = others.filter((o) => o.node_id === nodeId);
      const anyActive = nodeOthers.some((o) => statusById.get(o.character_id) === 'active');
      if (!anyActive) count += 1;
    }
    return count;
  }

  private async createOrReusePendingScan(
    manager: EntityManager,
    workId: string,
    characterId: string,
    authorId: string,
    totalChapters: number
  ): Promise<CharacterArchiveScanEntity> {
    // 部分唯一索引兜底：同角色同时只允许一次 pending/running，冲突时复用既有扫描
    await manager.query(
      `INSERT INTO character_archive_scans
         (id, work_id, character_id, requested_by, status, total_chapters, scanned_chapters, matched_paragraphs, started_at)
       VALUES ($1, $2, $3, $4, 'pending', $5, 0, 0, now())
       ON CONFLICT (character_id) WHERE status IN ('pending', 'running') DO NOTHING`,
      [randomUUID(), workId, characterId, authorId, totalChapters]
    );
    const scan = await manager.getRepository(CharacterArchiveScanEntity).findOne({
      where: { character_id: characterId, status: In(['pending', 'running'] as ArchiveScanStatus[]) },
      order: { created_at: 'DESC' }
    });
    if (!scan) throw new Error('归档扫描创建失败');
    return scan;
  }
}
