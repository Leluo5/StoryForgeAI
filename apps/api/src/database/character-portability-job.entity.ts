import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { PortabilityJobKind, PortabilityJobStatus, PortabilityMode } from './character-enums';

// M3c-2 导入导出作业：同步事务执行，作业行用于审计、幂等重放与结果摘要
@Entity('character_portability_jobs')
export class CharacterPortabilityJobEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'varchar', length: 16 }) kind!: PortabilityJobKind;
  @Column({ type: 'varchar', length: 16 }) status!: PortabilityJobStatus;
  @Column({ type: 'integer' }) schema_version!: number;
  @Column({ type: 'varchar', length: 16, nullable: true }) mode!: PortabilityMode | null;
  @Column({ type: 'varchar', length: 128, nullable: true }) idempotency_key!: string | null;
  // 角色/关系/成长事件/视图/锚点数量与冲突数
  @Column({ type: 'jsonb', default: () => "'{}'" }) summary!: Record<string, unknown>;
  @Column({ type: 'jsonb', default: () => "'[]'" }) conflicts!: Array<Record<string, unknown>>;
  @Column({ type: 'jsonb', nullable: true }) error!: Record<string, unknown> | null;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @Column({ type: 'timestamptz', nullable: true }) finished_at!: Date | null;
}
