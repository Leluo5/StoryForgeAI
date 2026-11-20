import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { AvatarAssetStatus, AvatarMime, AvatarStorageKind } from './character-enums';

// M3c-2 头像资产：文件存储 + 内容哈希命名，单角色至多一张 active（部分唯一索引）
// 状态机 pending → active → superseded / pending → failed，失败不清除旧 active
@Entity('character_avatar_assets')
export class CharacterAvatarAssetEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'uuid' }) character_id!: string;
  @Column({ type: 'varchar', length: 16 }) status!: AvatarAssetStatus;
  @Column({ type: 'varchar', length: 16, default: 'file' }) storage_kind!: AvatarStorageKind;
  @Column({ type: 'varchar', length: 255, nullable: true }) storage_path!: string | null;
  @Column({ type: 'varchar', length: 40 }) mime!: AvatarMime;
  @Column({ type: 'integer' }) byte_size!: number;
  @Column({ type: 'integer', nullable: true }) width!: number | null;
  @Column({ type: 'integer', nullable: true }) height!: number | null;
  // SHA-256：ETag 与去重命名依据
  @Column({ type: 'char', length: 64 }) content_hash!: string;
  @Column({ type: 'uuid', nullable: true }) task_id!: string | null;
  @Column({ type: 'jsonb', nullable: true }) error!: Record<string, unknown> | null;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
