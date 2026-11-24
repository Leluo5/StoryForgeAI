import type { MigrationInterface, QueryRunner } from 'typeorm';

// 模型管理：作者级 AI 模型选型目录（静态注册表资源）
// ai_models：作者维护的可用模型清单，供 Agent（model_id）与工作流（llm_config.model）选型。
// 非版本化：两态（active/disabled）+ 直接硬删，无归档/版本快照/回滚。
// 去敏感：仅存 model_id 等非敏感标识（base_url/api_key 由服务端 env 注入，禁止入库）。
export class ModelBase1760700003000 implements MigrationInterface {
  name = 'ModelBase1760700003000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 模型目录：作者级，同作者 model_id 唯一
    await queryRunner.query(`
      CREATE TABLE ai_models (
        id uuid PRIMARY KEY,
        author_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        name varchar(80) NOT NULL,
        provider varchar(24) NOT NULL DEFAULT 'other',
        model_id varchar(80) NOT NULL,
        context_window int NOT NULL DEFAULT 0,
        supports_tools boolean NOT NULL DEFAULT false,
        supports_vision boolean NOT NULL DEFAULT false,
        input_price numeric(12,4) NOT NULL DEFAULT 0,
        output_price numeric(12,4) NOT NULL DEFAULT 0,
        currency varchar(8) NOT NULL DEFAULT 'USD',
        status varchar(16) NOT NULL DEFAULT 'active'
          CHECK (status IN ('active','disabled')),
        sort_order int NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_ai_models_author_model UNIQUE (author_id, model_id)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_ai_models_author ON ai_models(author_id, created_at DESC)');
    await queryRunner.query('CREATE INDEX idx_ai_models_status ON ai_models(author_id, status)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS ai_models');
  }
}
