import type { MigrationInterface, QueryRunner } from 'typeorm';

// M3c-2 AI 任务作用域扩展：ai_tasks 增加 character（角色/关系候选、成长候选、头像生成）
// 既有 chapter / plot 行行为不变；约束名由 TypeORM 生成，先查 pg_constraint 再 drop / add
export class AiTaskCharacterScope1760500001000 implements MigrationInterface {
  name = 'AiTaskCharacterScope1760500001000';

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
        CHECK (scope IN ('chapter', 'plot', 'character'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // down 前移除 character 任务，保证恢复原 CHECK 时无违规行
    await queryRunner.query("DELETE FROM ai_tasks WHERE scope = 'character'");
    const existing = await this.findScopeConstraint(queryRunner);
    if (existing) {
      await queryRunner.query(`ALTER TABLE ai_tasks DROP CONSTRAINT "${existing}"`);
    }
    await queryRunner.query(`
      ALTER TABLE ai_tasks ADD CONSTRAINT ai_tasks_scope_check
        CHECK (scope IN ('chapter', 'plot'))
    `);
  }
}
