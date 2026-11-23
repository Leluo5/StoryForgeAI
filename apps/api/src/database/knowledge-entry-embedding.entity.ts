import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn
} from 'typeorm';

// M3c-3 知识库 · 条目向量表
// TypeORM 不原生支持 vector 类型：实体列按 type:'text' 映射，以迁移 DDL 为唯一结构来源
// 写入与检索使用原生 SQL 并显式转换 $1::vector，读取结果由 pg 驱动返回字符串
// 结构来源：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §2.2.6
@Entity('knowledge_entry_embeddings')
export class KnowledgeEntryEmbeddingEntity {
  // PK，FK knowledge_entries(id) ON DELETE CASCADE
  @Column({ type: 'uuid', primary: true })
  entry_id!: string;

  @Column({ type: 'uuid' })
  owner_id!: string;

  // 如 mock-bge-m3-1024
  @Column({ type: 'varchar', length: 60 })
  model!: string;

  // CHECK dim = 1024
  @Column({ type: 'integer' })
  dim!: number;

  // vector(1024)：实体映射为 text，DDL 唯一来源在迁移
  @Column({ type: 'text' })
  embedding!: string;

  // 参与嵌入的文本哈希，用于判断是否需要重算
  @Column({ type: 'char', length: 64 })
  source_hash!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updated_at!: Date;
}
