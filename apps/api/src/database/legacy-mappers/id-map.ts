import { createHash } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { LegacyIdMapEntity } from '../legacy-id-map.entity';

// M4-T11 旧数据 ID 映射：旧 JSON 实体 ID → 新 PG UUID。
// 决策 2 方案 A：旧 ID 若是合法 UUID 直接沿用，非 UUID 则确定性哈希生成稳定 UUID。
// legacy_id_map 表 (domain, legacy_id) 唯一，保证幂等与跨表关联（chapter→work 等）迁移后完整。

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

// 确定性 UUID v5 风格：SHA-256(domain:legacyId) 前 16 字节 → 置版本位 5、variant 位
export function uuidFromHash(key: string): string {
  const hash = createHash('sha256').update(key, 'utf8').digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10xx
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32)
  ].join('-');
}

/**
 * 解析旧实体 ID → 新 PG UUID，并落 legacy_id_map（已存在则复用，保证幂等）。
 * domain 为实体域（work/agent/character/plot_tree/workflow...），用于隔离同名旧 ID。
 * 调用方应在同一事务（tx）内，且父域先迁（关联完整性）。
 */
export async function resolveNewId(
  tx: EntityManager,
  domain: string,
  legacyId: string
): Promise<string> {
  const existing = await tx.findOne(LegacyIdMapEntity, {
    where: { domain, legacy_id: legacyId }
  });
  if (existing) return existing.new_id;

  const newId = isUuid(legacyId) ? legacyId : uuidFromHash(`${domain}:${legacyId}`);
  await tx.save(LegacyIdMapEntity, {
    domain,
    legacy_id: legacyId,
    new_id: newId
  });
  return newId;
}
