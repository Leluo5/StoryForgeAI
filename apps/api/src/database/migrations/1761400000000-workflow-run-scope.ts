import type { MigrationInterface, QueryRunner } from 'typeorm';

// M4-T7 工作流运行迁移：
// 1) ai_workflows 增加 work_id（作品级归属，可空：作者级手动创建的工作流无作品归属）
// 2) ai_tasks.scope 增加 workflow_run（工作流运行动作）
// 3) ai_tasks.work_id 放开 NOT NULL（workflow_run 任务的工作流可能无作品归属）
// 既有 chapter / plot / character / role_profile 行行为不变
export class WorkflowRunScope1761400000000 implements MigrationInterface {
  name = 'WorkflowRunScope1761400000000';

  private async findScopeConstraint(queryRunner: QueryRunner): Promise<string | null> {
    const rows: Array<{ conname: string }> = await queryRunner.query(`
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = 'ai_tasks'::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%scope%'
    `);
    return rows[0]?.conname ?? null;
  }

  async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. ai_workflows.work_id（可空，作品级归属） ──
    await queryRunner.query('ALTER TABLE ai_workflows ADD COLUMN work_id uuid');
    await queryRunner.query('ALTER TABLE ai_workflows DROP CONSTRAINT IF EXISTS fk_ai_workflows_work_id');
    await queryRunner.query(`
      ALTER TABLE ai_workflows ADD CONSTRAINT fk_ai_workflows_work_id
        FOREIGN KEY (work_id) REFERENCES works(id) ON DELETE SET NULL
    `);
    await queryRunner.query('CREATE INDEX idx_ai_workflows_work ON ai_workflows(work_id)');

    // ── 2. ai_tasks.work_id 放开 NOT NULL（workflow_run 任务的工作流可能无作品归属） ──
    await queryRunner.query('ALTER TABLE ai_tasks ALTER COLUMN work_id DROP NOT NULL');

    // ── 3. scope 增加 workflow_run ──
    const existing = await this.findScopeConstraint(queryRunner);
    if (existing) {
      await queryRunner.query(`ALTER TABLE ai_tasks DROP CONSTRAINT "${existing}"`);
    }
    await queryRunner.query(`
      ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_scope_check
        CHECK (scope IN ('chapter', 'plot', 'character', 'role_profile', 'workflow_run'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // down 前移除 workflow_run 任务，保证恢复原 CHECK 时无违规行
    await queryRunner.query("DELETE FROM ai_tasks WHERE scope = 'workflow_run'");
    const existing = await this.findScopeConstraint(queryRunner);
    if (existing) {
      await queryRunner.query(`ALTER TABLE ai_tasks DROP CONSTRAINT "${existing}"`);
    }
    await queryRunner.query(`
      ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_scope_check
        CHECK (scope IN ('chapter', 'plot', 'character', 'role_profile'))
    `);
    // work_id 恢复 NOT NULL：workflow_run 行已在上面删除，无残留空值
    await queryRunner.query('ALTER TABLE ai_tasks ALTER COLUMN work_id SET NOT NULL');

    await queryRunner.query('DROP INDEX IF EXISTS idx_ai_workflows_work');
    await queryRunner.query('ALTER TABLE ai_workflows DROP CONSTRAINT IF EXISTS fk_ai_workflows_work_id');
    await queryRunner.query('ALTER TABLE ai_workflows DROP COLUMN IF EXISTS work_id');
  }
}