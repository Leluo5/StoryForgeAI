import type { MigrationInterface, QueryRunner } from 'typeorm';

// F12 工作流管理：创作工作流配置（作者级）
// ai_workflows：作者级 Workflow 配置（模型 + 平台标识 + 版本快照 + 三态归档）
// 精简 + 去敏感：
//  - platform_config 只存非敏感标识（workflow_id/workspace_id）
//  - llm_config 只存 model（base_url/api_key 由服务端 env 注入，禁止入库）
//  - status 三态：active / disabled / archived（CHECK 约束）
//  - versions JSONB 存版本快照数组（保留最近 50 条，服务层截断）
export class WorkflowBase1760700002000 implements MigrationInterface {
  name = 'WorkflowBase1760700002000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 工作流：作者级配置，同作者名称唯一
    await queryRunner.query(`
      CREATE TABLE ai_workflows (
        id uuid PRIMARY KEY,
        author_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        name varchar(80) NOT NULL,
        description text NOT NULL DEFAULT '',
        status varchar(16) NOT NULL DEFAULT 'active'
          CHECK (status IN ('active','disabled','archived')),
        platform varchar(16) NOT NULL DEFAULT 'coze',
        platform_config jsonb NOT NULL DEFAULT '{}',
        llm_config jsonb NOT NULL DEFAULT '{}',
        source varchar(16) NOT NULL DEFAULT 'manual',
        version_no int NOT NULL DEFAULT 1,
        versions jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        archived_at timestamptz,
        CONSTRAINT uq_ai_workflows_author_name UNIQUE (author_id, name)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_ai_workflows_author ON ai_workflows(author_id, created_at DESC)');
    await queryRunner.query('CREATE INDEX idx_ai_workflows_status ON ai_workflows(author_id, status)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS ai_workflows');
  }
}
