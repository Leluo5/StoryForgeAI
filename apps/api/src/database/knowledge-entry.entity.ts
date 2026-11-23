import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from 'typeorm';

// M3c-3 知识库 · 素材条目表
// 双层库：library_scope = 'global'（作者级，work_id NULL）/ 'work'（作品级，work_id 非空）
// 结构来源：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §2.2.1
// 注意：CHECK 约束与部分唯一索引在迁移 DDL 中表达，实体只做列映射（synchronize: false）
@Entity('knowledge_entries')
export class KnowledgeEntryEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  owner_id!: string;

  // global / work
  @Column({ type: 'varchar', length: 8 })
  library_scope!: string;

  @Column({ type: 'uuid', nullable: true })
  work_id!: string | null;

  // article / paper / novel / inspiration / setting
  @Column({ type: 'varchar', length: 16 })
  entry_type!: string;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  // 归一化标题（导入判重与展示排序）
  @Column({ type: 'varchar', length: 200 })
  title_key!: string;

  // 原文（唯一事实来源）
  @Column({ type: 'text' })
  original_text!: string;

  // 归一化原文 SHA-256
  @Column({ type: 'char', length: 64 })
  content_hash!: string;

  // 标题 + 标签 + 结构化摘要 + 原文前 2000 字
  @Column({ type: 'text', default: '' })
  search_text!: string;

  // 按类型受控结构，见 §3.5
  @Column({ type: 'jsonb', nullable: true })
  structured!: Record<string, unknown> | null;

  // pending / structuring / ready / failed
  @Column({ type: 'varchar', length: 16, default: 'pending' })
  structure_status!: string;

  @Column({ type: 'jsonb', nullable: true })
  structure_error!: Record<string, unknown> | null;

  // pending / ready / failed（仅小说）
  @Column({ type: 'varchar', length: 16, nullable: true })
  outline_status!: string | null;

  // 四维大纲，见 §3.5
  @Column({ type: 'jsonb', nullable: true })
  outline!: Record<string, unknown> | null;

  @Column({ type: 'boolean', default: false })
  favorite!: boolean;

  @Column({ type: 'boolean', default: false })
  pinned!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  pinned_at!: Date | null;

  // manual / upload / markdown_import / backup / ref_copy
  @Column({ type: 'varchar', length: 16, default: 'manual' })
  origin!: string;

  // 副本来源（弱引用，不建 FK）
  @Column({ type: 'uuid', nullable: true })
  source_entry_id!: string | null;

  // 编辑乐观锁
  @Column({ type: 'integer', default: 1 })
  version!: number;

  // 软删除
  @Column({ type: 'timestamptz', nullable: true })
  deleted_at!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  deleted_by!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
