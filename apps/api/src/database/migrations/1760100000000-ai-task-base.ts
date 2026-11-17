import type { MigrationInterface, QueryRunner } from 'typeorm';

// M3a AI 创作基座：任务队列 + SSE 进度推送 + AI 待审修订闭环
// ai_tasks：任务状态持久化（DB 是重连/重启恢复依据）
// ai_task_events：事件序号补取（SSE 只推送不承载状态）
export class AiTaskBase1760100000000 implements MigrationInterface {
  name = 'AiTaskBase1760100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // AI 任务：一次 AI 工具调用的完整生命周期
    await queryRunner.query(`
      CREATE TABLE ai_tasks (
        id uuid PRIMARY KEY,
        idempotency_key varchar(128) NOT NULL,
        work_id uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        chapter_id uuid NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        tool varchar(40) NOT NULL,
        agent_id uuid,
        input_summary jsonb NOT NULL,
        base_version integer NOT NULL CHECK (base_version >= 0),
        status varchar(16) NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
        event_seq integer NOT NULL DEFAULT 0,
        result_revision_set_id uuid REFERENCES revision_sets(id) ON DELETE SET NULL,
        error jsonb,
        attempts integer NOT NULL DEFAULT 0,
        created_by uuid NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_ai_tasks_idempotency_key UNIQUE (idempotency_key)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_ai_tasks_work ON ai_tasks(work_id, created_at DESC)');
    await queryRunner.query('CREATE INDEX idx_ai_tasks_status ON ai_tasks(status, updated_at)');

    // AI 任务进度事件：事件序号唯一，SSE 补取不重复
    await queryRunner.query(`
      CREATE TABLE ai_task_events (
        id uuid PRIMARY KEY,
        task_id uuid NOT NULL REFERENCES ai_tasks(id) ON DELETE CASCADE,
        event_seq integer NOT NULL,
        type varchar(24) NOT NULL
          CHECK (type IN ('queued','running','progress','succeeded','failed','cancelled')),
        payload jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_ai_task_events_seq UNIQUE (task_id, event_seq)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_ai_task_events_task ON ai_task_events(task_id, event_seq ASC)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS ai_task_events');
    await queryRunner.query('DROP TABLE IF EXISTS ai_tasks');
  }
}
