import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/** 单步骤进度快照 */
export interface FlowStepRecord {
  step_order: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  output?: Record<string, unknown>;
  error?: string;
  started_at?: string | null;
  finished_at?: string | null;
}

/**
 * 流程进度：每作品下每角色一个进度记录（11 步流程的实时状态）
 * 联合主键 (project_id, role_id) 保证唯一性
 */
@Entity('flow_progress')
@Index('idx_flow_progress_status', ['status'])
export class FlowProgressEntity {
  @PrimaryColumn({ type: 'uuid' }) project_id!: string;
  @PrimaryColumn({ type: 'uuid' }) role_id!: string;
  @Column({ type: 'uuid', nullable: true }) run_id?: string | null;
  @Column({ type: 'varchar', length: 16, default: 'idle' }) status!: string;
  @Column({ type: 'int', default: 0 }) current_step!: number;
  @Column({ type: 'int', array: true, default: '{}' }) completed_steps!: number[];
  @Column({ type: 'jsonb', default: '[]' }) steps!: FlowStepRecord[];
  @Column({ type: 'jsonb', default: '{}' }) context!: Record<string, unknown>;
  @Column({ type: 'text', default: '' }) last_error!: string;
  @Column({ type: 'timestamptz', nullable: true }) started_at?: Date | null;
  @Column({ type: 'timestamptz', default: () => 'now()' }) updated_at!: Date;
}
