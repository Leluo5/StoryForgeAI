import type { MigrationInterface, QueryRunner } from 'typeorm';

// F11 AI 任务作用域扩展：ai_tasks.scope 增加 role_profile（角色资料生成）
// 既有 chapter / plot / character 行行为不变；约束名动态查询再 drop / add
// 设计见 docs/04-功能交付档案/F11-多平台Agent协同/02-技术方案.md §3.1
export class AiTaskRoleProfileScope1760700001000 implements MigrationInterface {
  name = 'AiTaskRoleProfileScope1760700001000';

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
    const existing = await this.findScopeConstraint(queryRunner);
    if (existing) {
      await queryRunner.query(`ALTER TABLE ai_tasks DROP CONSTRAINT "${existing}"`);
    }
    await queryRunner.query(`
      ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_scope_check
        CHECK (scope IN ('chapter', 'plot', 'character', 'role_profile'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // down 前移除 role_profile 任务，保证恢复原 CHECK 时无违规行
    await queryRunner.query("DELETE FROM ai_tasks WHERE scope = 'role_profile'");
    const existing = await this.findScopeConstraint(queryRunner);
    if (existing) {
      await queryRunner.query(`ALTER TABLE ai_tasks DROP CONSTRAINT "${existing}"`);
    }
    await queryRunner.query(`
      ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_scope_check
        CHECK (scope IN ('chapter', 'plot', 'character'))
    `);
  }
}
