import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { ArchiveScanStatus } from './character-enums';

// M3c-2 归档扫描作业：服务内分批执行，不占 ai_tasks 队列
// 同角色同时只允许一次 pending/running（部分唯一索引，迁移中建立）
@Entity('character_archive_scans')
export class CharacterArchiveScanEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'uuid' }) character_id!: string;
  @Column({ type: 'uuid' }) requested_by!: string;
  @Column({ type: 'varchar', length: 16, default: 'pending' }) status!: ArchiveScanStatus;
  @Column({ type: 'integer', default: 0 }) total_chapters!: number;
  @Column({ type: 'integer', default: 0 }) scanned_chapters!: number;
  @Column({ type: 'integer', default: 0 }) matched_paragraphs!: number;
  @Column({ type: 'jsonb', nullable: true }) error!: Record<string, unknown> | null;
  @Column({ type: 'timestamptz', nullable: true }) started_at!: Date | null;
  @Column({ type: 'timestamptz', nullable: true }) finished_at!: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
}
