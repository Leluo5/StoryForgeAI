import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Agent 模块从「作者级通用 AI Agent」升级为「作品级三类 Agent（role/tool/flow_step）」：
 * 1. ai_agents 表加 project_id / kind / role_id / tool_name / step_order / scope / platform_config / source / tags / manual_group_key / credential_source / version_no / versions / archived_at
 * 2. status 状态机从二值升级为三值（active/disabled/archived）
 * 3. 新表 flow_progress（角色 11 步流程进度）、agent_group_overrides（分组覆盖层）、role_agent_bindings（角色-Agent 绑定）
 * 4. 按 kind 建立唯一性索引（每 project+step_order 仅一个 flow_step_agent active 等）
 * 5. 存量 Agent kind=legacy、status=active/disabled 保持不变，新列有 default 不影响
 */
export class AgentProjectLevelUp1760400000000 implements MigrationInterface {
  name = 'AgentProjectLevelUp1760400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ─── 1. ALTER TABLE ai_agents 加列 ───
    await queryRunner.query(`ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS project_id uuid`);
    await queryRunner.query(`ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS kind varchar(24) NOT NULL DEFAULT 'legacy'`);
    await queryRunner.query(`ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS description text DEFAULT ''`);
    await queryRunner.query(`ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS role_id uuid`);
    await queryRunner.query(`ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS tool_name varchar(40)`);
    await queryRunner.query(`ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS step_order int`);
    await queryRunner.query(`ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS scope varchar(16) DEFAULT 'project'`);
    await queryRunner.query(`ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS platform_config jsonb NOT NULL DEFAULT '{}'`);
    await queryRunner.query(`ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS source varchar(16) DEFAULT 'manual'`);
    await queryRunner.query(`ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'`);
    await queryRunner.query(`ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS manual_group_key uuid`);
    await queryRunner.query(`ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS credential_source varchar(16) DEFAULT 'global'`);
    await queryRunner.query(`ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS version_no int NOT NULL DEFAULT 1`);
    await queryRunner.query(`ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS versions jsonb NOT NULL DEFAULT '[]'`);
    await queryRunner.query(`ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS archived_at timestamptz`);

    // ─── 2. DROP 旧 CHECK（status 二值） + 重建为三值 ───
    // TypeORM / PG 可能生成的约束名：ai_agents_status_check（自动） 或显式名
    await queryRunner.query(`ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS ai_agents_status_check`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS chk_ai_agents_status_v2`);
    await queryRunner.query(`
      ALTER TABLE ai_agents ADD CONSTRAINT chk_ai_agents_status_v2
      CHECK (status IN ('active', 'disabled', 'archived'))
    `);

    // ─── 3. 新 CHECK 约束 ───
    await queryRunner.query(`ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS chk_ai_agents_kind`);
    await queryRunner.query(`
      ALTER TABLE ai_agents ADD CONSTRAINT chk_ai_agents_kind
      CHECK (kind IN ('legacy', 'role_agent', 'tool_agent', 'flow_step_agent'))
    `);

    await queryRunner.query(`ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS chk_ai_agents_step_order`);
    await queryRunner.query(`
      ALTER TABLE ai_agents ADD CONSTRAINT chk_ai_agents_step_order
      CHECK (step_order IS NULL OR (step_order >= 1 AND step_order <= 11))
    `);

    await queryRunner.query(`ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS chk_ai_agents_scope`);
    await queryRunner.query(`
      ALTER TABLE ai_agents ADD CONSTRAINT chk_ai_agents_scope
      CHECK (scope IN ('project', 'role'))
    `);

    await queryRunner.query(`ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS chk_ai_agents_credential_source`);
    await queryRunner.query(`
      ALTER TABLE ai_agents ADD CONSTRAINT chk_ai_agents_credential_source
      CHECK (credential_source IN ('global', 'own'))
    `);

    // ─── 4. 按 kind 唯一性索引 ───
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_flow_step_active
      ON ai_agents(project_id, step_order)
      WHERE kind = 'flow_step_agent' AND status = 'active'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_agent_default
      ON ai_agents(project_id, tool_name)
      WHERE kind = 'tool_agent' AND is_default
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_role_agent_default
      ON ai_agents(project_id, role_id)
      WHERE kind = 'role_agent' AND is_default
    `);

