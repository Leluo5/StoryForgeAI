import type { MigrationInterface, QueryRunner } from 'typeorm';

export class RevisionBase1760000000000 implements MigrationInterface {
  name = 'RevisionBase1760000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 修订集：一次输入/粘贴/AI 生成/回滚形成的有序改动集合
    await queryRunner.query(`
      CREATE TABLE revision_sets (
        id uuid PRIMARY KEY,
        chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        base_version integer NOT NULL CHECK (base_version >= 0),
        actor_type varchar(16) NOT NULL CHECK (actor_type IN ('author','ai','import','rollback')),
        actor_id uuid,
        operations jsonb NOT NULL,
        status varchar(24) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','partially_resolved','resolved')),
        ai_set boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_revision_sets_chapter ON revision_sets(chapter_id, created_at DESC)');

    // 版本快照：不可变正文快照，同一章节版本号唯一
    await queryRunner.query(`
      CREATE TABLE version_snapshots (
        id uuid PRIMARY KEY,
        chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        version_no integer NOT NULL CHECK (version_no >= 0),
        document jsonb NOT NULL,
        content_hash char(64) NOT NULL,
        created_by uuid,
        note varchar(200),
        change_type varchar(8) NOT NULL CHECK (change_type IN ('manual','auto')),
        revision_set_id uuid REFERENCES revision_sets(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_version_snapshot_chapter_version UNIQUE (chapter_id, version_no)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_version_snapshots_chapter ON version_snapshots(chapter_id, version_no DESC)');

    // 评论线程：划词评论，锚点可失联
    await queryRunner.query(`
      CREATE TABLE comment_threads (
        id uuid PRIMARY KEY,
        chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        anchor jsonb NOT NULL,
        content text NOT NULL,
        author_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        parent_id uuid REFERENCES comment_threads(id) ON DELETE CASCADE,
        status varchar(12) NOT NULL DEFAULT 'open'
          CHECK (status IN ('open','resolved','reopened')),
        anchor_status varchar(12) NOT NULL DEFAULT 'attached'
          CHECK (anchor_status IN ('attached','orphaned')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_comment_threads_chapter ON comment_threads(chapter_id, created_at ASC)');

    // 待办：状态机 open → in_progress → done，另有 cancelled
    await queryRunner.query(`
      CREATE TABLE todos (
        id uuid PRIMARY KEY,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        chapter_id uuid REFERENCES chapters(id) ON DELETE SET NULL,
        comment_id uuid REFERENCES comment_threads(id) ON DELETE SET NULL,
        revision_set_id uuid REFERENCES revision_sets(id) ON DELETE SET NULL,
        title varchar(200) NOT NULL,
        description text,
        assignee_id uuid REFERENCES authors(id) ON DELETE SET NULL,
        status varchar(16) NOT NULL DEFAULT 'open'
          CHECK (status IN ('open','in_progress','done','cancelled')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_todos_work ON todos(work_id, status)');
    await queryRunner.query('CREATE INDEX idx_todos_assignee ON todos(assignee_id, status)');

    // 通知：应用内通知中心，关联对象 jsonb 快照
    await queryRunner.query(`
      CREATE TABLE notifications (
        id uuid PRIMARY KEY,
        recipient_id uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        type varchar(16) NOT NULL CHECK (type IN ('mention','assign','task_result','system')),
        linked_object jsonb,
        content text NOT NULL,
        read_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_notifications_recipient ON notifications(recipient_id, read_at NULLS FIRST, created_at DESC)');

    // 审计：敏感操作留痕，仅追加
    await queryRunner.query(`
      CREATE TABLE audit_logs (
        id uuid PRIMARY KEY,
        actor_id uuid,
        action varchar(80) NOT NULL,
        target_type varchar(40) NOT NULL,
        target_id uuid,
        detail jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query('CREATE INDEX idx_audit_logs_target ON audit_logs(target_type, target_id)');
    await queryRunner.query('CREATE INDEX idx_audit_logs_actor ON audit_logs(actor_id, created_at DESC)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS audit_logs');
    await queryRunner.query('DROP TABLE IF EXISTS notifications');
    await queryRunner.query('DROP TABLE IF EXISTS todos');
    await queryRunner.query('DROP TABLE IF EXISTS comment_threads');
    await queryRunner.query('DROP TABLE IF EXISTS version_snapshots');
    await queryRunner.query('DROP TABLE IF EXISTS revision_sets');
  }
}
