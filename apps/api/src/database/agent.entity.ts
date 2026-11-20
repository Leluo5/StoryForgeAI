import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/** 版本快照：Agent 每次变更的完整字段快照（不含 versions 数组本身） */
export interface AgentVersionSnapshot {
  version_no: number;
  change_type: 'create' | 'update' | 'archive' | 'restore' | 'rollback';
  note: string;
  created_at: string;
  snapshot: Record<string, unknown>;
}

// AI 创作 Agent：作者为每个创作工具配置的执行者（模型 + 参数）
// V2 升级：支持作品级三类 Agent（role_agent/tool_agent/flow_step_agent）+ 版本快照 + 分组 + 归档状态
// 存量 Agent 自动标记 kind=legacy，status 保持 active/disabled（旧 CHECK 已升级为三值）
@Entity('ai_agents')
export class AgentEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  // 所属作者
  @Column({ type: 'uuid' }) author_id!: string;
  // Agent 名称
  @Column({ type: 'varchar', length: 80 }) name!: string;
  // 模型平台
  @Column({ type: 'varchar', length: 24, default: 'mock' }) platform!: string;
  // 模型标识
  @Column({ type: 'varchar', length: 80 }) model_id!: string;
  // 模型参数（V2 可扩展为 10 项，旧 2 项仍兼容）
  @Column({ type: 'jsonb', default: {} }) model_config!: Record<string, unknown>;
  // active / disabled / archived（V2 新增 archived）
  @Column({ type: 'varchar', length: 16, default: 'active' }) status!: string;
  // 是否默认 Agent（按 kind 维度的互斥索引兜底）
  @Column({ type: 'boolean', default: false }) is_default!: boolean;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;

  // ─── V2 新增列（全部 nullable 或有 default，向后兼容存量数据）───
  // 所属作品（作品级 Agent 必填；legacy 作者级为 null）
  @Column({ type: 'uuid', nullable: true }) project_id?: string | null;
  // Agent 类型：legacy（存量）/ role_agent / tool_agent / flow_step_agent
  @Column({ type: 'varchar', length: 24, default: 'legacy' }) kind!: string;
  // Agent 描述
  @Column({ type: 'text', default: '' }) description!: string;
  // role_agent 专属：关联角色 ID
  @Column({ type: 'uuid', nullable: true }) role_id?: string | null;
  // tool_agent 专属：关联工具名称
  @Column({ type: 'varchar', length: 40, nullable: true }) tool_name?: string | null;
  // flow_step_agent 专属：流程步骤 1-11
  @Column({ type: 'int', nullable: true }) step_order?: number | null;
  // 归属范围：project（作品级）/ role（角色级）
  @Column({ type: 'varchar', length: 16, default: 'project' }) scope!: string;
  // 平台配置（非敏感字段，如 bot_id / agent_id）
  @Column({ type: 'jsonb', default: {} }) platform_config!: Record<string, unknown>;
  // 创建来源：manual / template / migration / auto
  @Column({ type: 'varchar', length: 16, default: 'manual' }) source!: string;
  // 标签
  @Column({ type: 'text', array: true, default: '{}' }) tags!: string[];
  // 手工分组外键（null 表示走自动分组）
  @Column({ type: 'uuid', nullable: true }) manual_group_key?: string | null;
  // 凭据来源：global（作者全局）/ own（作品专用）
  @Column({ type: 'varchar', length: 16, default: 'global' }) credential_source!: string;
  // 当前版本号（每次变更自增）
  @Column({ type: 'int', default: 1 }) version_no!: number;
  // 版本快照数组（MAX=50 硬截断，JSONB 存储）
  @Column({ type: 'jsonb', default: [] }) versions!: AgentVersionSnapshot[];
  // 归档时间（status=archived 时写入，恢复时置 null）
  @Column({ type: 'timestamptz', nullable: true }) archived_at?: Date | null;
}
