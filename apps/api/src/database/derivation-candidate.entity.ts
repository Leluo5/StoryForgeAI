import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

// M3c 回写候选：推衍结果先成为候选，作者确认后才写入剧情树
@Entity('derivation_candidates')
export class DerivationCandidateEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) session_id!: string;
  // 起点节点不设外键：节点被删时保留候选，由服务层返回 409 让作者重选位置
  @Column({ type: 'uuid' }) start_node_id!: string;
  // child（作为起点子节点）/ sibling（作为起点兄弟节点）
  @Column({ type: 'varchar', length: 16 }) placement!: 'child' | 'sibling';
  // {nodes:[{title,summary,content,parent_index}]}
  @Column({ type: 'jsonb' }) payload!: Record<string, unknown>;
  // pending/confirmed/rejected
  @Column({ type: 'varchar', length: 16, default: 'pending' }) status!: string;
  @Column({ type: 'uuid', nullable: true }) confirmed_node_id!: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @Column({ type: 'timestamptz', nullable: true }) confirmed_at!: Date | null;
}
