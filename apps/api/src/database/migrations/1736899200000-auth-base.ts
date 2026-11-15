import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AuthBase1736899200000 implements MigrationInterface {
  name = 'AuthBase1736899200000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS citext');
    await queryRunner.query(`
      CREATE TABLE authors (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email citext NOT NULL,
        display_name varchar(80) NOT NULL,
        password_hash text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_authors_email UNIQUE (email)
      )
    `);
    await queryRunner.query(`
      CREATE TABLE sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        author_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        token_hash char(64) NOT NULL,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_sessions_token_hash UNIQUE (token_hash)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_sessions_author ON sessions(author_id)');
    await queryRunner.query('CREATE INDEX idx_sessions_expiry ON sessions(expires_at) WHERE revoked_at IS NULL');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS sessions');
    await queryRunner.query('DROP TABLE IF EXISTS authors');
  }
}
