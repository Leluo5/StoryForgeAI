import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

// M3c 推衍步骤：每步一个 AI 任务结果，UNIQUE(session_id, step_no)
@Entity('derivation_steps')
export class DerivationStepEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) session_id!: string;
  @Column({ type: 'integer' }) step_no!: number;
  @Column({ type: 'text', default: '' }) content!: string;
  // 随机意外事件（可空）：{title, description}
  @Column({ type: 'jsonb', nullable: true }) event!: Record<string, unknown> | null;
  @Column({ type: 'jsonb', default: () => "'[]'" }) new_characters!: unknown[];
  // 分支选项：[{id, label, description}]
  @Column({ type: 'jsonb', default: () => "'[]'" }) branches!: unknown[];
  @Column({ type: 'varchar', length: 40, nullable: true }) chosen_branch_id!: string | null;
  // 生成该步骤的 AI 任务（便于订阅进度与重试）
  @Column({ type: 'uuid', nullable: true }) task_id!: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
