import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * F2 尾巴（访问码/公开子能力）：为 works 表新增 is_public / access_code 字段。
 * 旧架构默认 is_public=True、access_code=""，此处沿用同样的默认语义。
 */
export class WorkAccessCode1760800000000 implements MigrationInterface {
  name = 'WorkAccessCode1760800000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE works
        ADD COLUMN is_public boolean NOT NULL DEFAULT true,
        ADD COLUMN access_code varchar(64) NOT NULL DEFAULT ''
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE works
        DROP COLUMN IF EXISTS access_code,
        DROP COLUMN IF EXISTS is_public
    `);
  }
}
