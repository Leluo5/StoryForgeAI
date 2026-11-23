import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
  KNOWLEDGE_ENTRY_TYPES,
  KNOWLEDGE_JOB_EVENT_TYPES,
  KNOWLEDGE_JOB_KINDS,
  KNOWLEDGE_JOB_STATUSES,
  KNOWLEDGE_LIBRARY_SCOPES,
  KNOWLEDGE_LINK_KINDS,
  KNOWLEDGE_ORIGINS,
  KNOWLEDGE_OUTLINE_STATUSES,
  KNOWLEDGE_STRUCTURE_STATUSES,
  sqlStringList
} from '../knowledge-enums';

// M3c-3 知识库 · 基础迁移：7 张表 + pg_trgm 扩展 + CHECK + 索引
// 设计见 docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §2.1、§2.2
// 要点：
//   - 创建 pg_trgm 扩展（关键词检索）
//   - down 按依赖逆序删表，不删除 pg_trgm 扩展（避免影响其他对象）
//   - CHECK / 部分唯一索引 / 检索索引全部在此表达；实体只做列映射，禁止 synchronize
export class KnowledgeBase1760600000000 implements MigrationInterface {
  name = 'KnowledgeBase1760600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 关键词检索扩展（ILIIKE 走 trigram GIN 索引）
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');

    // ---- knowledge_entries（素材条目）----
    await queryRunner.query(`
      CREATE TABLE knowledge_entries (
        id uuid PRIMARY KEY,
        owner_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        library_scope varchar(8) NOT NULL CHECK (library_scope IN (${sqlStringList(KNOWLEDGE_LIBRARY_SCOPES)})),
        work_id uuid REFERENCES works(id) ON DELETE CASCADE,
        entry_type varchar(16) NOT NULL CHECK (entry_type IN (${sqlStringList(KNOWLEDGE_ENTRY_TYPES)})),
        title varchar(200) NOT NULL,
        title_key varchar(200) NOT NULL,
        original_text text NOT NULL,
        content_hash char(64) NOT NULL,
        search_text text NOT NULL DEFAULT '',
        structured jsonb,
        structure_status varchar(16) NOT NULL DEFAULT 'pending' CHECK (structure_status IN (${sqlStringList(KNOWLEDGE_STRUCTURE_STATUSES)})),
        structure_error jsonb,
        outline_status varchar(16) CHECK (outline_status IN (${sqlStringList(KNOWLEDGE_OUTLINE_STATUSES)})),
        outline jsonb,
        favorite boolean NOT NULL DEFAULT false,
        pinned boolean NOT NULL DEFAULT false,
        pinned_at timestamptz,
        origin varchar(16) NOT NULL DEFAULT 'manual' CHECK (origin IN (${sqlStringList(KNOWLEDGE_ORIGINS)})),
        source_entry_id uuid,
        version integer NOT NULL DEFAULT 1,
        deleted_at timestamptz,
        deleted_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((library_scope = 'global' AND work_id IS NULL) OR (library_scope = 'work' AND work_id IS NOT NULL))
      )
    `);

