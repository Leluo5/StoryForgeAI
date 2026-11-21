import type { MigrationInterface, QueryRunner } from 'typeorm';

// F11 多平台 Agent 协同基础表（5 张）+ ai_tasks.channel 列与检查约束
// 设计见 docs/04-功能交付档案/F11-多平台Agent协同/02-技术方案.md §3.1、§3.2
// 约束名显式命名，便于 down 精确删除；up 建表顺序按 FK 依赖，down 按依赖逆序删除
export class CollabBase1760700000000 implements MigrationInterface {
  name = 'CollabBase1760700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // ── ai_tasks 增加 channel 列（记录任务实际通道，切换配置后历史不变） ──
    await queryRunner.query(`
      ALTER TABLE ai_tasks ADD COLUMN channel varchar(16)
    `);
    await queryRunner.query(`
      ALTER TABLE ai_tasks ADD CONSTRAINT ck_ai_tasks_channel
        CHECK (channel IS NULL OR channel IN ('flowise', 'coze'))
    `);

    // ── 1. 协同配置：一作品一份，PK 即 work_id ──
    await queryRunner.query(`
      CREATE TABLE collab_settings (
        work_id uuid PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
        test_character_id uuid NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
        agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE RESTRICT,
        whitelist_fields text[] NOT NULL DEFAULT ARRAY['identity','personality','experience'],
        enabled boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_collab_settings_whitelist_subset
          CHECK (whitelist_fields <@ ARRAY['identity','personality','experience']::text[]),
        CONSTRAINT ck_collab_settings_whitelist_cardinality
          CHECK (cardinality(whitelist_fields) BETWEEN 2 AND 3)
      )
    `);

    // ── 2. 写回单：一任务最多一次写回 ──
    await queryRunner.query(`
      CREATE TABLE role_profile_writebacks (
        id uuid PRIMARY KEY,
        task_id uuid NOT NULL UNIQUE REFERENCES ai_tasks(id) ON DELETE CASCADE,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        channel varchar(16) NOT NULL CHECK (channel IN ('flowise', 'coze')),
        status varchar(24) NOT NULL
          CHECK (status IN ('applied', 'partially_reverted', 'reverted')),
        applied_version integer NOT NULL CHECK (applied_version >= 1),
        applied_by uuid NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_role_profile_writebacks_character
        ON role_profile_writebacks(work_id, character_id, applied_at DESC)
    `);

    // ── 3. 写回字段行：同一写回单内字段不重复 ──
    await queryRunner.query(`
      CREATE TABLE role_profile_writeback_fields (
        id uuid PRIMARY KEY,
        writeback_id uuid NOT NULL REFERENCES role_profile_writebacks(id) ON DELETE CASCADE,
        field_key varchar(32) NOT NULL
          CHECK (field_key IN ('identity', 'personality', 'experience')),
        before_value jsonb,
        after_value jsonb,
        status varchar(16) NOT NULL CHECK (status IN ('applied', 'reverted')),
        reverted_at timestamptz,
        reverted_by uuid,
        CONSTRAINT uq_role_profile_writeback_fields UNIQUE (writeback_id, field_key)
      )
    `);

    // ── 4. 引用快照：一任务多条引用，防上游删除后无法追溯 ──
    await queryRunner.query(`
      CREATE TABLE agent_task_citations (
        id uuid PRIMARY KEY,
        task_id uuid NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
        dataset_id varchar(64) NOT NULL,
        source_id varchar(128) NOT NULL,
        title varchar(200) NOT NULL,
        snippet text NOT NULL,
        score numeric(5,4)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_agent_task_citations_task ON agent_task_citations(task_id, id)
    `);

    // ── 5. 归档发件箱：一任务一条记录，幂等 + 重试 ──
    await queryRunner.query(`
      CREATE TABLE agent_archive_outbox (
        id uuid PRIMARY KEY,
        task_id uuid NOT NULL UNIQUE REFERENCES ai_tasks(id) ON DELETE CASCADE,
        payload jsonb NOT NULL,
        status varchar(16) NOT NULL
          CHECK (status IN ('pending', 'delivered', 'failed')),
        attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_error varchar(500),
        external_id varchar(128),
        delivered_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz
      )
    `);
    await queryRunner.query(`
      CREATE INDEX idx_agent_archive_outbox_status ON agent_archive_outbox(status, updated_at)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // 依赖逆序删除：发件箱 → 引用 → 字段行 → 写回单 → 配置
    await queryRunner.query('DROP TABLE IF EXISTS agent_archive_outbox');
    await queryRunner.query('DROP TABLE IF EXISTS agent_task_citations');
    await queryRunner.query('DROP TABLE IF EXISTS role_profile_writeback_fields');
    await queryRunner.query('DROP TABLE IF EXISTS role_profile_writebacks');
    await queryRunner.query('DROP TABLE IF EXISTS collab_settings');

    // 删除 ai_tasks.channel 列（依赖 CHECK 约束先删）
    await queryRunner.query('ALTER TABLE ai_tasks DROP CONSTRAINT IF EXISTS ck_ai_tasks_channel');
    await queryRunner.query('ALTER TABLE ai_tasks DROP COLUMN IF EXISTS channel');
  }
}
