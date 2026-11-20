import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * 角色-Agent 绑定：作品下每角色可绑定多个 Agent（按 step_order 区分）
 * 每角色每 step_order 仅一条绑定（uq_role_agent_binding_role_step）
 */
@Entity('role_agent_bindings')
@Index('idx_role_agent_bindings_role', ['role_id', 'enabled'])
@Index('idx_role_agent_bindings_project', ['project_id'])
export class RoleAgentBindingEntity {
  @PrimaryColumn({ type: 'uuid' }) id!: string;
  @Column({ type: 'uuid' }) project_id!: string;
  @Column({ type: 'uuid' }) role_id!: string;
  @Column({ type: 'uuid' }) agent_id!: string;
  @Column({ type: 'int', nullable: true }) step_order?: number | null;
  @Column({ type: 'boolean', default: true }) enabled!: boolean;
  @Column({ type: 'varchar', length: 80, nullable: true }) model?: string | null;
  @Column({ type: 'varchar', length: 16, default: 'coze' }) agent_env!: string;
  @Column({ type: 'timestamptz', default: () => 'now()' }) created_at!: Date;
  @Column({ type: 'timestamptz', default: () => 'now()' }) updated_at!: Date;
}
