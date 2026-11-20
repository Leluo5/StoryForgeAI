import type { MigrationInterface, QueryRunner } from 'typeorm';

// M3c-2 剧情节点归属：只存归属关系，不复制剧情内容（标题/坐标/层级仍在 plot_nodes）
// 依赖 characters 与 plot_nodes，必须排在角色基础迁移与剧情基础迁移之后
export class PlotNodeCharacterOwners1760500004000 implements MigrationInterface {
  name = 'PlotNodeCharacterOwners1760500004000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE plot_node_character_owners (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        node_id uuid NOT NULL REFERENCES plot_nodes(id) ON DELETE CASCADE,
        character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        is_exclusive boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_plot_owner_node_character UNIQUE (node_id, character_id)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_plot_owner_character ON plot_node_character_owners(work_id, character_id, is_exclusive)'
    );
    await queryRunner.query('CREATE INDEX idx_plot_owner_node ON plot_node_character_owners(node_id)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS plot_node_character_owners');
  }
}
