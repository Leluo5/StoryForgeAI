import type { MigrationInterface, QueryRunner } from 'typeorm';

// M4-T8 AI 建图迁移：
// ai_tasks.scope 增加 character_map（基于已入库角色生成关系边）
// 既有 chapter / plot / character / role_profile / workflow_run 行行为不变
export class CharacterMapScope1761500000000 implements MigrationInterface {
  name = 'CharacterMapScope1761500000000';

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
        CHECK (scope IN ('chapter', 'plot', 'character', 'role_profile', 'workflow_run', 'character_map'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // down 前移除 character_map 任务，保证恢复原 CHECK 时无违规行
    await queryRunner.query("DELETE FROM ai_tasks WHERE scope = 'character_map'");
    const existing = await this.findScopeConstraint(queryRunner);
    if (existing) {
      await queryRunner.query(`ALTER TABLE ai_tasks DROP CONSTRAINT "${existing}"`);
    }
    await queryRunner.query(`
      ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_scope_check
        CHECK (scope IN ('chapter', 'plot', 'character', 'role_profile', 'workflow_run'))
    `);
  }
}
