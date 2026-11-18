import type { MigrationInterface, QueryRunner } from 'typeorm';

// M3c-1 剧情数据层：剧情树 + 节点 + 关联 + 分组 + 推衍会话/步骤/候选 + 自动建树草稿
// 设计见 docs/04-功能交付档案/M3c-1-剧情/02-技术方案.md §2.1
export class PlotBase1760300000000 implements MigrationInterface {
  name = 'PlotBase1760300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 剧情树：一作品一树（UNIQUE work_id），version 为结构乐观锁
    await queryRunner.query(`
      CREATE TABLE plot_trees (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        title varchar(120) NOT NULL,
        source varchar(16) NOT NULL DEFAULT 'manual'
          CHECK (source IN ('manual','outline','novel_text','import')),
        schema_version integer NOT NULL DEFAULT 1,
        version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_plot_trees_work UNIQUE (work_id)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_plot_trees_updated ON plot_trees(work_id, updated_at DESC)');

    // 分组 / 泳道：仅视觉归类，删除时节点解组（SET NULL）
    await queryRunner.query(`
      CREATE TABLE plot_groups (
        id uuid PRIMARY KEY,
        tree_id uuid NOT NULL REFERENCES plot_trees(id) ON DELETE CASCADE,
        name varchar(80) NOT NULL,
        kind varchar(16) NOT NULL CHECK (kind IN ('group','swimlane')),
        order_index integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_plot_groups_name UNIQUE (tree_id, name)
      )
    `);

    // 节点：parent_id 自引用级联删子树；group_id 删组时置空
    await queryRunner.query(`
      CREATE TABLE plot_nodes (
        id uuid PRIMARY KEY,
        tree_id uuid NOT NULL REFERENCES plot_trees(id) ON DELETE CASCADE,
        parent_id uuid REFERENCES plot_nodes(id) ON DELETE CASCADE,
        sibling_order integer NOT NULL DEFAULT 0,
        title varchar(120) NOT NULL,
        summary varchar(255),
        content text NOT NULL DEFAULT '',
        attributes jsonb NOT NULL DEFAULT '{}',
        position_x integer NOT NULL DEFAULT 0,
        position_y integer NOT NULL DEFAULT 0,
        group_id uuid REFERENCES plot_groups(id) ON DELETE SET NULL,
        origin varchar(16) NOT NULL DEFAULT 'manual'
          CHECK (origin IN ('manual','derivation','outline','novel_text','import')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_plot_nodes_not_self_parent CHECK (id <> parent_id)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_plot_nodes_tree ON plot_nodes(tree_id, parent_id, sibling_order)');
    await queryRunner.query('CREATE INDEX idx_plot_nodes_group ON plot_nodes(tree_id, group_id)');

    // 关联：线性（DAG）/ 非线性（无先后），同一对节点同类关联唯一
    await queryRunner.query(`
      CREATE TABLE plot_links (
        id uuid PRIMARY KEY,
        tree_id uuid NOT NULL REFERENCES plot_trees(id) ON DELETE CASCADE,
        source_id uuid NOT NULL REFERENCES plot_nodes(id) ON DELETE CASCADE,
        target_id uuid NOT NULL REFERENCES plot_nodes(id) ON DELETE CASCADE,
        type varchar(16) NOT NULL CHECK (type IN ('linear','non_linear')),
        label varchar(255),
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT ck_plot_links_not_self CHECK (source_id <> target_id),
        CONSTRAINT uq_plot_links_edge UNIQUE (tree_id, source_id, target_id, type)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_plot_links_source ON plot_links(tree_id, source_id)');
    await queryRunner.query('CREATE INDEX idx_plot_links_target ON plot_links(tree_id, target_id)');

    // 推衍会话：起点节点删除时级联删除会话
    await queryRunner.query(`
      CREATE TABLE derivation_sessions (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        tree_id uuid NOT NULL REFERENCES plot_trees(id) ON DELETE CASCADE,
        start_node_id uuid NOT NULL REFERENCES plot_nodes(id) ON DELETE CASCADE,
        place varchar(120) NOT NULL,
        background text NOT NULL,
        time_node varchar(120),
        premise_node_ids uuid[] NOT NULL DEFAULT '{}',
        related_node_ids uuid[] NOT NULL DEFAULT '{}',
        characters jsonb NOT NULL DEFAULT '[]',
        random_enabled boolean NOT NULL DEFAULT true,
        random_character_enabled boolean NOT NULL DEFAULT true,
        status varchar(16) NOT NULL DEFAULT 'idle'
          CHECK (status IN ('idle','running','paused','finished','failed')),
        step_index integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_derivation_sessions_tree ON derivation_sessions(tree_id, updated_at DESC)');

    // 推衍步骤：UNIQUE(session_id, step_no) 防重复写入
    await queryRunner.query(`
      CREATE TABLE derivation_steps (
        id uuid PRIMARY KEY,
        session_id uuid NOT NULL REFERENCES derivation_sessions(id) ON DELETE CASCADE,
        step_no integer NOT NULL,
        content text NOT NULL DEFAULT '',
        event jsonb,
        new_characters jsonb NOT NULL DEFAULT '[]',
        branches jsonb NOT NULL DEFAULT '[]',
        chosen_branch_id varchar(40),
        task_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_derivation_steps_no UNIQUE (session_id, step_no)
      )
    `);

    // 回写候选：start_node_id 不设外键，节点被删时保留候选并由服务层返回 409
    await queryRunner.query(`
      CREATE TABLE derivation_candidates (
        id uuid PRIMARY KEY,
        session_id uuid NOT NULL REFERENCES derivation_sessions(id) ON DELETE CASCADE,
        start_node_id uuid NOT NULL,
        placement varchar(16) NOT NULL CHECK (placement IN ('child','sibling')),
        payload jsonb NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','confirmed','rejected')),
        confirmed_node_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        confirmed_at timestamptz
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_derivation_candidates_session ON derivation_candidates(session_id, status)'
    );

    // 自动建树草稿（第二阶段）：解析结果先进草稿，确认后提交
    await queryRunner.query(`
      CREATE TABLE plot_generation_drafts (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        source varchar(16) NOT NULL CHECK (source IN ('outline','novel_text')),
        input_text text NOT NULL,
        input_chapter_id uuid REFERENCES chapters(id) ON DELETE SET NULL,
        status varchar(16) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','succeeded','failed','committed','discarded')),
        payload jsonb,
        error jsonb,
        task_id uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // 剧情相关工具注册（服务端权威，幂等）
    await queryRunner.query(`
      INSERT INTO ai_tools (id, tool_id, name, description, enabled)
      VALUES
        (gen_random_uuid(), 'plot_derivation', '剧情推衍', '基于剧情节点逐步推衍剧情', true),
        (gen_random_uuid(), 'plot_generate', '剧情结构生成', '从大纲或章节文本解析生成剧情树', true)
      ON CONFLICT (tool_id) DO NOTHING
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM ai_tools WHERE tool_id IN ('plot_derivation','plot_generate')");
    await queryRunner.query('DROP TABLE IF EXISTS plot_generation_drafts');
    await queryRunner.query('DROP TABLE IF EXISTS derivation_candidates');
    await queryRunner.query('DROP TABLE IF EXISTS derivation_steps');
    await queryRunner.query('DROP TABLE IF EXISTS derivation_sessions');
    await queryRunner.query('DROP TABLE IF EXISTS plot_links');
    await queryRunner.query('DROP TABLE IF EXISTS plot_nodes');
    await queryRunner.query('DROP TABLE IF EXISTS plot_groups');
    await queryRunner.query('DROP TABLE IF EXISTS plot_trees');
  }
}
