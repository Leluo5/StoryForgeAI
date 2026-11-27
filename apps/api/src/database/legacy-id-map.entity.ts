import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// M4-T11 旧数据 ID 映射表：旧 JSON 的实体 ID → 新 PG UUID。
// 旧 ID 若是合法 UUID 直接沿用，非 UUID 则确定性哈希生成稳定 UUID（uuidFromHash）。
// (domain, legacy_id) 唯一：同一旧实体重复迁移只落一行，保证幂等与跨表关联完整。
// 迁移后保留用于审计与追溯（不随迁移清理）。
@Entity('legacy_id_map')
@Index('uq_legacy_id_map_domain_legacy', ['domain', 'legacy_id'], { unique: true })
export class LegacyIdMapEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  // 实体域：work / volume / chapter / agent / agent_version / character / character_relation / plot_tree / plot_node / workflow / author
  @Column({ type: 'varchar', length: 32 }) domain!: string;

  // 旧 JSON 中的原始 ID（可能是 UUID 或任意字符串）
  @Column({ type: 'varchar', length: 255 }) legacy_id!: string;

  // 迁移后新表主键 UUID
  @Column({ type: 'uuid' }) new_id!: string;

  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
}
