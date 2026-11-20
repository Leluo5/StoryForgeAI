import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { GrowthEventOrigin, GrowthEventStatus } from './character-enums';

// M3c-2 成长事件：plot_node_id 为弱引用（不建外键），节点标题快照保证删除后仍可解释
@Entity('character_growth_events')
export class CharacterGrowthEventEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'uuid' }) character_id!: string;
  @Column({ type: 'varchar', length: 120 }) title!: string;
  @Column({ type: 'text', default: '' }) content!: string;
  @Column({ type: 'varchar', length: 120, nullable: true }) event_time!: string | null;
  @Column({ type: 'uuid', nullable: true }) plot_node_id!: string | null;
  @Column({ type: 'varchar', length: 120, nullable: true }) plot_node_title!: string | null;
  @Column({ type: 'uuid', nullable: true }) chapter_id!: string | null;
  @Column({ type: 'varchar', length: 16, default: 'active' }) status!: GrowthEventStatus;
  @Column({ type: 'timestamptz', nullable: true }) archived_at!: Date | null;
  @Column({ type: 'varchar', length: 16, default: 'manual' }) origin!: GrowthEventOrigin;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
