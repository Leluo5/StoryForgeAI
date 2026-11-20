import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 推衍会话的起点节点改为「弱引用」：
 * 节点被删除后会话仍保留，作者可重新选择回写位置；
 * 确认回写时由服务层检测起点已删并返回 409（与 derivation_candidates 的设计一致）。
 */
export class DerivationSessionStartNodeNoFk1760300002000 implements MigrationInterface {
  name = 'DerivationSessionStartNodeNoFk1760300002000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE derivation_sessions DROP CONSTRAINT IF EXISTS derivation_sessions_start_node_id_fkey'
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // 回滚前清理悬空引用，否则无法重建外键
    await queryRunner.query(`
      DELETE FROM derivation_sessions session
      WHERE NOT EXISTS (SELECT 1 FROM plot_nodes node WHERE node.id = session.start_node_id)
    `);
    await queryRunner.query(`
      ALTER TABLE derivation_sessions
      ADD CONSTRAINT derivation_sessions_start_node_id_fkey
      FOREIGN KEY (start_node_id) REFERENCES plot_nodes(id) ON DELETE CASCADE
    `);
  }
}
