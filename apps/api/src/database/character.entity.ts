import type { CharacterAttribute } from '@storyforge/contracts';
import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { CharacterOrigin, CharacterStatus } from './character-enums';

// M3c-2 角色：13 项资料单表存储，多视图共用同一份，视图不持有资料副本
// name_key 为服务端归一化名，仅用于疑似重复检索（不唯一）
// avatar_asset_id 与 character_avatar_assets.character_id 互为外键，迁移分步建立
@Entity('characters')
export class CharacterEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'varchar', length: 60 }) name!: string;
  @Column({ type: 'varchar', length: 60 }) name_key!: string;
  @Column({ type: 'varchar', length: 80, nullable: true }) identity!: string | null;
  @Column({ type: 'integer', nullable: true }) age!: number | null;
  @Column({ type: 'varchar', length: 16, nullable: true }) gender!: string | null;
  @Column({ type: 'varchar', length: 2000, default: '' }) personality!: string;
  @Column({ type: 'text', default: '' }) experience!: string;
  @Column({ type: 'varchar', length: 80, nullable: true }) country_region!: string | null;
  @Column({ type: 'varchar', length: 80, nullable: true }) faith!: string | null;
  @Column({ type: 'varchar', length: 80, nullable: true }) faction!: string | null;
  @Column({ type: 'varchar', length: 80, nullable: true }) race!: string | null;
  @Column({ type: 'varchar', length: 80, nullable: true }) occupation!: string | null;
  @Column({ type: 'varchar', length: 40, nullable: true }) age_band!: string | null;
  // 受控键值数组 [{key,value}]，上限 20 项由契约与服务层限制
  @Column({ type: 'jsonb', default: () => "'[]'" }) attributes!: CharacterAttribute[];
  @Column({ type: 'uuid', nullable: true }) avatar_asset_id!: string | null;
  @Column({ type: 'varchar', length: 16, default: 'active' }) status!: CharacterStatus;
  @Column({ type: 'uuid', nullable: true }) merged_into_id!: string | null;
  @Column({ type: 'timestamptz', nullable: true }) archived_at!: Date | null;
  @Column({ type: 'uuid', nullable: true }) archived_by!: string | null;
  @Column({ type: 'varchar', length: 16, default: 'manual' }) origin!: CharacterOrigin;
  // 资料乐观锁：写操作比对 expected_version
  @Column({ type: 'integer', default: 1 }) version!: number;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
