import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

// M3c 剧情推衍会话：从某个剧情节点发起，逐步推衍
@Entity('derivation_sessions')
export class DerivationSessionEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'uuid' }) tree_id!: string;
  // 推衍起点节点（弱引用：节点删除后会话保留，确认回写时返回 409 让作者重选）
  @Column({ type: 'uuid' }) start_node_id!: string;
  @Column({ type: 'varchar', length: 120 }) place!: string;
  @Column({ type: 'text' }) background!: string;
  @Column({ type: 'varchar', length: 120, nullable: true }) time_node!: string | null;
  // 前置 / 关联剧情（树内节点多选）
  @Column({ type: 'uuid', array: true, default: () => "'{}'" }) premise_node_ids!: string[];
  @Column({ type: 'uuid', array: true, default: () => "'{}'" }) related_node_ids!: string[];
  // 参与角色文本列表：[{name, description}]（本期不接角色库）
  @Column({ type: 'jsonb', default: () => "'[]'" }) characters!: Array<{ name: string; description: string }>;
  @Column({ type: 'boolean', default: true }) random_enabled!: boolean;
  @Column({ type: 'boolean', default: true }) random_character_enabled!: boolean;
  // idle/running/paused/finished/failed
  @Column({ type: 'varchar', length: 16, default: 'idle' }) status!: string;
  @Column({ type: 'integer', default: 0 }) step_index!: number;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
