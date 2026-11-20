import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
  ANCHOR_INVALID_REASONS,
  ANCHOR_STATUSES,
  ARCHIVE_SCAN_STATUSES,
  sqlStringList
} from '../character-enums';

// M3c-2 归档扫描 + 段落级锚点：先建扫描作业表（锚点 FK 指向扫描），再建锚点表
// 设计见 F2 §2.2.12、§2.2.13
export class CharacterAnchors1760500003000 implements MigrationInterface {
  name = 'CharacterAnchors1760500003000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 扫描作业：同角色同时只允许一次 pending/running（保证归档幂等）
    await queryRunner.query(`
      CREATE TABLE character_archive_scans (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        requested_by uuid NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'pending'
          CHECK (status IN (${sqlStringList(ARCHIVE_SCAN_STATUSES)})),
        total_chapters integer NOT NULL DEFAULT 0 CHECK (total_chapters >= 0),
        scanned_chapters integer NOT NULL DEFAULT 0 CHECK (scanned_chapters >= 0),
        matched_paragraphs integer NOT NULL DEFAULT 0 CHECK (matched_paragraphs >= 0),
        error jsonb,
        started_at timestamptz,
        finished_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_character_archive_scans_running
        ON character_archive_scans(character_id)
        WHERE status IN ('pending', 'running')
    `);
    await queryRunner.query(
      'CREATE INDEX idx_character_archive_scans_work ON character_archive_scans(work_id, created_at DESC)'
    );

    // 段落锚点：同角色同章同段落唯一；不存段落全文，excerpt 截断 120 字
    await queryRunner.query(`
      CREATE TABLE character_text_anchors (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        scan_id uuid NOT NULL REFERENCES character_archive_scans(id) ON DELETE CASCADE,
        paragraph_pid varchar(36) NOT NULL,
        matched_name varchar(60) NOT NULL,
        excerpt varchar(120) NOT NULL,
        excerpt_hash char(64) NOT NULL,
        status varchar(16) NOT NULL DEFAULT 'active'
          CHECK (status IN (${sqlStringList(ANCHOR_STATUSES)})),
        invalid_reason varchar(24)
          CHECK (invalid_reason IN (${sqlStringList(ANCHOR_INVALID_REASONS)})),
        dismissed_at timestamptz,
        dismissed_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_character_anchors_paragraph UNIQUE (work_id, character_id, chapter_id, paragraph_pid)
      )
    `);
    await queryRunner.query(
      'CREATE INDEX idx_character_anchors_chapter ON character_text_anchors(work_id, chapter_id, status)'
    );
    await queryRunner.query(
      'CREATE INDEX idx_character_anchors_character ON character_text_anchors(work_id, character_id, status)'
    );
    await queryRunner.query('CREATE INDEX idx_character_anchors_scan ON character_text_anchors(scan_id)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS character_text_anchors');
    await queryRunner.query('DROP TABLE IF EXISTS character_archive_scans');
  }
}
