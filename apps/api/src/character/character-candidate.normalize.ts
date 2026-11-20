import type { CharacterAliasEntity } from '../database/character-alias.entity';
import type { CharacterEntity } from '../database/character.entity';
import type { Character, CharacterDossier, CharacterAttribute } from '@storyforge/contracts';

// ──────────────────────── 名称归一化 ────────────────────────

/**
 * name_key / alias_key 归一化规则（F2 §5.1）：
 * NFKC → trim → 小写 → 去所有空白与间隔符（空格 / Tab / 全角空格 /
 * 下划线 / 短横线 / 点 / 全角下划线 / 全角短横线 / 全角点）。
 *
 * 输入必须是字符串；空串返回空串（服务层调用方应在写入前再做 trim/min 校验）。
 */
export function normalizeName(input: string | null | undefined): string {
  if (!input) return '';
  const nfkc = input.normalize('NFKC');
  return nfkc.trim().toLowerCase().replace(/[\s_\-\.．＿－]+/g, '');
}

/** alias_key 与 name_key 规则相同，单独导出便于读方语义。 */
export const normalizeAliasKey = normalizeName;

// ──────────────────────── 关系 pair_key（F2 §2.3） ────────────────────────

/**
 * 无向 / 有向统一：pair_key = sorted([a, b]).join('~')，字符序。
 * UNIQUE (work_id, pair_key, type_id) 同对角色同类型唯一。
 * a / b 必须不同（CK character_relations_not_self）。
 */
export function computePairKey(a: string, b: string): string {
  return a < b ? `${a}~${b}` : `${b}~${a}`;
}

// ──────────────────────── 年龄段映射 ────────────────────────

export function ageToBand(age: number | null | undefined): string | null {
  if (age === null || age === undefined) return null;
  if (age <= 2) return 'baby';
  if (age <= 12) return 'child';
  if (age <= 17) return 'teen';
  if (age <= 35) return 'young';
  if (age <= 55) return 'middle';
  if (age <= 75) return 'senior';
  return 'elder';
}

// ──────────────────────── Entity → Contract 映射 ────────────────────────

export function mapCharacter(
  entity: CharacterEntity,
  aliases: Pick<CharacterAliasEntity, 'alias'>[] = []
): Character {
  return {
    id: entity.id,
    work_id: entity.work_id,
    name: entity.name,
    aliases: aliases.map((a) => a.alias),
    identity: entity.identity,
    age: entity.age,
    gender: entity.gender,
    personality: entity.personality,
    experience: entity.experience,
    country_region: entity.country_region,
    faith: entity.faith,
    faction: entity.faction,
    race: entity.race,
    occupation: entity.occupation,
    age_band: entity.age_band,
    attributes: entity.attributes as CharacterAttribute[],
    avatar_asset_id: entity.avatar_asset_id,
    status: entity.status,
    merged_into_id: entity.merged_into_id,
    archived_at: entity.archived_at?.toISOString() ?? null,
    origin: entity.origin,
    version: entity.version,
    created_at: entity.created_at.toISOString(),
    updated_at: entity.updated_at.toISOString()
  };
}

export function mapDossier(entity: CharacterEntity): CharacterDossier {
  return {
    name: entity.name,
    identity: entity.identity,
    age: entity.age,
    gender: entity.gender,
    personality: entity.personality,
    experience: entity.experience,
    country_region: entity.country_region,
    faith: entity.faith,
    faction: entity.faction,
    race: entity.race,
    occupation: entity.occupation,
    age_band: entity.age_band,
    attributes: entity.attributes as CharacterAttribute[]
  };
}
