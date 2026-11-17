import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

// AI 任务进度事件：SSE 补取依据，事件序号单调递增且唯一
@Entity('ai_task_events')
export class AiTaskEventEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) task_id!: string;
  // 事件序号（单调递增，UNIQUE(task_id, event_seq)，补取不重复）
  @Column({ type: 'integer' }) event_seq!: number;
  // queued/running/progress/succeeded/failed/cancelled
  @Column({ type: 'varchar', length: 24 }) type!: string;
  // 阶段描述/进度百分比/结果摘要/错误原因
  @Column({ type: 'jsonb' }) payload!: Record<string, unknown>;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
}
