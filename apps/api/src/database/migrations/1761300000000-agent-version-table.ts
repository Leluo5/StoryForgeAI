import type { MigrationInterface, QueryRunner } from 'typeorm';

// M4-T5：Agent 版本存储从 jsonb 数组（ai_agents.versions）改造成独立表（agent_version）。
// 1. 新建 agent_version 表（每版本一行，snapshot 不可变）
// 2. 迁移存量 ai_agents.versions jsonb 数组 → agent_version 行（元素 action=change_type）
// 3. 重建 uq_ai_agents_author_default：作者级唯一默认只约束 legacy（V2 作品级三类 Agent 的 is_default 不参与作者级唯一）
// 4. 删除 ai_agents.versions jsonb 列（版本历史移至 agent_version 表）
export class AgentVersionTable1761300000000 implements MigrationInterface {
  name = 'AgentVersionTable1761300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 1. agent_version 表
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS agent_version (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        agent_id uuid NOT NULL REFERENCES ai_agents(id) ON DELETE CASCADE,
        version_no integer NOT NULL,
        action varchar(16) NOT NULL,
        note varchar(500) NOT NULL DEFAULT '',
        snapshot jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_agent_version_agent_no UNIQUE (agent_id, version_no)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS idx_agent_version_agent_created ON agent_version(agent_id, created_at ASC)'
    );

    // 2. 迁移存量 ai_agents.versions jsonb 数组 → agent_version 行
    // 元素结构：{ version_no, change_type, note, created_at, snapshot }
    await queryRunner.query(`
      DO $$
      DECLARE
        r RECORD;
        v RECORD;
      BEGIN
        FOR r IN
          SELECT id, versions, version_no FROM ai_agents
          WHERE versions IS NOT NULL AND jsonb_typeof(versions) = 'array' AND jsonb_array_length(versions) > 0
        LOOP
          FOR v IN
            SELECT elem->>'version_no' AS version_no,
                   elem->>'change_type' AS action,
                   COALESCE(elem->>'note', '') AS note,
                   COALESCE(elem->>'created_at', now()::text) AS created_at,
                   COALESCE(elem->'snapshot', '{}'::jsonb) AS snapshot
            FROM jsonb_array_elements(r.versions) AS elem
          LOOP
            INSERT INTO agent_version (agent_id, version_no, action, note, snapshot, created_at)
            VALUES (
              r.id,
              COALESCE(v.version_no::integer, 1),
              COALESCE(v.action, 'update'),
              v.note,
              v.snapshot,
              COALESCE(v.created_at::timestamptz, now())
            )
            ON CONFLICT (agent_id, version_no) DO NOTHING;
          END LOOP;
        END LOOP;
      END $$;
    `);

    // 3. 重建 uq_ai_agents_author_default：只约束 legacy 作者级默认
    await queryRunner.query(`DROP INDEX IF EXISTS uq_ai_agents_author_default`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_ai_agents_author_default
      ON ai_agents(author_id)
      WHERE is_default AND kind = 'legacy'
    `);

    // 4. 删除 ai_agents.versions jsonb 列
    await queryRunner.query(`ALTER TABLE ai_agents DROP COLUMN IF EXISTS versions`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // 恢复 ai_agents.versions jsonb 列（从 agent_version 表聚合回数组）
    await queryRunner.query(`ALTER TABLE ai_agents ADD COLUMN IF NOT EXISTS versions jsonb NOT NULL DEFAULT '[]'`);
    await queryRunner.query(`
      UPDATE ai_agents a
      SET versions = COALESCE(
        (SELECT jsonb_agg(jsonb_build_object(
           'version_no', v.version_no,
           'change_type', v.action,
           'note', v.note,
           'created_at', v.created_at,
           'snapshot', v.snapshot
         ) ORDER BY v.version_no)
         FROM agent_version v WHERE v.agent_id = a.id),
        '[]'::jsonb
      )
    `);

    // 恢复旧 uq_ai_agents_author_default（作者级唯一默认，不限 kind）
    await queryRunner.query(`DROP INDEX IF EXISTS uq_ai_agents_author_default`);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_ai_agents_author_default
      ON ai_agents(author_id)
      WHERE is_default
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS agent_version`);
  }
}
