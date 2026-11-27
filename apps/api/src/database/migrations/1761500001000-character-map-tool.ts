import type { MigrationInterface, QueryRunner } from 'typeorm';

// M4-T8 角色版 AI 建图工具注册（服务端权威，幂等；建图仅基于已入库角色生成关系边）
export class CharacterMapTool1761500001000 implements MigrationInterface {
  name = 'CharacterMapTool1761500001000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO ai_tools (id, tool_id, name, description, enabled)
      VALUES
        (gen_random_uuid(), 'character_map_generate', 'AI建图', '基于已入库角色生成关系边', true)
      ON CONFLICT (tool_id) DO NOTHING
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "DELETE FROM ai_tools WHERE tool_id = 'character_map_generate'"
    );
  }
}
