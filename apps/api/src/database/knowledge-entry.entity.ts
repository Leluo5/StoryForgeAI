import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

// 知识条目（对齐旧 F5 §2.1，映射到 TypeORM/PostgreSQL）
// 全局知识库：author_id 归属（作者级隔离，不按作品）
@Entity('knowledge_entries')
@Index('idx_knowledge_entries_author', ['author_id'])
@Index('idx_knowledge_entries_author_type', ['author_id', 'type'])
@Index('idx_knowledge_entries_author_created', ['author_id', 'created_at'])
@Index('uq_knowledge_entries_author_hash', ['author_id', 'content_hash'], { unique: true })
export class KnowledgeEntryEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  author_id!: string;

  @Column({ type: 'varchar', length: 20 })
  type!: 'article' | 'paper' | 'novel' | 'inspiration';

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'varchar', length: 20 })
  source!: 'paste' | 'manual' | 'upload' | 'ocr' | 'import';

  @Column({ type: 'text' })
  raw_content!: string;

  @Column({ type: 'jsonb' })
  structured!: Record<string, unknown>;

  @Column({ type: 'jsonb' })
  tags!: string[];

  @Column({ type: 'jsonb' })
  links!: string[];

  @Column({ type: 'varchar', length: 64 })
  content_hash!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
