import type { MigrationInterface, QueryRunner } from 'typeorm';
import { KNOWLEDGE_ORIGINS, sqlStringList } from '../knowledge-enums';

// F1 · Coze 资源导入：knowledge_entries.origin 增加允许值 'coze_import'
// 设计见 docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §2.2（origin 取值清单）
// 背景：1760600000000 中 origin CHECK 是匿名内联约束，PG 自动命名为 knowledge_entries_origin_check。
//       用 DO 块按约束名删除后重建，避免硬编码命名漂移；down 回滚到不含 coze_import。
export class CozeImportOrigin1761100000000 implements MigrationInterface {
  name = 'CozeImportOrigin1761100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE knowledge_entries DROP CONSTRAINT IF EXISTS knowledge_entries_origin_check;
        ALTER TABLE knowledge_entries ADD CONSTRAINT knowledge_entries_origin_check
          CHECK (origin IN (${sqlStringList(KNOWLEDGE_ORIGINS)}));
      END $$;
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    const withoutCoze = KNOWLEDGE_ORIGINS.filter((o) => o !== 'coze_import');
    await queryRunner.query(`
      DO $$
      BEGIN
        ALTER TABLE knowledge_entries DROP CONSTRAINT IF EXISTS knowledge_entries_origin_check;
        ALTER TABLE knowledge_entries ADD CONSTRAINT knowledge_entries_origin_check
          CHECK (origin IN (${sqlStringList(withoutCoze)}));
      END $$;
    `);
  }
}
