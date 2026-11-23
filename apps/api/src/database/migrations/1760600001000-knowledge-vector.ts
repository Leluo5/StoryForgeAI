import type { MigrationInterface, QueryRunner } from 'typeorm';

// M3c-3 知识库 · 向量迁移：CREATE EXTENSION vector + knowledge_entry_embeddings 表
// 设计见 docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §2.1、§2.2.6、§11.2
// 要点：
//   - 创建 vector 扩展（灵感相似度，pgvector 余弦距离）
//   - down 只删表，不删 vector 扩展（扩展可能被其他功能使用）
//   - dim=1024 CHECK；source_hash 唯一（条目一一对应）
//   - 2000 条规模顺序扫描即可满足 1 秒，不建 HNSW/IVFFlat 索引
export class KnowledgeVector1760600001000 implements MigrationInterface {
  name = 'KnowledgeVector1760600001000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS vector');

    await queryRunner.query(`
      CREATE TABLE knowledge_entry_embeddings (
        entry_id uuid PRIMARY KEY REFERENCES knowledge_entries(id) ON DELETE CASCADE,
        owner_id uuid NOT NULL,
        model varchar(60) NOT NULL,
        dim integer NOT NULL CHECK (dim = 1024),
        embedding vector(1024) NOT NULL,
        source_hash char(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // 条目一一对应：source_hash 唯一
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_knowledge_embedding_hash ON knowledge_entry_embeddings (source_hash)'
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // 只删表，不删 vector 扩展
    await queryRunner.query('DROP TABLE IF EXISTS knowledge_entry_embeddings');
  }
}
