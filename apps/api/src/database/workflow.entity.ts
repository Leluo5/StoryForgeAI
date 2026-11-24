import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { WorkflowVersionSnapshot } from '@storyforge/contracts';

// 创作工作流（Workflow）：作者为编排创作流程配置的自动化流程
// 对齐 F12 概念但精简 + 去敏感：
//  - platform_config 只存非敏感标识（workflow_id/workspace_id）
//  - llm_config 只存 model（base_url/api_key 由服务端 env 注入，禁止入库）
//  - status 三态：active / disabled / archived
//  - versions 为版本快照数组（保留最近 MAX_WORKFLOW_VERSIONS 条）
@Entity('ai_workflows')
export class WorkflowEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  // 所属作者（作者隔离，替代旧版固定 _global）
  @Column({ type: 'uuid' }) author_id!: string;
  // 工作流名称
  @Column({ type: 'varchar', length: 80 }) name!: string;
  // 描述
  @Column({ type: 'text', default: '' }) description!: string;
  // active / disabled / archived
  @Column({ type: 'varchar', length: 16, default: 'active' }) status!: string;
  // 平台（固定 coze）
  @Column({ type: 'varchar', length: 16, default: 'coze' }) platform!: string;
  // 平台配置（仅非敏感标识：workflow_id/workspace_id）
  @Column({ type: 'jsonb', default: {} }) platform_config!: Record<string, unknown>;
  // LLM 配置（仅 model，密钥由服务端 env 注入）
  @Column({ type: 'jsonb', default: {} }) llm_config!: Record<string, unknown>;
  // 创建来源：manual / coze_import
  @Column({ type: 'varchar', length: 16, default: 'manual' }) source!: string;
  // 当前版本号（每次变更自增）
  @Column({ type: 'int', default: 1 }) version_no!: number;
  // 版本快照数组（MAX=50 硬截断，JSONB 存储）
  @Column({ type: 'jsonb', default: [] }) versions!: WorkflowVersionSnapshot[];
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
  // 归档时间（status=archived 时写入，恢复时置 null）
  @Column({ type: 'timestamptz', nullable: true }) archived_at?: Date | null;
}
