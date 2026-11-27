import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { EntityManager } from 'typeorm';
import { CharacterEntity } from '../character.entity';
import { CharacterRelationEntity } from '../character-relation.entity';
import { CharacterRelationTypeEntity } from '../character-relation-type.entity';
import { seedCharacterRelationTypes } from '../character-relation-type.seed';
import { resolveNewId } from './id-map';

// M4-T11 角色域映射：projects/<id>.json 的 roles[] → characters，roles[].relations[] → character_relations。
// 关系类型归一：旧 relation_type 'ally' → 'camp_ally'，'enemy' → 'camp_hostile'（M3c-2 默认种子）。
// 旧数据无 author 概念，work_id 由 project_id 推断（resolveNewId('work', projectId)）。

/** 旧关系类型 → 新关系类型 code（归一映射） */
const RELATION_TYPE_MAP: Record<string, string> = {
  ally: 'camp_ally',
  enemy: 'camp_hostile'
};

/** data/projects/<id>.json 的 roles[] 元素（仅声明用到的字段） */
export interface LegacyRoleSource {
  id: string;
  project_id?: string;
  name: string;
  age?: number | null;
  gender?: string | null;
  status?: string;
  created_at?: string;
  updated_at?: string;
  identity?: string | null;
  nationality?: string | null;
  faith?: string | null;
  camp?: string | null;
  race?: string | null;
  profession?: string | null;
  age_group?: string | null;
  attributes?: Record<string, unknown> | Array<{ key: string; value: string }>;
  relations?: Array<{
    target_role_id: string;
    relation_type: string;
    note?: string;
  }>;
  personality?: string;
  background?: string;
  appearance?: string;
  avatar?: string;
}

export interface CharacterMigrateResult {
  characters: number;
  relations: number;
  relationTypes: number;
  skipped: number;
}

function toDate(value?: string): Date {
  if (!value) return new Date();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

// 旧 attributes 为 {key: value} 对象，新表为 [{key, value}] 数组
function normalizeAttributes(
  attributes?: Record<string, unknown> | Array<{ key: string; value: string }>
): Array<{ key: string; value: string }> {
  if (Array.isArray(attributes)) return attributes;
  if (attributes && typeof attributes === 'object') {
    return Object.entries(attributes).map(([key, value]) => ({
      key,
      value: typeof value === 'string' ? value : JSON.stringify(value)
    }));
  }
  return [];
}

/**
 * 迁移角色域：projects/<id>.json 的 roles[] → characters + character_relations。
 * 每作品先补种关系类型（幂等 ON CONFLICT DO NOTHING），角色关系归一后按类型 code 查 type_id。
 * 幂等：按 character.id（resolveNewId('character', id)）查重。
 */
export async function migrateCharacters(
  tx: EntityManager,
  sourceDir: string
): Promise<CharacterMigrateResult> {
  const projectsDir = path.join(sourceDir, 'projects');
  const result: CharacterMigrateResult = { characters: 0, relations: 0, relationTypes: 0, skipped: 0 };

  let projectFiles: string[] = [];
  try {
    projectFiles = (await fs.readdir(projectsDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return result;
  }

  for (const file of projectFiles) {
    const raw = JSON.parse(await fs.readFile(path.join(projectsDir, file), 'utf8')) as {
      id?: string;
      roles?: LegacyRoleSource[];
    };
    if (!raw.id || !Array.isArray(raw.roles) || raw.roles.length === 0) continue;

    const workId = await resolveNewId(tx, 'work', raw.id);

    // 补种关系类型（幂等），并收集 work 内 type 索引
    await seedCharacterRelationTypes(tx, workId);
    const typeRows = await tx.find(CharacterRelationTypeEntity, { where: { work_id: workId } });
    const typeByCode = new Map(typeRows.map((t) => [t.code, t]));
    result.relationTypes += typeRows.length;

    // 先迁移所有角色，再迁移关系（保证 source/target 外键已存在）
    const migratedRoleIds = new Set<string>();
    for (const role of raw.roles) {
      if (!role.id) continue;
      const charId = await resolveNewId(tx, 'character', role.id);
      const existing = await tx.findOne(CharacterEntity, { where: { id: charId } });
      if (existing) {
        result.skipped += 1;
        migratedRoleIds.add(role.id);
        continue;
      }

      await tx.save(CharacterEntity, {
        id: charId,
        work_id: workId,
        name: role.name,
        name_key: role.name, // 归一化名：旧数据无单独字段，用原名（仅用于疑似重复检索）
        identity: role.identity || null,
        age: role.age ?? null,
        gender: role.gender || null,
        personality: role.personality ?? '',
        experience: role.background ?? '', // 旧 background → experience（经历）
        country_region: role.nationality || null,
        faith: role.faith || null,
        faction: role.camp || null, // 旧 camp（阵营）→ faction
        race: role.race || null,
        occupation: role.profession || null,
        age_band: role.age_group || null,
        attributes: normalizeAttributes(role.attributes),
        avatar_asset_id: role.avatar ? await resolveNewId(tx, 'avatar_asset', role.avatar) : null,
        status: (role.status as CharacterEntity['status']) ?? 'active',
        origin: 'manual',
        version: 1,
        created_at: toDate(role.created_at),
        updated_at: toDate(role.updated_at)
      });
      result.characters += 1;
      migratedRoleIds.add(role.id);
    }

    // 迁移关系（需在角色全部落库后）
    for (const role of raw.roles) {
      if (!role.id || !Array.isArray(role.relations)) continue;
      const sourceId = await resolveNewId(tx, 'character', role.id);
      for (const rel of role.relations) {
        if (!rel.target_role_id) continue;
        // 目标角色未迁移（数据异常）则跳过，保证外键完整
        if (!migratedRoleIds.has(rel.target_role_id)) continue;

        const newTypeCode = RELATION_TYPE_MAP[rel.relation_type] ?? rel.relation_type;
        const typeRow = typeByCode.get(newTypeCode);
        if (!typeRow) continue; // 未识别类型跳过，不落孤儿外键

        const targetId = await resolveNewId(tx, 'character', rel.target_role_id);
        const pairKey = [sourceId, targetId].sort().join('|');
        const existingRel = await tx.findOne(CharacterRelationEntity, {
          where: { work_id: workId, pair_key: pairKey, type_id: typeRow.id }
        });
        if (existingRel) continue;

        const directed = typeRow.directed;
        await tx.save(CharacterRelationEntity, {
          id: await resolveNewId(
            tx,
            'character_relation',
            `${role.id}:${rel.target_role_id}:${rel.relation_type}`
          ),
          work_id: workId,
          source_id: sourceId,
          target_id: targetId,
          type_id: typeRow.id,
          directed,
          pair_key: pairKey,
          label: typeRow.label,
          reverse_label: typeRow.reverse_label,
          color: typeRow.group_key === 'camp' ? (newTypeCode === 'camp_ally' ? '#16a34a' : '#dc2626') : '#6b7280',
          line_style: 'solid',
          tag: rel.note || typeRow.label,
          origin: 'manual',
          created_at: toDate(role.created_at),
          updated_at: toDate(role.updated_at)
        });
        result.relations += 1;
      }
    }
  }

  return result;
}
