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
  CharacterExportFile,
  CharacterImportFile,
  CharacterImportConflict,
  CharacterImportSummary,
  CharacterImportCommitRequest
} from '@storyforge/contracts';
import type { PortabilityMode } from '../database/character-enums';
import { ChapterEntity } from '../database/chapter.entity';
import { CharacterAliasEntity } from '../database/character-alias.entity';
import { CharacterEntity } from '../database/character.entity';
import { CharacterGrowthEventEntity } from '../database/character-growth-event.entity';
import { CharacterPortabilityJobEntity } from '../database/character-portability-job.entity';
import { CharacterRelationEntity } from '../database/character-relation.entity';
import { CharacterRelationTypeEntity } from '../database/character-relation-type.entity';
import { CharacterTextAnchorEntity } from '../database/character-text-anchor.entity';
import { CharacterViewEntity } from '../database/character-view.entity';
import { CharacterViewNodeEntity } from '../database/character-view-node.entity';
import { WorkEntity } from '../database/work.entity';
import { AuditService } from '../revision/audit.service';
import { computePairKey } from './character-candidate.normalize';
import { RELATION_COLOR_PALETTE } from './character-relation.service';

// F2 §3.5、§4.8、§5.9、§8.1 角色域导入导出服务
// - export：active+archived（不含 merged）、被使用关系类型+自定义、视图有坐标、锚点无 hash
// - previewImport：零写入业务表，只写 job 表，返回 conflicts
// - commitImport：单事务，校验 preview 归属+版本，幂等重放，失败整体回滚

interface ExportOptions {
  include_archived?: boolean; // 默认 true
  include_anchors?: boolean; // 默认 true
}

interface ImportPreviewInput {
  file: CharacterImportFile;
  idempotency_key?: string;
}

interface CharacterImportResolutionLocal {
  local_id: string;
  action: 'create' | 'merge' | 'keep_independent';
  target_character_id?: string;
}

interface ImportCommitInput {
  preview_job_id: string;
  file: CharacterImportFile;
  idempotency_key: string;
  mode: PortabilityMode;
  confirm_overwrite?: boolean;
  resolutions: CharacterImportResolutionLocal[];
}

interface CharacterImportPreviewResponseLocal {
  preview_job_id: string;
  summary: CharacterImportSummary;
  conflicts: CharacterImportConflict[];
}

