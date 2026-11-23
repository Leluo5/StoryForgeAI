import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from 'typeorm';

// M3c-3 知识库 · 标签表
// 标签按库隔离：全局库与各作品库可同名，互不影响；删除标签级联删除条目关联，不删除条目
// 结构来源：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §2.2.3
@Entity('knowledge_tags')
export class KnowledgeTagEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  owner_id!: string;

  // global / work
  @Column({ type: 'varchar', length: 8 })
  library_scope!: string;

  @Column({ type: 'uuid', nullable: true })
  work_id!: string | null;

  @Column({ type: 'varchar', length: 40 })
  name!: string;

  // NFKC → trim → 小写
  @Column({ type: 'varchar', length: 40 })
  name_key!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
