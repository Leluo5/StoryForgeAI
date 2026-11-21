import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// F11 归档发件箱：写回结果与引用资料投递 n8n 的记录（幂等 + 重试）
// task_id UNIQUE：一任务只允许一条归档记录（迁移建立）
// 归档失败只重试归档，不回滚写回；payload 保留原始载荷供修复后重投
@Entity('agent_archive_outbox')
@Index('idx_agent_archive_outbox_status', ['status', 'updated_at'])
export class AgentArchiveOutboxEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  // 对应写回任务（FK ai_tasks(id) ON DELETE CASCADE）
  @Column({ type: 'uuid', unique: true }) task_id!: string;
  // 投递载荷（结果 + 引用快照），不含凭据/作者邮箱/其他角色/正文
  @Column({ type: 'jsonb' }) payload!: Record<string, unknown>;
  // pending / delivered / failed（CHECK 约束在迁移建立）
  @Column({ type: 'varchar', length: 16 }) status!: string;
  // 已尝试次数
  @Column({ type: 'integer', default: 0 }) attempts!: number;
  // 最近一次失败原因（脱敏）
  @Column({ type: 'varchar', length: 500, nullable: true }) last_error!: string | null;
  // 上游返回的外部归档标识（幂等依据）
  @Column({ type: 'varchar', length: 128, nullable: true }) external_id!: string | null;
  @Column({ type: 'timestamptz', nullable: true }) delivered_at!: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @Column({ type: 'timestamptz', nullable: true }) updated_at!: Date | null;
}
