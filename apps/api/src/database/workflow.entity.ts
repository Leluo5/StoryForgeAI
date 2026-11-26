import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from 'typeorm';

/**
 * 工作流实体。
 * 作者隔离：替代旧版 modules/agent_management 中固定 work_id='_global' 的写法。
 */
@Entity('ai_workflows')
export class WorkflowEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;

  // 所属作者（作者隔离，替代旧版固定 _global）
  @Column({ type: 'uuid' }) author_id!: string;

  // 作品级归属（M4-T7：作品绑定的工作流；作者级手动创建的可为空）
  @Column({ type: 'uuid', nullable: true }) work_id!: string | null;

  // 工作流名称（用户可见）
  @Column({ type: 'varchar', length: 200 }) name!: string;

  // 描述（用户可见）
  @Column({ type: 'text', nullable: true }) description!: string | null;

  // 状态：active / archived
  @Column({ type: 'varchar', length: 16, default: 'active' }) status!: string;

  // 平台标识：coze / flowise 等
  @Column({ type: 'varchar', length: 32 }) platform!: string;

  // 平台专属配置（如 bot_id、dataset_id 等）
  @Column({ type: 'jsonb', default: () => "'{}'" }) platform_config!: Record<string, unknown>;

  // LLM 配置
  @Column({ type: 'jsonb', nullable: true }) llm_config!: Record<string, unknown> | null;

  // 来源：manual / coze_import
  @Column({ type: 'varchar', length: 16, default: 'manual' }) source!: string;

  // 当前版本号（从 1 开始）
  @Column({ type: 'int', default: 1 }) version_no!: number;

  // 历史版本快照数组（最近 50 条，超限自动淘汰）
  @Column({ type: 'jsonb', default: () => "'[]'" }) versions!: unknown[];

  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
  @Column({ type: 'timestamptz', nullable: true }) archived_at!: Date | null;
}