import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

// M3c-3 知识库 · 跨条目关联表
// 双向可见通过 source/target 查询实现，不建双向冗余行；灵感自动关联固定灵感为 source_entry_id
// 结构来源：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §2.2.5
@Entity('knowledge_entry_links')
export class KnowledgeEntryLinkEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  owner_id!: string;

  // global / work
  @Column({ type: 'varchar', length: 8 })
  library_scope!: string;

  @Column({ type: 'uuid', nullable: true })
  work_id!: string | null;

  @Column({ type: 'uuid' })
  source_entry_id!: string;

  @Column({ type: 'uuid' })
  target_entry_id!: string;

  // manual / inspiration_auto
  @Column({ type: 'varchar', length: 24 })
  kind!: string;

  // 自动关联的余弦相似度，手动关联为 NULL
  @Column({ type: 'numeric', precision: 5, scale: 4, nullable: true })
  score!: string | null;

  // 系统自动关联写 system 对应的作者 id
  @Column({ type: 'uuid' })
  created_by!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
