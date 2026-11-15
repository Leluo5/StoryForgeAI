import type { MigrationInterface, QueryRunner } from 'typeorm';

export class WritingBase1736985600000 implements MigrationInterface {
  name = 'WritingBase1736985600000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE works (
        id uuid PRIMARY KEY,
        author_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        title varchar(120) NOT NULL,
        description text NOT NULL DEFAULT '',
        status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_works_author_status ON works(author_id, status)');
    await queryRunner.query(`
      CREATE TABLE volumes (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        title varchar(120) NOT NULL,
        position integer NOT NULL CHECK (position >= 0)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_volumes_work_position ON volumes(work_id, position)');
    await queryRunner.query(`
      CREATE TABLE chapters (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        volume_id uuid NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
        title varchar(200) NOT NULL,
        position integer NOT NULL CHECK (position >= 0),
        document jsonb NOT NULL,
        version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
        content_hash char(64) NOT NULL
      )
    `);
    await queryRunner.query('CREATE INDEX idx_chapters_volume_position ON chapters(volume_id, position)');
    await queryRunner.query('CREATE INDEX idx_chapters_work ON chapters(work_id)');
    await queryRunner.query(`
      CREATE TABLE chapter_changes (
        id uuid PRIMARY KEY,
        chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        author_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        change_id uuid NOT NULL,
        client_id uuid NOT NULL,
        sequence integer NOT NULL CHECK (sequence > 0),
        base_version integer NOT NULL CHECK (base_version >= 0),
        server_version integer NOT NULL CHECK (server_version > 0),
        operations jsonb NOT NULL,
        content_hash char(64) NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_chapter_change_id UNIQUE (change_id),
        CONSTRAINT uq_chapter_client_sequence UNIQUE (chapter_id, client_id, sequence)
      )
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS chapter_changes');
    await queryRunner.query('DROP TABLE IF EXISTS chapters');
    await queryRunner.query('DROP TABLE IF EXISTS volumes');
    await queryRunner.query('DROP TABLE IF EXISTS works');
  }
}
