import type { MigrationInterface, QueryRunner } from 'typeorm';
import { seedCharacterRelationTypes } from '../character-relation-type.seed';

// M3c-2 存量作品关系类型种子：为已有作品补 5 组 23 类默认关系类型
// 幂等键 UNIQUE (work_id, code)，重复执行不产生重复行；新作品由 WorkService 创建时写入
export class CharacterRelationTypeSeed1760500002000 implements MigrationInterface {
  name = 'CharacterRelationTypeSeed1760500002000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const works: Array<{ id: string }> = await queryRunner.query('SELECT id FROM works');
    for (const work of works) {
      await seedCharacterRelationTypes(queryRunner, work.id);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // 只删未被关系引用的内置种子，作者自定义类型与被引用类型保留
    await queryRunner.query(`
      DELETE FROM character_relation_types type
      WHERE type.is_builtin = true
        AND NOT EXISTS (
          SELECT 1 FROM character_relations relation WHERE relation.type_id = type.id
        )
    `);
  }
}
