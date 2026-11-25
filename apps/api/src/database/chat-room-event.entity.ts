import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * 房间推衍事件（SSE 推送不承载状态，断线重连按 event_seq 游标补取）。
 * event_seq 在事务内按房间 max+1 推进，(room_id, event_seq) 唯一约束兜底
 * （对齐 ai_task_events 模式：event_seq 为 integer，房间级行锁保证同房间串行）。
 */
@Entity('chat_room_events')
@Index(['room_id', 'event_seq'], { unique: true })
export class ChatRoomEventEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ type: 'uuid' }) room_id!: string;
  @Column({ type: 'integer' }) event_seq!: number;
  @Column({ type: 'varchar', length: 16 }) type!: 'step' | 'status' | 'snapshot';
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) payload!: Record<string, unknown>;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
}