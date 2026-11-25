import type { MigrationInterface, QueryRunner } from 'typeorm';

// M4-T2：F6 聊天室房间模型（旧 story_thread.py 内存注册表 → PG 持久化）。
// 房间表 chat_rooms：(work_id, room_key) 唯一防并发重复创建；容量上限在 service 事务内 COUNT 校验。
// 事件表 chat_room_events：event_seq 在房间行锁事务内 max+1 推进，(room_id, event_seq) 唯一约束兜底，SSE 断线按游标补取。
export class ChatRoom1761200000000 implements MigrationInterface {
  name = 'ChatRoom1761200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE chat_rooms (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        work_id uuid NOT NULL,
        room_key varchar(64) NOT NULL,
        name varchar(120) NOT NULL,
        roles jsonb NOT NULL DEFAULT '[]',
        random_seed integer,
        step_index integer NOT NULL DEFAULT 0,
        branch jsonb NOT NULL DEFAULT '[]',
        context jsonb NOT NULL DEFAULT '{}',
        status varchar(16) NOT NULL DEFAULT 'idle',
        history jsonb NOT NULL DEFAULT '[]',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_chat_rooms_work_room_key UNIQUE (work_id, room_key)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_chat_rooms_work_id ON chat_rooms(work_id)');
    await queryRunner.query('CREATE INDEX idx_chat_rooms_work_status ON chat_rooms(work_id, status)');

    await queryRunner.query(`
      CREATE TABLE chat_room_events (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        room_id uuid NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
        event_seq integer NOT NULL,
        type varchar(16) NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT uq_chat_room_events_room_seq UNIQUE (room_id, event_seq)
      )
    `);
    await queryRunner.query('CREATE INDEX idx_chat_room_events_room_seq ON chat_room_events(room_id, event_seq ASC)');
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS chat_room_events');
    await queryRunner.query('DROP TABLE IF EXISTS chat_rooms');
  }
}