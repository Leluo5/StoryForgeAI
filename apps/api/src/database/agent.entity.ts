import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

// AI 创作 Agent：作者为每个创作工具配置的执行者（模型 + 参数）
// 配置变更即生效、可审计；同作者同刻仅一个默认 Agent（唯一部分索引兜底）
@Entity('ai_agents')
export class AgentEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  // 所属作者（作者级配置，非作品级）
  @Column({ type: 'uuid' }) author_id!: string;
  // Agent 名称（同作者内唯一，UNIQUE(author_id, name)）
  @Column({ type: 'varchar', length: 80 }) name!: string;
  // 模型平台（本期 mock；coze 留待后续段）
  @Column({ type: 'varchar', length: 24, default: 'mock' }) platform!: string;
  // 模型标识（如 mock-continue-v1）
  @Column({ type: 'varchar', length: 80 }) model_id!: string;
  // 模型参数（温度/最大 token 等受控字段，Zod 校验，防任意 JSON 注入）
  @Column({ type: 'jsonb', default: {} }) model_config!: Record<string, unknown>;
  // active/disabled
  @Column({ type: 'varchar', length: 16, default: 'active' }) status!: string;
  // 是否默认 Agent（同作者仅一个，唯一部分索引 WHERE is_default 兜底）
  @Column({ type: 'boolean', default: false }) is_default!: boolean;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
