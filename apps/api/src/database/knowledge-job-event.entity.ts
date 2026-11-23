import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

// M3c-3 知识库 · 作业事件表
// SSE 断线重连按 Last-Event-ID 或 ?after_seq= 重放；事件序号单调递增且 (job_id, event_seq) 唯一
// 结构来源：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §2.2.8
@Entity('knowledge_job_events')
export class KnowledgeJobEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  job_id!: string;

  @Column({ type: 'integer' })
  event_seq!: number;

  // queued / running / progress / succeeded / failed / cancelled
  @Column({ type: 'varchar', length: 16 })
  type!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