    // 全局库按作者唯一内容（软删除不占位）
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_knowledge_global_hash ON knowledge_entries (owner_id, content_hash) WHERE library_scope = 'global' AND deleted_at IS NULL`
    );
    // 作品库按作品唯一内容
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_knowledge_work_hash ON knowledge_entries (work_id, content_hash) WHERE library_scope = 'work' AND deleted_at IS NULL`
    );
    // 全局库列表
    await queryRunner.query(
      `CREATE INDEX idx_knowledge_global_list ON knowledge_entries (owner_id, updated_at DESC) WHERE library_scope='global' AND deleted_at IS NULL`
    );
    // 作品库列表
    await queryRunner.query(
      `CREATE INDEX idx_knowledge_work_list ON knowledge_entries (work_id, updated_at DESC) WHERE library_scope='work' AND deleted_at IS NULL`
    );
    // 全局库按类型
    await queryRunner.query(
      `CREATE INDEX idx_knowledge_global_type ON knowledge_entries (owner_id, entry_type, updated_at DESC) WHERE library_scope='global' AND deleted_at IS NULL`
    );
    // 作品库按类型
    await queryRunner.query(
      `CREATE INDEX idx_knowledge_work_type ON knowledge_entries (work_id, entry_type, updated_at DESC) WHERE library_scope='work' AND deleted_at IS NULL`
    );
    // 全局库按创建时间
    await queryRunner.query(
      `CREATE INDEX idx_knowledge_global_created ON knowledge_entries (owner_id, created_at DESC) WHERE library_scope='global' AND deleted_at IS NULL`
    );
    // 作品库按创建时间
    await queryRunner.query(
      `CREATE INDEX idx_knowledge_work_created ON knowledge_entries (work_id, created_at DESC) WHERE library_scope='work' AND deleted_at IS NULL`
    );
    // 回收站
    await queryRunner.query(
      `CREATE INDEX idx_knowledge_trash ON knowledge_entries (owner_id, deleted_at DESC) WHERE deleted_at IS NOT NULL`
    );
    // 关键词检索（trigram）
    await queryRunner.query(
      `CREATE INDEX idx_knowledge_search_trgm ON knowledge_entries USING gin (search_text gin_trgm_ops)`
    );

    // ---- knowledge_work_refs（作品引用）----
    await queryRunner.query(`
      CREATE TABLE knowledge_work_refs (
        id uuid PRIMARY KEY,
        owner_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        entry_id uuid REFERENCES knowledge_entries(id) ON DELETE SET NULL,
        snapshot_title varchar(200) NOT NULL,
        snapshot_type varchar(16) NOT NULL,
        snapshot_tags jsonb NOT NULL DEFAULT '[]',
        snapshot_excerpt varchar(2000) NOT NULL DEFAULT '',
        snapshot_structured jsonb,
        favorite boolean NOT NULL DEFAULT false,
        pinned boolean NOT NULL DEFAULT false,
        pinned_at timestamptz,
        added_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    // 同一作品同一全局条目仅一条引用
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_knowledge_ref ON knowledge_work_refs (work_id, entry_id) WHERE entry_id IS NOT NULL`
    );
    await queryRunner.query(
      `CREATE INDEX idx_knowledge_refs_work ON knowledge_work_refs (work_id, updated_at DESC)`
    );
    // 全局条目删除前统计引用作品
    await queryRunner.query(
      `CREATE INDEX idx_knowledge_refs_entry ON knowledge_work_refs (entry_id)`
    );

    // ---- knowledge_tags（标签）----
    await queryRunner.query(`
      CREATE TABLE knowledge_tags (
        id uuid PRIMARY KEY,
        owner_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        library_scope varchar(8) NOT NULL CHECK (library_scope IN (${sqlStringList(KNOWLEDGE_LIBRARY_SCOPES)})),
        work_id uuid REFERENCES works(id) ON DELETE CASCADE,
        name varchar(40) NOT NULL,
        name_key varchar(40) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK ((library_scope = 'global' AND work_id IS NULL) OR (library_scope = 'work' AND work_id IS NOT NULL))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_knowledge_tag_global ON knowledge_tags (owner_id, name_key) WHERE library_scope='global'`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_knowledge_tag_work ON knowledge_tags (work_id, name_key) WHERE library_scope='work'`
    );
    await queryRunner.query(
      `CREATE INDEX idx_knowledge_tags_list ON knowledge_tags (owner_id, library_scope, work_id, name)`
    );

    // ---- knowledge_entry_tags（条目-标签）----
    await queryRunner.query(`
      CREATE TABLE knowledge_entry_tags (
        entry_id uuid NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
        tag_id uuid NOT NULL REFERENCES knowledge_tags(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (entry_id, tag_id)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_knowledge_entry_tags_tag ON knowledge_entry_tags (tag_id)`
    );

    // ---- knowledge_entry_links（跨条目关联）----
    await queryRunner.query(`
      CREATE TABLE knowledge_entry_links (
        id uuid PRIMARY KEY,
        owner_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        library_scope varchar(8) NOT NULL CHECK (library_scope IN (${sqlStringList(KNOWLEDGE_LIBRARY_SCOPES)})),
        work_id uuid REFERENCES works(id) ON DELETE CASCADE,
        source_entry_id uuid NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
        target_entry_id uuid NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
        kind varchar(24) NOT NULL CHECK (kind IN (${sqlStringList(KNOWLEDGE_LINK_KINDS)})),
        score numeric(5,4),
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK (source_entry_id <> target_entry_id),
        CHECK ((library_scope = 'global' AND work_id IS NULL) OR (library_scope = 'work' AND work_id IS NOT NULL)),
        UNIQUE (source_entry_id, target_entry_id, kind)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_knowledge_links_source ON knowledge_entry_links (source_entry_id)`
    );
    await queryRunner.query(
      `CREATE INDEX idx_knowledge_links_target ON knowledge_entry_links (target_entry_id)`
    );

    // ---- knowledge_jobs（知识库作业）----
    await queryRunner.query(`
      CREATE TABLE knowledge_jobs (
        id uuid PRIMARY KEY,
        owner_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        library_scope varchar(8) NOT NULL CHECK (library_scope IN (${sqlStringList(KNOWLEDGE_LIBRARY_SCOPES)})),
        work_id uuid REFERENCES works(id) ON DELETE CASCADE,
        entry_id uuid REFERENCES knowledge_entries(id) ON DELETE SET NULL,
        kind varchar(24) NOT NULL CHECK (kind IN (${sqlStringList(KNOWLEDGE_JOB_KINDS)})),
        status varchar(16) NOT NULL DEFAULT 'queued' CHECK (status IN (${sqlStringList(KNOWLEDGE_JOB_STATUSES)})),
        progress jsonb NOT NULL DEFAULT '{}',
        input jsonb NOT NULL DEFAULT '{}',
        result jsonb NOT NULL DEFAULT '{}',
        error jsonb,
        staging_path varchar(255),
        artifact_path varchar(255),
        artifact_size integer,
        artifact_hash char(64),
        idempotency_key varchar(128),
        event_seq integer NOT NULL DEFAULT 0,
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        started_at timestamptz,
        finished_at timestamptz,
        CHECK ((library_scope = 'global' AND work_id IS NULL) OR (library_scope = 'work' AND work_id IS NOT NULL))
      )
    `);
    // 幂等键唯一
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_knowledge_job_idem ON knowledge_jobs (owner_id, kind, idempotency_key) WHERE idempotency_key IS NOT NULL`
    );
    await queryRunner.query(
      `CREATE INDEX idx_knowledge_jobs_list ON knowledge_jobs (owner_id, created_at DESC)`
    );
    await queryRunner.query(
      `CREATE INDEX idx_knowledge_jobs_status ON knowledge_jobs (status)`
    );
    // 同一 entry_id 同时只允许一个 structure 作业运行
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_knowledge_job_structure ON knowledge_jobs (entry_id) WHERE kind='structure' AND status IN ('queued','running')`
    );

    // ---- knowledge_job_events（作业事件）----
    await queryRunner.query(`
      CREATE TABLE knowledge_job_events (
        id uuid PRIMARY KEY,
        job_id uuid NOT NULL REFERENCES knowledge_jobs(id) ON DELETE CASCADE,
        event_seq integer NOT NULL,
        type varchar(16) NOT NULL CHECK (type IN (${sqlStringList(KNOWLEDGE_JOB_EVENT_TYPES)})),
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (job_id, event_seq)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_knowledge_job_events ON knowledge_job_events (job_id, event_seq)`
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // 按依赖逆序删表；不删除 pg_trgm 扩展
    await queryRunner.query('DROP TABLE IF EXISTS knowledge_job_events');
    await queryRunner.query('DROP TABLE IF EXISTS knowledge_jobs');
    await queryRunner.query('DROP TABLE IF EXISTS knowledge_entry_links');
    await queryRunner.query('DROP TABLE IF EXISTS knowledge_entry_tags');
    await queryRunner.query('DROP TABLE IF EXISTS knowledge_tags');
    await queryRunner.query('DROP TABLE IF EXISTS knowledge_work_refs');
    await queryRunner.query('DROP TABLE IF EXISTS knowledge_entries');
  }
}
