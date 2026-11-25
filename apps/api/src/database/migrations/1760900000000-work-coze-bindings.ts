import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F3 在线体验：为 works 表新增 Coze 绑定字段（旧 work_manager 公开字段子集）。
 * 语义沿用旧架构：coze_bot_id/pat_token 可空（未绑定 bot 的作品不能聊天），
 * interaction_type 默认 'chat'，suggested_questions/parameters 默认空数组，coze_meta 默认空对象。
 */
export class WorkCozeBindings1760900000000 implements MigrationInterface {
  name = 'WorkCozeBindings1760900000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE works
        ADD COLUMN coze_bot_id varchar,
        ADD COLUMN pat_token text,
        ADD COLUMN interaction_type varchar(32) NOT NULL DEFAULT 'chat',
        ADD COLUMN system_prompt text,
        ADD COLUMN prologue text,
        ADD COLUMN suggested_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN parameters jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN model_name varchar,
        ADD COLUMN response_format varchar,
        ADD COLUMN icon_url varchar,
        ADD COLUMN coze_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
        ADD COLUMN project_id uuid
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE works
        DROP COLUMN IF EXISTS project_id,
        DROP COLUMN IF EXISTS coze_meta,
        DROP COLUMN IF EXISTS icon_url,
        DROP COLUMN IF EXISTS response_format,
        DROP COLUMN IF EXISTS model_name,
        DROP COLUMN IF EXISTS parameters,
        DROP COLUMN IF EXISTS suggested_questions,
        DROP COLUMN IF EXISTS prologue,
        DROP COLUMN IF EXISTS system_prompt,
        DROP COLUMN IF EXISTS interaction_type,
        DROP COLUMN IF EXISTS pat_token,
        DROP COLUMN IF EXISTS coze_bot_id
    `);
  }
}
