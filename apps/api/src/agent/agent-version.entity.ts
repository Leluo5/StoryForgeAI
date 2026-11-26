import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// M4-T5：Agent 版本历史独立表（替代 ai_agents.versions jsonb 数组）。
// 每版本一行，snapshot 不可变（写入后只读），agent.current(version_no) 指向最新。
// 版本上限：agent 内保留最近 50 行（appendVersion 后清理），见 AgentVersionService。
@Entity('agent_version')
@Index('uq_agent_version_agent_no', ['agent_id', 'version_no'], { unique: true })
@Index('idx_agent_version_agent_created', ['agent_id', 'created_at'])
export class AgentVersionEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  // 所属 Agent（ai_agents.id）
  @Column({ type: 'uuid' }) agent_id!: string;

  // 版本号（agent 内递增，从 1 开始）
  @Column({ type: 'int' }) version_no!: number;

  // 变更类型：create / update / archive / restore / rollback
  @Column({ type: 'varchar', length: 16 }) action!: string;

  // 备注（回滚目标等）
  @Column({ type: 'varchar', length: 500, default: '' }) note!: string;

  // 不可变快照（该版本完整配置，写入后只读）
  @Column({ type: 'jsonb' }) snapshot!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
}
