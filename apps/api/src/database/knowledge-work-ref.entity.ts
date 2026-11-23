import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from 'typeorm';

// M3c-3 知识库 · 作品引用表
// 引用只读：只存指针 + 有界快照；读取时 JOIN 全局条目取最新内容
// 结构来源：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §2.2.2
@Entity('knowledge_work_refs')
export class KnowledgeWorkRefEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  owner_id!: string;

  @Column({ type: 'uuid' })
  work_id!: string;

  // FK ON DELETE SET NULL：全局条目彻底删除时置 NULL，引用显示「来源已失效」
  @Column({ type: 'uuid', nullable: true })
  entry_id!: string | null;

  @Column({ type: 'varchar', length: 200 })
  snapshot_title!: string;

  @Column({ type: 'varchar', length: 16 })
  snapshot_type!: string;

  // 只存名称数组
  @Column({ type: 'jsonb', default: () => "'[]'" })
  snapshot_tags!: string[];

  @Column({ type: 'varchar', length: 2000, default: '' })
  snapshot_excerpt!: string;

  // 有界结构化摘要，≤16 KB
  @Column({ type: 'jsonb', nullable: true })
  snapshot_structured!: Record<string, unknown> | null;

  @Column({ type: 'boolean', default: false })
  favorite!: boolean;

  @Column({ type: 'boolean', default: false })
  pinned!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  pinned_at!: Date | null;

  @Column({ type: 'uuid' })
  added_by!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
