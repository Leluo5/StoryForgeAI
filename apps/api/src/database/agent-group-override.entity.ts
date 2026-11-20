import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** 分组覆盖项：覆盖自动分组的 name/sort_order/hidden */
export interface GroupOverride {
  key: string;       // 自动分组 key，如 "flow:3" 或 "tool:rewrite" 或 "role:<roleId>"
  name?: string;
  sort_order?: number;
  hidden?: boolean;
}

/** 手工分组节点 */
export interface ManualGroup {
  id: string;         // 格式 "manual:<uuid>"
  parent_key: string; // 父分组 key，默认 "project:"
  name: string;
  sort_order?: number;
}

/**
 * Agent 分组覆盖层：每个作品一条记录，存储分组覆盖项 + 手工分组
 * 构建分组树时与自动分组合并应用
 */
@Entity('agent_group_overrides')
export class AgentGroupOverrideEntity {
  @PrimaryColumn({ type: 'uuid' }) project_id!: string;
  @Column({ type: 'jsonb', default: '[]' }) overrides!: GroupOverride[];
  @Column({ type: 'jsonb', default: '[]' }) manual_groups!: ManualGroup[];
  @Column({ type: 'timestamptz', default: () => 'now()' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
