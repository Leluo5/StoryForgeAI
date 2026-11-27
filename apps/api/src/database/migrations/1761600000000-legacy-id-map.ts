import type { MigrationInterface, QueryRunner } from 'typeorm';

// M4-T11 旧数据迁移：新增 legacy_id_map 表（旧实体 ID → 新 PG UUID 映射）。
// 结构迁移与数据迁移分离：本表仅支撑数据迁移脚本，不参与业务读写。
// 唯一索引 (domain, legacy_id) 保证幂等：同一旧实体重复迁移只落一行。
export class LegacyIdMap1761600000000 implements MigrationInterface {
  name = 'LegacyIdMap1761600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "legacy_id_map" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "domain" character varying(32) NOT NULL,
        "legacy_id" character varying(255) NOT NULL,
        "new_id" uuid NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "pk_legacy_id_map" PRIMARY KEY ("id"),
        CONSTRAINT "uq_legacy_id_map_domain_legacy" UNIQUE ("domain", "legacy_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "idx_legacy_id_map_new_id" ON "legacy_id_map" ("new_id")`
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "legacy_id_map"`);
  }
}
