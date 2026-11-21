import type { MigrationInterface, QueryRunner } from 'typeorm';
import { KNOWLEDGE_SOURCES, KNOWLEDGE_TYPES, sqlStringList } from '../knowledge-enums';

// F5 知识库管理（重构版）：知识条目表（全局库，作者级隔离）
// 设计见 docs/04-功能交付档案/F5-知识库管理/02-技术方案-重构版.md §2.1
export class KnowledgeBase1760600000000 implements MigrationInterface {
  name = 'KnowledgeBase1760600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE knowledge_entries (
        id uuid PRIMARY KEY,
        author_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        type varchar(20) NOT NULL CHECK (type IN (${sqlStringList(KNOWLEDGE_TYPES)})),
        title varchar(200) NOT NULL,
        source varchar(20) NOT NULL CHECK (source IN (${sqlStringList(KNOWLEDGE_SOURCES)})),
        raw_content text NOT NULL,
        structured jsonb NOT NULL DEFAULT '{}',
        tags jsonb NOT NULL DEFAULT '[]',
        links jsonb NOT NULL DEFAULT '[]',
        content_hash varchar(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_knowledge_entries_author ON knowledge_entries(author_id)'
    );
    await queryRunner.query(
      'CREATE INDEX idx_knowledge_entries_author_type ON knowledge_entries(author_id, type)'
    );
    await queryRunner.query(
      'CREATE INDEX idx_knowledge_entries_author_created ON knowledge_entries(author_id, created_at DESC)'
    );
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_knowledge_entries_author_hash ON knowledge_entries(author_id, content_hash)'
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS knowledge_entries');
  }
}
