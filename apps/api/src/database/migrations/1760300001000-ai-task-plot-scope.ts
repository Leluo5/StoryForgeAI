import type { MigrationInterface, QueryRunner } from 'typeorm';

// M3c-1 AI 任务作用域扩展：章节任务（chapter）与剧情推衍任务（plot）共用 ai_tasks
// 既有行默认 scope='chapter'，章节链路行为不变；plot 任务 chapter_id 为空
export class AiTaskPlotScope1760300001000 implements MigrationInterface {
  name = 'AiTaskPlotScope1760300001000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE ai_tasks ALTER COLUMN chapter_id DROP NOT NULL');
    await queryRunner.query(`
      ALTER TABLE ai_tasks ADD COLUMN scope varchar(16) NOT NULL DEFAULT 'chapter'
        CHECK (scope IN ('chapter','plot'))
    `);
    await queryRunner.query('CREATE INDEX idx_ai_tasks_scope_status ON ai_tasks(scope, status)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DELETE FROM ai_tasks WHERE scope = 'plot'");
    await queryRunner.query('DROP INDEX IF EXISTS idx_ai_tasks_scope_status');
    await queryRunner.query('ALTER TABLE ai_tasks DROP COLUMN scope');
    await queryRunner.query('ALTER TABLE ai_tasks ALTER COLUMN chapter_id SET NOT NULL');
  }
}