    // ─── 5. 新表 flow_progress ───
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS flow_progress (
        project_id uuid NOT NULL,
        role_id uuid NOT NULL,
        run_id uuid,
        status varchar(16) NOT NULL DEFAULT 'idle'
          CHECK (status IN ('idle', 'running', 'done', 'failed')),
        current_step int NOT NULL DEFAULT 0,
        completed_steps int[] NOT NULL DEFAULT '{}',
        steps jsonb NOT NULL DEFAULT '[]',
        context jsonb NOT NULL DEFAULT '{}',
        last_error text DEFAULT '',
        started_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (project_id, role_id)
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_flow_progress_status ON flow_progress(status)
    `);

    // ─── 6. 新表 agent_group_overrides ───
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS agent_group_overrides (
        project_id uuid PRIMARY KEY,
        overrides jsonb NOT NULL DEFAULT '[]',
        manual_groups jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // ─── 7. 新表 role_agent_bindings ───
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS role_agent_bindings (
        id uuid PRIMARY KEY,
        project_id uuid NOT NULL,
        role_id uuid NOT NULL,
        agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
        step_order int,
        enabled boolean NOT NULL DEFAULT true,
        model varchar(80),
        agent_env varchar(16) DEFAULT 'coze',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_role_agent_binding_role_step UNIQUE (role_id, step_order),
        CONSTRAINT chk_role_agent_binding_step CHECK (step_order IS NULL OR (step_order >= 1 AND step_order <= 11))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_role_agent_bindings_role
      ON role_agent_bindings(role_id, enabled)
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS idx_role_agent_bindings_project
      ON role_agent_bindings(project_id)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // ─── 1. DROP 新表（外键依赖顺序） ───
    await queryRunner.query(`DROP TABLE IF EXISTS role_agent_bindings`);
    await queryRunner.query(`DROP TABLE IF EXISTS agent_group_overrides`);
    await queryRunner.query(`DROP TABLE IF EXISTS flow_progress`);

    // ─── 2. DROP 新索引 ───
    await queryRunner.query(`DROP INDEX IF EXISTS uq_role_agent_default`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_tool_agent_default`);
    await queryRunner.query(`DROP INDEX IF EXISTS uq_flow_step_active`);

    // ─── 3. DROP 新 CHECK 约束 ───
    await queryRunner.query(`ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS chk_ai_agents_credential_source`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS chk_ai_agents_scope`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS chk_ai_agents_step_order`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS chk_ai_agents_kind`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP CONSTRAINT IF EXISTS chk_ai_agents_status_v2`);

    // ─── 4. 恢复旧 status 二值 CHECK ───
    await queryRunner.query(`
      ALTER TABLE ai_agents ADD CONSTRAINT ai_agents_status_check
      CHECK (status IN ('active', 'disabled'))
    `);

    // ─── 5. DROP 加的列 ───
    await queryRunner.query(`ALTER TABLE ai_agents DROP COLUMN IF EXISTS archived_at`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP COLUMN IF EXISTS versions`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP COLUMN IF EXISTS version_no`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP COLUMN IF EXISTS credential_source`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP COLUMN IF EXISTS manual_group_key`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP COLUMN IF EXISTS tags`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP COLUMN IF EXISTS source`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP COLUMN IF EXISTS platform_config`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP COLUMN IF EXISTS scope`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP COLUMN IF EXISTS step_order`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP COLUMN IF EXISTS tool_name`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP COLUMN IF EXISTS role_id`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP COLUMN IF EXISTS description`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP COLUMN IF EXISTS kind`);
    await queryRunner.query(`ALTER TABLE ai_agents DROP COLUMN IF EXISTS project_id`);
  }
}