@Injectable()
export class CharacterPortabilityService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly audit: AuditService
  ) {}

  private async assertOwnedWork(manager: EntityManager, authorId: string, workId: string): Promise<void> {
    const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('作品不存在');
  }

  // ──────────────────── 1. 导出 ────────────────────

  async export(
    authorId: string,
    workId: string,
    options: ExportOptions = {}
  ): Promise<CharacterExportFile> {
    const manager = this.dataSource.manager;
    await this.assertOwnedWork(manager, authorId, workId);
    const work = await manager.getRepository(WorkEntity).findOneByOrFail({ id: workId });

    const includeArchived = options.include_archived !== false; // 默认 true
    const includeAnchors = options.include_anchors !== false;

    const charRepo = manager.getRepository(CharacterEntity);
    const charFilter: Record<string, unknown> = { work_id: workId };
    if (includeArchived) {
      charFilter['status'] = In(['active', 'archived']);
    } else {
      charFilter['status'] = 'active';
    }
    const characters = await charRepo.find({ where: charFilter });

    // 分配 local_id
    const localIdMap = new Map<string, string>();
    characters.forEach((c, idx) => localIdMap.set(c.id, `chr_${idx.toString(36)}`));

    // aliases
    const aliasRepo = manager.getRepository(CharacterAliasEntity);
    const aliases = await aliasRepo.find({ where: { work_id: workId, character_id: In([...localIdMap.keys()]) } });

    // relations + types（只保留两端都在导出范围内的关系）
    const relRepo = manager.getRepository(CharacterRelationEntity);
    const rels = await relRepo.find({ where: { work_id: workId } });
    const exportedRels = rels.filter(
      (r) => localIdMap.has(r.source_id) && localIdMap.has(r.target_id)
    );
    const usedTypeIds = new Set(exportedRels.map((r) => r.type_id));

    const typeRepo = manager.getRepository(CharacterRelationTypeEntity);
    const allTypes = await typeRepo.find({ where: { work_id: workId } });
    // 被使用（usedTypeIds）+ 自定义（is_builtin=false）
    const exportedTypes = allTypes.filter(
      (t) => usedTypeIds.has(t.id) || !t.is_builtin
    );

    // growth events（character_id 在导出范围内）
    const growthRepo = manager.getRepository(CharacterGrowthEventEntity);
    const growths = await growthRepo.find({ where: { work_id: workId, character_id: In([...localIdMap.keys()]) } });

    // views + nodes（只导出有坐标 x/y 都非空的视图）
    const viewRepo = manager.getRepository(CharacterViewEntity);
    const nodeRepo = manager.getRepository(CharacterViewNodeEntity);
    const viewsAll = await viewRepo.find({ where: { work_id: workId } });
    const nodesAll = await nodeRepo.find({ where: { view_id: In([...viewsAll.map((v) => v.id)]) } });
    const nodesByView = new Map<string, typeof nodesAll>();
    for (const n of nodesAll) {
      const arr = nodesByView.get(n.view_id) ?? [];
      arr.push(n);
      nodesByView.set(n.view_id, arr);
    }
    const exportedViews = viewsAll
      .map((v) => {
        const nodes = nodesByView.get(v.id) ?? [];
        const layout = nodes
          .filter((n) => n.x !== null && n.y !== null && localIdMap.has(n.character_id))
          .map((n) => ({
            character_local_id: localIdMap.get(n.character_id)!,
            x: n.x as number,
            y: n.y as number
          }));
        if (layout.length === 0) return null; // 只导出有坐标
        return { name: v.name, filters: v.filters ?? {}, layout };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);

    // anchors（不含 excerpt_hash）
    let anchors: Array<Record<string, unknown>> = [];
    if (includeAnchors) {
      const anchorRepo = manager.getRepository(CharacterTextAnchorEntity);
      const aRows = await anchorRepo.find({
        where: {
          work_id: workId,
          character_id: In([...localIdMap.keys()]),
          status: In(['active', 'dismissed', 'invalid'])
        }
      });
      anchors = aRows.map((a) => ({
        character_local_id: localIdMap.get(a.character_id),
        chapter_id: a.chapter_id,
        paragraph_pid: a.paragraph_pid,
        excerpt: a.excerpt,
        status: a.status
        // 不含 excerpt_hash
      }));
    }

    const result: CharacterExportFile = {
      schema_version: 2,
      exported_at: new Date().toISOString(),
      work: { id: workId, title: work.title },
      relation_types: exportedTypes.map((t) => ({
        code: t.code,
        label: t.label,
        group_key: t.group_key,
        group_label: t.group_label,
        directed: t.directed,
        reverse_label: t.reverse_label,
        is_builtin: t.is_builtin
      })),
      characters: characters.map((c, idx) => ({
        local_id: `chr_${idx.toString(36)}`,
        name: c.name,
        identity: c.identity,
        age: c.age,
        gender: c.gender,
        personality: c.personality,
        experience: c.experience,
        country_region: c.country_region,
        faith: c.faith,
        faction: c.faction,
        race: c.race,
        occupation: c.occupation,
        age_band: c.age_band,
        attributes: c.attributes,
        aliases: aliases
          .filter((a) => a.character_id === c.id)
          .map((a) => a.alias),
        origin: c.origin
      })),
      relations: exportedRels.map((r) => ({
        source_local_id: localIdMap.get(r.source_id)!,
        target_local_id: localIdMap.get(r.target_id)!,
        type_code: allTypes.find((t) => t.id === r.type_id)!.code,
        directed: r.directed,
        label: r.label,
        reverse_label: r.reverse_label ?? undefined,
        color: r.color,
        line_style: r.line_style,
        tag: r.tag,
        origin: r.origin
      })),
      growth_events: growths.map((g) => ({
        character_local_id: localIdMap.get(g.character_id)!,
        title: g.title,
        content: g.content,
        event_time: g.event_time ?? undefined,
        plot_node_title: g.plot_node_title ?? undefined,
        chapter_title: null, // 旧版本事件 chapter_id 可能为空
        origin: g.origin
      })),
      views: exportedViews,
      anchors: anchors as never
    };

    await this.audit.record(
      authorId, 'character_portability_export', 'character_portability_job', workId,
      { character_count: characters.length, relation_count: exportedRels.length },
      workId
    );
    return result;
  }

  // ──────────────────── 2. preview 导入 ────────────────────

  async previewImport(
    authorId: string,
    workId: string,
    input: ImportPreviewInput
  ): Promise<CharacterImportPreviewResponseLocal> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const jobRepo = manager.getRepository(CharacterPortabilityJobEntity);

      // 幂等：同 idempotency_key 重放返回首次 preview
      if (input.idempotency_key) {
        const existing = await jobRepo.findOneBy({
          work_id: workId,
          kind: 'import_preview',
          idempotency_key: input.idempotency_key
        });
        if (existing && existing.status === 'succeeded') {
          return {
            preview_job_id: existing.id,
            summary: existing.summary as CharacterImportSummary,
            conflicts: existing.conflicts as CharacterImportConflict[]
          };
        }
      }

      const conflicts: CharacterImportConflict[] = [];
      const summary: CharacterImportSummary = {
        characters: input.file.characters.length,
        relations: input.file.relations.length,
        growth_events: input.file.growth_events.length,
        views: input.file.views.length,
        relation_types: input.file.relation_types.length,
        anchors: input.file.anchors?.length ?? 0,
        restored_anchors: 0,
        discarded_anchors: 0,
        skipped_relations: 0,
        conflicts: 0
      };

      const charRepo = manager.getRepository(CharacterEntity);
      const existingChars = await charRepo.find({ where: { work_id: workId } });
      const nameMap = new Map<string, CharacterEntity[]>();
      for (const c of existingChars) {
        const arr = nameMap.get(c.name) ?? [];
        arr.push(c);
        nameMap.set(c.name, arr);
      }

      // 2a. 角色名冲突
      for (const fc of input.file.characters) {
        const matches = nameMap.get(fc.name);
        if (matches && matches.length > 0) {
          conflicts.push({
            type: 'character_duplicate',
            local_id: fc.local_id,
            message: `角色名 "${fc.name}" 已存在`,
            matches: matches.map((m) => ({
              character_id: m.id,
              name: m.name,
              matched_on: 'name'
            }))
          });
        }
      }

      // 2b. relation_types：目标作品已有 + file.relation_types 也有同 code → 冲突（重复）
      const typeRepo = manager.getRepository(CharacterRelationTypeEntity);
      const existingTypes = await typeRepo.find({ where: { work_id: workId } });
      const existingTypeCodes = new Set(existingTypes.map((t) => t.code));
      for (const ft of input.file.relation_types) {
        if (existingTypeCodes.has(ft.code)) {
          // 不直接冲突——关系类型冲突不是任务描述里说的；按任务描述冲突类型是 5 种
          // 但 relations 引用了未知 type_code → unknown_relation_type
        }
      }

      // 2c. relations：unknown_relation_type / duplicate_relation / dangling_relation
      const localIdToFc = new Map<string, number>(); // local_id → file index
      input.file.characters.forEach((c, i) => localIdToFc.set(c.local_id, i));
      const fileTypeCodes = new Set(input.file.relation_types.map((t) => t.code));
      const targetTypeCodes = new Set([...existingTypeCodes, ...fileTypeCodes]);

      const pairMap = new Map<string, number>(); // pair_key + type_code → 出现次数
      for (let i = 0; i < input.file.relations.length; i++) {
        const r = input.file.relations[i]!;
        if (!targetTypeCodes.has(r.type_code)) {
          conflicts.push({
            type: 'unknown_relation_type',
            local_id: `${i}`,
            message: `关系类型 code "${r.type_code}" 不存在于目标作品`
          });
          continue;
        }
        if (!localIdToFc.has(r.source_local_id) || !localIdToFc.has(r.target_local_id)) {
          conflicts.push({
            type: 'dangling_relation',
            local_id: `${i}`,
            message: '关系引用了不存在的角色 local_id'
          });
          continue;
        }
        const pair = [r.source_local_id, r.target_local_id].sort().join('~') + '|' + r.type_code;
        const cnt = (pairMap.get(pair) ?? 0) + 1;
        pairMap.set(pair, cnt);
        if (cnt > 1) {
          conflicts.push({
            type: 'duplicate_relation',
            local_id: `${i}`,
            message: '关系重复（同对角色+同类型）'
          });
        }
      }

      // 2d. views：name 冲突
      const viewRepo = manager.getRepository(CharacterViewEntity);
      const existingViews = await viewRepo.find({ where: { work_id: workId } });
      const existingViewNames = new Set(existingViews.map((v) => v.name));
      for (const fv of input.file.views) {
        if (existingViewNames.has(fv.name)) {
          conflicts.push({
            type: 'view_name_conflict',
            local_id: fv.name,
            message: `视图名 "${fv.name}" 已存在`
          });
        }
      }

      summary.conflicts = conflicts.length;

      // 写 job 表（这是唯一写入）
      const jobRepo2 = manager.getRepository(CharacterPortabilityJobEntity);
      const job = await jobRepo2.save(
        jobRepo2.create({
          id: randomUUID(),
          work_id: workId,
          kind: 'import_preview',
          status: 'succeeded',
          schema_version: input.file.schema_version,
          mode: null,
          idempotency_key: input.idempotency_key ?? null,
          summary,
          conflicts,
          error: null
        })
      );
      await manager.update(
        CharacterPortabilityJobEntity,
        { id: job.id },
        { finished_at: new Date() }
      );

      await this.audit.record(
        authorId, 'character_portability_preview', 'character_portability_job', job.id,
        { conflict_count: conflicts.length, character_count: summary.characters },
        workId, manager
      );

      return { preview_job_id: job.id, summary, conflicts };
    });
  }

  // ──────────────────── 3. commit 导入 ────────────────────

  async commitImport(
    authorId: string,
    workId: string,
    input: ImportCommitInput
  ): Promise<CharacterImportSummary> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);

      // 3a. 幂等：同 idempotency_key 重放返回首次结果
      const jobRepo = manager.getRepository(CharacterPortabilityJobEntity);
      const existing = await jobRepo.findOneBy({
        work_id: workId,
        kind: 'import_commit',
        idempotency_key: input.idempotency_key
      });
      if (existing) {
        if (existing.status === 'succeeded') return existing.summary as CharacterImportSummary;
        // failed → 允许重试覆盖
      }

      // 3b. 校验 preview_job_id 归属 + 版本
      const preview = await jobRepo.findOneBy({ id: input.preview_job_id, work_id: workId });
      if (!preview || preview.kind !== 'import_preview') {
        throw new NotFoundException('预览作业不存在或不归属本作品');
      }
      if (preview.schema_version !== input.file.schema_version) {
        throw new ConflictException({
          code: 'PORTABILITY_SCHEMA_MISMATCH',
          message: '预览与提交的 schema_version 不一致'
        });
      }

      // 3c. replace 模式必须 confirm_overwrite
      if (input.mode === 'replace' && !input.confirm_overwrite) {
        throw new ConflictException({
          code: 'PORTABILITY_REPLACE_UNCONFIRMED',
          message: 'replace 模式必须显式 confirm_overwrite=true'
        });
      }

      // 3d. 校验 resolution 覆盖全部 conflict
      const unresolved = (preview.conflicts as CharacterImportConflict[]).filter(
        (c) => c.type === 'character_duplicate'
      );
      const localIdResolved = new Set(input.resolutions.map((r) => r.local_id));
      const missingRes = unresolved.find((c) => !localIdResolved.has(c.local_id!));
      if (missingRes) {
        throw new ConflictException({
          code: 'PORTABILITY_MISSING_RESOLUTION',
          message: `冲突角色 ${missingRes.local_id} 未指定 resolution`
        });
      }

      const previewId = preview.id;
      const job = await jobRepo.save(
        jobRepo.create({
          id: randomUUID(),
          work_id: workId,
          kind: 'import_commit',
          status: 'succeeded',
          schema_version: input.file.schema_version,
          mode: input.mode,
          idempotency_key: input.idempotency_key,
          summary: {},
          conflicts: preview.conflicts,
          error: null
        })
      );

      try {
        const summary = await this.doImport(manager, workId, input);
        job.summary = summary as unknown as Record<string, unknown>;
        job.finished_at = new Date();
        await jobRepo.save(job);

        await this.audit.record(
          authorId, 'character_portability_commit', 'character_portability_job', job.id,
          { mode: input.mode, summary }, workId, manager
        );
        return summary;
      } catch (err) {
        job.status = 'failed';
        job.error = {
          code: 'PORTABILITY_COMMIT_FAILED',
          message: err instanceof Error ? err.message : String(err)
        };
        job.finished_at = new Date();
        await jobRepo.save(job);
        throw err;
      }
    });
  }

  // ──────────────────── 核心导入逻辑（在调用方 transaction 内） ────────────────────

  /** 作业详情（跨作品 404） */
  async getJob(
    authorId: string,
    workId: string,
    jobId: string
  ): Promise<CharacterPortabilityJobEntity> {
    const manager = this.dataSource.manager;
    await this.assertOwnedWork(manager, authorId, workId);
    const job = await manager
      .getRepository(CharacterPortabilityJobEntity)
      .findOneBy({ id: jobId, work_id: workId });
    if (!job) throw new NotFoundException('导入导出作业不存在');
    return job;
  }

  private async doImport(
    manager: EntityManager,
    workId: string,
    input: ImportCommitInput
  ): Promise<CharacterImportSummary> {
    const f = input.file;

    // replace 清空角色域
    if (input.mode === 'replace') {
      await this.clearCharacterDomain(manager, workId);
    }

    const charRepo = manager.getRepository(CharacterEntity);
    const aliasRepo = manager.getRepository(CharacterAliasEntity);
    const typeRepo = manager.getRepository(CharacterRelationTypeEntity);
    const relRepo = manager.getRepository(CharacterRelationEntity);
    const growthRepo = manager.getRepository(CharacterGrowthEventEntity);
    const viewRepo = manager.getRepository(CharacterViewEntity);
    const nodeRepo = manager.getRepository(CharacterViewNodeEntity);
    const anchorRepo = manager.getRepository(CharacterTextAnchorEntity);
    const chapterRepo = manager.getRepository(ChapterEntity);
    const workRepo = manager.getRepository(WorkEntity);

    const work = await workRepo.findOneByOrFail({ id: workId });

    // 1. 解析 resolution
    const resolutionMap = new Map<string, CharacterImportResolutionLocal>();
    for (const r of input.resolutions) resolutionMap.set(r.local_id, r);

    // 2. 导入角色 + 建 local_id → target UUID 映射
    const localToTargetId = new Map<string, string>();
    let characterCount = 0;
    for (const fc of f.characters) {
      const resolution = resolutionMap.get(fc.local_id);
      let targetId: string;

      if (resolution?.action === 'merge' && resolution.target_character_id) {
        // 合并：只填空字段
        const target = await charRepo.findOneBy({ id: resolution.target_character_id, work_id: workId });
        if (!target) {
          throw new BadRequestException(`merge 目标角色不存在：${resolution.target_character_id}`);
        }
        let changed = false;
        const authorFields = ['identity', 'age', 'gender'] as const;
        for (const field of authorFields) {
          const val = fc[field];
          if (val !== undefined && val !== null && (target[field] === null || target[field] === '' || target[field] === undefined)) {
            (target as unknown as Record<string, unknown>)[field] = val;
            changed = true;
          }
        }
        if (fc.personality && !target.personality) {
          target.personality = fc.personality;
          changed = true;
        }
        if (fc.experience && !target.experience) {
          target.experience = fc.experience;
          changed = true;
        }
        if (fc.age_band && !target.age_band) {
          target.age_band = fc.age_band;
          changed = true;
        }
        if (changed) target.version = target.version + 1;
        await charRepo.save(target);
        targetId = target.id;
      } else if (resolution?.action === 'keep_independent') {
        // keep_independent：重名但独立建（需要避免 name_key 冲突，这里简单加后缀；真实业务建议强制改名）
        targetId = randomUUID();
        const baseName = fc.name;
        let name = baseName;
        let suffix = 1;
        while (await charRepo.findOneBy({ work_id: workId, name })) {
          name = `${baseName} (导入${suffix++})`;
        }
        const saved = await charRepo.save(
          charRepo.create({
            id: targetId, work_id: workId,
            name, name_key: this.normalize(name),
            identity: fc.identity ?? null,
            age: fc.age ?? null,
            gender: fc.gender ?? null,
            personality: fc.personality,
            experience: fc.experience,
            country_region: fc.country_region ?? null,
            faith: fc.faith ?? null,
            faction: fc.faction ?? null,
            race: fc.race ?? null,
            occupation: fc.occupation ?? null,
            age_band: fc.age_band ?? null,
            attributes: fc.attributes ?? [],
            avatar_asset_id: null,
            status: 'active',
            merged_into_id: null,
            archived_at: null,
            archived_by: null,
            origin: 'import',
            version: 1
          })
        );
        targetId = saved.id;
      } else {
        // create：正常新建；若目标作品已有同名（但没给 resolution），则重名导入（replace 模式清空了就正常）
        targetId = randomUUID();
        const saved = await charRepo.save(
          charRepo.create({
            id: targetId, work_id: workId,
            name: fc.name, name_key: this.normalize(fc.name),
            identity: fc.identity ?? null,
            age: fc.age ?? null,
            gender: fc.gender ?? null,
            personality: fc.personality,
            experience: fc.experience,
            country_region: fc.country_region ?? null,
            faith: fc.faith ?? null,
            faction: fc.faction ?? null,
            race: fc.race ?? null,
            occupation: fc.occupation ?? null,
            age_band: fc.age_band ?? null,
            attributes: fc.attributes ?? [],
            avatar_asset_id: null,
            status: 'active',
            merged_into_id: null,
            archived_at: null,
            archived_by: null,
            origin: fc.origin ?? 'import',
            version: 1
          })
        );
        targetId = saved.id;
      }
      localToTargetId.set(fc.local_id, targetId);
      characterCount++;

      // aliases
      if (fc.aliases && fc.aliases.length) {
        for (const alias of fc.aliases) {
          const existing = await aliasRepo.findOneBy({ work_id: workId, character_id: targetId, alias });
          if (!existing) {
            await aliasRepo.save(
              aliasRepo.create({
                id: randomUUID(), work_id: workId, character_id: targetId,
                alias, alias_key: this.normalize(alias)
              })
            );
          }
        }
      }
    }

    // 3. 关系类型：file 里 code 不存在的新建
    const existingTypes = await typeRepo.find({ where: { work_id: workId } });
    const typeByCode = new Map(existingTypes.map((t) => [t.code, t]));
    for (const ft of f.relation_types) {
      if (typeByCode.has(ft.code)) continue;
      const saved = await typeRepo.save(
        typeRepo.create({
          id: randomUUID(), work_id: workId,
          code: ft.code, label: ft.label,
          group_key: ft.group_key, group_label: ft.group_label,
          directed: ft.directed, reverse_label: ft.reverse_label ?? null,
          is_builtin: ft.is_builtin, sort_order: 100
        })
      );
      typeByCode.set(ft.code, saved);
    }

    // 4. 关系：pair_key + type_id 撞 → skip
    let relationCount = 0;
    let skippedRelations = 0;
    const exportedRelKeys = new Set<string>();
    for (const r of f.relations) {
      const sourceId = localToTargetId.get(r.source_local_id);
      const targetId = localToTargetId.get(r.target_local_id);
      if (!sourceId || !targetId) {
        skippedRelations++;
        continue;
      }
      const type = typeByCode.get(r.type_code);
      if (!type) {
        skippedRelations++;
        continue;
      }
      const pairKey = computePairKey(sourceId, targetId);
      const existing = await relRepo.findOneBy({ work_id: workId, pair_key: pairKey, type_id: type.id });
      if (existing || exportedRelKeys.has(pairKey + '|' + type.id)) {
        skippedRelations++;
        continue;
      }
      const color = r.color ?? RELATION_COLOR_PALETTE[(relationCount + existingTypes.length) % RELATION_COLOR_PALETTE.length]!;
      await relRepo.save(
        relRepo.create({
          id: randomUUID(), work_id: workId,
          source_id: sourceId, target_id: targetId, type_id: type.id,
          directed: r.directed, pair_key: pairKey,
          label: r.label, reverse_label: r.reverse_label ?? null,
          color, line_style: r.line_style ?? 'solid',
          tag: r.tag ?? r.label, origin: r.origin ?? 'import'
        })
      );
      exportedRelKeys.add(pairKey + '|' + type.id);
      relationCount++;
    }

    // 5. 成长事件
    let growthCount = 0;
    for (const g of f.growth_events) {
      const charId = localToTargetId.get(g.character_local_id);
      if (!charId) continue;
      await growthRepo.save(
        growthRepo.create({
          id: randomUUID(), work_id: workId, character_id: charId,
          title: g.title, content: g.content,
          event_time: g.event_time ?? null,
          plot_node_id: null,
          plot_node_title: g.plot_node_title ?? null,
          chapter_id: null,
          status: 'active',
          archived_at: null,
          origin: g.origin ?? 'import'
        })
      );
      growthCount++;
    }

    // 6. 视图（重名 → 改名 "原名 (导入)"）
    let viewCount = 0;
    for (const fv of f.views) {
      let name = fv.name;
      let suffix = 1;
      while (await viewRepo.findOneBy({ work_id: workId, name })) {
        name = `${fv.name} (导入${suffix++})`;
      }
      const view = await viewRepo.save(
        viewRepo.create({
          id: randomUUID(), work_id: workId,
          name, is_default: false,
          filters: fv.filters ?? {},
          version: 1, sort_order: 1000 + suffix
        })
      );
      // layout nodes
      for (const layoutItem of fv.layout) {
        const charId = localToTargetId.get(layoutItem.character_local_id);
        if (!charId) continue;
        await nodeRepo.save(
          nodeRepo.create({
            id: randomUUID(), view_id: view.id, character_id: charId,
            x: layoutItem.x, y: layoutItem.y, arranged: true, sort_index: viewCount
          })
        );
      }
      viewCount++;
    }

    // 7. 锚点
    let anchorCount = 0;
    let restoredAnchors = 0;
    let discardedAnchors = 0;
    if (f.anchors && f.anchors.length) {
      const targetChapters = await chapterRepo.find({ where: { work_id: workId } });
      const chapterMap = new Map(targetChapters.map((c) => [c.id, c]));
      for (const fa of f.anchors) {
        const charId = localToTargetId.get(fa.character_local_id);
        if (!charId) {
          discardedAnchors++;
          continue;
        }
        const chapter = chapterMap.get(fa.chapter_id);
        if (!chapter) {
          // 跨作品 chapter_id 不属于目标作品 → discard
          discardedAnchors++;
          continue;
        }
        // 校验 pid 存在
        const doc = chapter.document as unknown as Record<string, unknown>;
        const hasPid = this.docHasPid(doc, fa.paragraph_pid);
        if (!hasPid) {
          discardedAnchors++;
          continue;
        }
        const existingAnchor = await anchorRepo.findOneBy({
          work_id: workId, character_id: charId, chapter_id: chapter.id, paragraph_pid: fa.paragraph_pid
        });
        if (existingAnchor) {
          restoredAnchors++;
          // 如果原状态是 invalid 且现在导入是 active → 复活
          if (existingAnchor.status === 'invalid') {
            existingAnchor.status = fa.status ?? 'active';
            existingAnchor.invalid_reason = null;
            existingAnchor.excerpt = fa.excerpt;
            await anchorRepo.save(existingAnchor);
          }
          continue;
        }
        await anchorRepo.save(
          anchorRepo.create({
            id: randomUUID(), work_id: workId,
            character_id: charId, chapter_id: chapter.id,
            scan_id: randomUUID(), // 不建真实 scan 关系（只是导入）
            paragraph_pid: fa.paragraph_pid,
            matched_name: '',
            excerpt: fa.excerpt,
            excerpt_hash: '', // 导入时无 hash
            status: fa.status ?? 'active',
            invalid_reason: null,
            dismissed_at: null,
            dismissed_by: null
          })
        );
        anchorCount++;
      }
    }

    return {
      characters: characterCount,
      relations: relationCount,
      growth_events: growthCount,
      views: viewCount,
      relation_types: typeByCode.size - existingTypes.length,
      anchors: anchorCount,
      restored_anchors: restoredAnchors,
      discarded_anchors: discardedAnchors,
      skipped_relations: skippedRelations,
      conflicts: 0
    };
  }

  private async clearCharacterDomain(manager: EntityManager, workId: string): Promise<void> {
    const viewRepo = manager.getRepository(CharacterViewEntity);
    const views = await viewRepo.find({ where: { work_id: workId } });
    const viewIds = views.map((v) => v.id);
    if (viewIds.length) {
      await manager.getRepository(CharacterViewNodeEntity).delete({ view_id: In(viewIds) });
    }
    await manager.getRepository(CharacterTextAnchorEntity).delete({ work_id: workId });
    await manager.getRepository(CharacterGrowthEventEntity).delete({ work_id: workId });
    await viewRepo.delete({ work_id: workId });
    await manager.getRepository(CharacterRelationEntity).delete({ work_id: workId });
    await manager.getRepository(CharacterAliasEntity).delete({ work_id: workId });
    await manager.getRepository(CharacterEntity).delete({ work_id: workId });
    // relation_type 保留（builtin 不删；import 来的自定义也清空以便重新导入？这里保留 builtin + 清空自定义）
    const typeRepo = manager.getRepository(CharacterRelationTypeEntity);
    await typeRepo.delete({ work_id: workId, is_builtin: false });
  }

  private docHasPid(doc: Record<string, unknown>, pid: string): boolean {
    if (!doc || typeof doc !== 'object') return false;
    const attrs = (doc as { attrs?: { pid?: string } }).attrs;
    if (attrs && attrs.pid === pid) return true;
    const content = (doc as { content?: unknown[] }).content;
    if (Array.isArray(content)) {
      for (const child of content) {
        if (typeof child === 'object' && child !== null && this.docHasPid(child as Record<string, unknown>, pid)) {
          return true;
        }
      }
    }
    return false;
  }

  private normalize(input: string | null | undefined): string {
    if (!input) return '';
    return input.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[\u2000-\u206F\uFEFF]/g, '');
  }
}
