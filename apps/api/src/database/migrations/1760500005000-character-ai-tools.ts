import type { MigrationInterface, QueryRunner } from 'typeorm';

// M3c-2 角色域 AI 工具注册（服务端权威，幂等）
export class CharacterAiTools1760500005000 implements MigrationInterface {
  name = 'CharacterAiTools1760500005000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO ai_tools (id, tool_id, name, description, enabled)
      VALUES
        (gen_random_uuid(), 'character_extract', '角色关系抽取', '从章节或作品文本中抽取角色与关系候选', true),
        (gen_random_uuid(), 'character_growth_extract', '成长事件抽取', '从章节或作品文本中抽取角色成长事件候选', true),
        (gen_random_uuid(), 'character_avatar_generate', '角色头像生成', '根据角色档案生成头像资产', true)
      ON CONFLICT (tool_id) DO NOTHING
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "DELETE FROM ai_tools WHERE tool_id IN ('character_extract','character_growth_extract','character_avatar_generate')"
    );
  }
}
