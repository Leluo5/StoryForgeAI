import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// F11 引用快照：生成任务使用的知识库引用（FastGPT 检索结果），防上游删除后无法追溯
// 一任务多条引用；task_id FK ai_tasks(id) ON DELETE CASCADE（迁移建立）
@Entity('agent_task_citations')
@Index('idx_agent_task_citations_task', ['task_id', 'id'])
export class AgentTaskCitationEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  // 所属生成任务（FK ai_tasks(id) ON DELETE CASCADE）
  @Column({ type: 'uuid' }) task_id!: string;
  // 知识库数据集标识（如 fastgpt dataset id），非敏感
  @Column({ type: 'varchar', length: 64 }) dataset_id!: string;
  // 上游来源 ID（非敏感）
  @Column({ type: 'varchar', length: 128 }) source_id!: string;
  // 引用标题
  @Column({ type: 'varchar', length: 200 }) title!: string;
  // 引用摘录（服务端截断 500 字，见 T11）
  @Column({ type: 'text' }) snippet!: string;
  // 相似度，缺失记 NULL
  @Column({ type: 'numeric', precision: 5, scale: 4, nullable: true }) score!: string | null;
}
