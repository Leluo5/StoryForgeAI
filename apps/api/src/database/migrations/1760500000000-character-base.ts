import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
  AI_DRAFT_INPUT_SCOPES,
  AI_DRAFT_KINDS,
  AI_DRAFT_STATUSES,
  AI_ITEM_KINDS,
  AI_ITEM_STATUSES,
  AVATAR_ASSET_STATUSES,
  AVATAR_MIMES,
  AVATAR_STORAGE_KINDS,
  CHARACTER_ORIGINS,
  CHARACTER_STATUSES,
  DUPLICATE_RESOLUTIONS,
  GROWTH_EVENT_ORIGINS,
  GROWTH_EVENT_STATUSES,
  PORTABILITY_JOB_KINDS,
  PORTABILITY_JOB_STATUSES,
  PORTABILITY_MODES,
  RELATION_LINE_STYLES,
  RELATION_ORIGINS,
  sqlStringList
} from '../character-enums';

// M3c-2 角色域基础表（11 张）：角色 / 别名 / 关系类型 / 关系 / 视图 / 视图成员 /
// 成长事件 / 头像资产 / AI 草稿 / AI 候选条目 / 导入导出作业
// 设计见 docs/04-功能交付档案/M3c-2-角色版图/02-技术方案.md §2.1、§2.2.1~§2.2.11
export class CharacterBase1760500000000 implements MigrationInterface {
  name = 'CharacterBase1760500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 角色：先建表不加 avatar_asset_id 外键，等头像资产表建好再补（循环引用）
    await queryRunner.query(`
      CREATE TABLE characters (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        name varchar(60) NOT NULL,
        name_key varchar(60) NOT NULL,
        identity varchar(80),
        age integer CHECK (age IS NULL OR (age >= 0 AND age <= 10000)),
        gender varchar(16),
        personality varchar(2000) NOT NULL DEFAULT '',
        experience text NOT NULL DEFAULT '',
        country_region varchar(80),
        faith varchar(80),
        faction varchar(80),
        race varchar(80),
        occupation varchar(80),
        age_band varchar(40),
        attributes jsonb NOT NULL DEFAULT '[]',
        avatar_asset_id uuid,
        status varchar(16) NOT NULL DEFAULT 'active'
          CHECK (status IN (${sqlStringList(CHARACTER_STATUSES)})),
        merged_into_id uuid REFERENCES characters(id) ON DELETE SET NULL,
        archived_at timestamptz,
        archived_by uuid,
        origin varchar(16) NOT NULL DEFAULT 'manual'
          CHECK (origin IN (${sqlStringList(CHARACTER_ORIGINS)})),
        version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_characters_merged_target CHECK (status <> 'merged' OR merged_into_id IS NOT NULL),
        CONSTRAINT ck_characters_archived_at CHECK (status <> 'archived' OR archived_at IS NOT NULL),
        CONSTRAINT ck_characters_merged_not_self CHECK (merged_into_id IS NULL OR merged_into_id <> id)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_characters_work_status ON characters(work_id, status, updated_at DESC)'
    );
    await queryRunner.query('CREATE INDEX idx_characters_work_name_key ON characters(work_id, name_key)');
    await queryRunner.query(
      'CREATE INDEX idx_characters_work_filters ON characters(work_id, country_region, faith, faction, race, occupation, age_band)'
    );

    // 别名：同角色别名唯一，按作品 + alias_key 检索疑似重复
    await queryRunner.query(`
      CREATE TABLE character_aliases (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL,
        character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        alias varchar(60) NOT NULL,
        alias_key varchar(60) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_character_aliases_character_key UNIQUE (character_id, alias_key)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_character_aliases_work_key ON character_aliases(work_id, alias_key)'
    );

    // 关系类型：作品内 code 唯一；无方向类型不允许反向称谓
    await queryRunner.query(`
      CREATE TABLE character_relation_types (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        code varchar(40) NOT NULL,
        label varchar(40) NOT NULL,
        group_key varchar(40) NOT NULL,
        group_label varchar(40) NOT NULL,
        directed boolean NOT NULL DEFAULT true,
        reverse_label varchar(40),
        is_builtin boolean NOT NULL DEFAULT false,
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_character_relation_types_work_code UNIQUE (work_id, code),
        CONSTRAINT ck_character_relation_types_undirected CHECK (directed OR reverse_label IS NULL)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_character_relation_types_work ON character_relation_types(work_id, sort_order)'
    );

    // 关系实例：禁止自我关联；同一对角色同一类型唯一，多类型可并存
    await queryRunner.query(`
      CREATE TABLE character_relations (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        source_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        target_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        type_id uuid NOT NULL REFERENCES character_relation_types(id) ON DELETE RESTRICT,
        directed boolean NOT NULL,
        pair_key varchar(80) NOT NULL,
        label varchar(40) NOT NULL,
        reverse_label varchar(40),
        color varchar(7) NOT NULL CHECK (color ~ '^#[0-9a-fA-F]{6}$'),
        line_style varchar(16) NOT NULL DEFAULT 'solid'
          CHECK (line_style IN (${sqlStringList(RELATION_LINE_STYLES)})),
        tag varchar(40) NOT NULL,
        origin varchar(16) NOT NULL DEFAULT 'manual'
          CHECK (origin IN (${sqlStringList(RELATION_ORIGINS)})),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_character_relations_not_self CHECK (source_id <> target_id),
        CONSTRAINT ck_character_relations_undirected CHECK (directed OR reverse_label IS NULL),
        CONSTRAINT uq_character_relations_pair_type UNIQUE (work_id, pair_key, type_id)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_character_relations_work_source ON character_relations(work_id, source_id)'
    );
    await queryRunner.query(
      'CREATE INDEX idx_character_relations_work_target ON character_relations(work_id, target_id)'
    );
    await queryRunner.query('CREATE INDEX idx_character_relations_type ON character_relations(type_id)');

    // 视图：每作品仅一张默认视图（部分唯一索引）
    await queryRunner.query(`
      CREATE TABLE character_views (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        name varchar(60) NOT NULL,
        is_default boolean NOT NULL DEFAULT false,
        filters jsonb NOT NULL DEFAULT '{}',
        version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
        sort_order integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_character_views_work_name UNIQUE (work_id, name)
      )
    `);
    await queryRunner.query(
      'CREATE UNIQUE INDEX uq_character_views_default ON character_views(work_id) WHERE is_default'
    );

    // 视图成员与布局：显式成员 + 每视图坐标，坐标为空表示待前端确定性布局
    await queryRunner.query(`
      CREATE TABLE character_view_nodes (
        id uuid PRIMARY KEY,
        view_id uuid NOT NULL REFERENCES character_views(id) ON DELETE CASCADE,
        character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        x integer,
        y integer,
        arranged boolean NOT NULL DEFAULT false,
        sort_index integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_character_view_nodes_member UNIQUE (view_id, character_id)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_character_view_nodes_view ON character_view_nodes(view_id, sort_index)'
    );

    // 成长事件：plot_node_id 弱引用不建外键，标题快照保证节点删除后仍可解释
    await queryRunner.query(`
      CREATE TABLE character_growth_events (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        title varchar(120) NOT NULL,
        content text NOT NULL DEFAULT '',
        event_time varchar(120),
        plot_node_id uuid,
        plot_node_title varchar(120),
        chapter_id uuid REFERENCES chapters(id) ON DELETE SET NULL,
        status varchar(16) NOT NULL DEFAULT 'active'
          CHECK (status IN (${sqlStringList(GROWTH_EVENT_STATUSES)})),
        archived_at timestamptz,
        origin varchar(16) NOT NULL DEFAULT 'manual'
          CHECK (origin IN (${sqlStringList(GROWTH_EVENT_ORIGINS)})),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_character_growth_character ON character_growth_events(work_id, character_id, created_at DESC)'
    );
    await queryRunner.query(
      'CREATE INDEX idx_character_growth_chapter ON character_growth_events(work_id, chapter_id)'
    );
    await queryRunner.query(
      'CREATE INDEX idx_character_growth_node ON character_growth_events(work_id, plot_node_id)'
    );
    await queryRunner.query(
      'CREATE INDEX idx_character_growth_status ON character_growth_events(work_id, status)'
    );

    // 头像资产：每角色至多一张 active（部分唯一索引）
    await queryRunner.query(`
      CREATE TABLE character_avatar_assets (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        status varchar(16) NOT NULL
          CHECK (status IN (${sqlStringList(AVATAR_ASSET_STATUSES)})),
        storage_kind varchar(16) NOT NULL DEFAULT 'file'
          CHECK (storage_kind IN (${sqlStringList(AVATAR_STORAGE_KINDS)})),
        storage_path varchar(255),
        mime varchar(40) NOT NULL CHECK (mime IN (${sqlStringList(AVATAR_MIMES)})),
        byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 1048576),
        width integer,
        height integer,
        content_hash char(64) NOT NULL,
        task_id uuid,
        error jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      "CREATE UNIQUE INDEX uq_character_avatar_active ON character_avatar_assets(character_id) WHERE status = 'active'"
    );
    await queryRunner.query(
      'CREATE INDEX idx_character_avatar_character ON character_avatar_assets(character_id, created_at DESC)'
    );

    // 循环外键最后补：角色当前头像
    await queryRunner.query(`
      ALTER TABLE characters ADD CONSTRAINT fk_characters_avatar_asset
        FOREIGN KEY (avatar_asset_id) REFERENCES character_avatar_assets(id) ON DELETE SET NULL
    `);

    // AI 草稿：一任务最多一份（UNIQUE task_id），同作品幂等键唯一
    await queryRunner.query(`
      CREATE TABLE character_ai_drafts (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        kind varchar(24) NOT NULL CHECK (kind IN (${sqlStringList(AI_DRAFT_KINDS)})),
        input_scope varchar(16) NOT NULL CHECK (input_scope IN (${sqlStringList(AI_DRAFT_INPUT_SCOPES)})),
        input_chapter_id uuid,
        status varchar(16) NOT NULL DEFAULT 'pending'
          CHECK (status IN (${sqlStringList(AI_DRAFT_STATUSES)})),
        raw_payload jsonb,
        summary jsonb,
        error jsonb,
        task_id uuid,
        idempotency_key varchar(128) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_character_ai_drafts_idem UNIQUE (work_id, idempotency_key),
        CONSTRAINT uq_character_ai_drafts_task UNIQUE (task_id)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_character_ai_drafts_work ON character_ai_drafts(work_id, created_at DESC)'
    );

    // AI 候选条目：逐条确认，payload 按 kind 受控
    await queryRunner.query(`
      CREATE TABLE character_ai_candidate_items (
        id uuid PRIMARY KEY,
        draft_id uuid NOT NULL REFERENCES character_ai_drafts(id) ON DELETE CASCADE,
        item_index integer NOT NULL,
        kind varchar(16) NOT NULL CHECK (kind IN (${sqlStringList(AI_ITEM_KINDS)})),
        payload jsonb NOT NULL,
        dependencies jsonb NOT NULL DEFAULT '[]',
        suspected_duplicates jsonb NOT NULL DEFAULT '[]',
        status varchar(16) NOT NULL DEFAULT 'pending'
          CHECK (status IN (${sqlStringList(AI_ITEM_STATUSES)})),
        resolution varchar(16)
          CHECK (resolution IN (${sqlStringList(DUPLICATE_RESOLUTIONS)})),
        resolved_entity_id uuid,
        resolved_at timestamptz,
        CONSTRAINT uq_character_ai_items_index UNIQUE (draft_id, item_index)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_character_ai_items_status ON character_ai_candidate_items(draft_id, status)'
    );

    // 导入导出作业：同步执行，用于审计与幂等重放
    await queryRunner.query(`
      CREATE TABLE character_portability_jobs (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        kind varchar(16) NOT NULL CHECK (kind IN (${sqlStringList(PORTABILITY_JOB_KINDS)})),
        status varchar(16) NOT NULL CHECK (status IN (${sqlStringList(PORTABILITY_JOB_STATUSES)})),
        schema_version integer NOT NULL,
        mode varchar(16) CHECK (mode IN (${sqlStringList(PORTABILITY_MODES)})),
        idempotency_key varchar(128),
        summary jsonb NOT NULL DEFAULT '{}',
        conflicts jsonb NOT NULL DEFAULT '[]',
        error jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_character_portability_idem
        ON character_portability_jobs(work_id, kind, idempotency_key)
        WHERE idempotency_key IS NOT NULL
    `);
    await queryRunner.query(
      'CREATE INDEX idx_character_portability_work ON character_portability_jobs(work_id, created_at DESC)'
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE characters DROP CONSTRAINT IF EXISTS fk_characters_avatar_asset');
    await queryRunner.query('DROP TABLE IF EXISTS character_portability_jobs');
    await queryRunner.query('DROP TABLE IF EXISTS character_ai_candidate_items');
    await queryRunner.query('DROP TABLE IF EXISTS character_ai_drafts');
    await queryRunner.query('DROP TABLE IF EXISTS character_avatar_assets');
    await queryRunner.query('DROP TABLE IF EXISTS character_growth_events');
    await queryRunner.query('DROP TABLE IF EXISTS character_view_nodes');
    await queryRunner.query('DROP TABLE IF EXISTS character_views');
    await queryRunner.query('DROP TABLE IF EXISTS character_relations');
    await queryRunner.query('DROP TABLE IF EXISTS character_relation_types');
    await queryRunner.query('DROP TABLE IF EXISTS character_aliases');
    await queryRunner.query('DROP TABLE IF EXISTS characters');
  }
}
