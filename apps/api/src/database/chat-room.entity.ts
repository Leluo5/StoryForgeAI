import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

/**
 * F6 聊天室房间（M4-T2 迁移自旧 story_thread.py 内存注册表 → PG 持久化）。
 * 单作品容量上限 10（DoD #10）；(work_id, room_key) 唯一防并发重复创建。
 */
@Entity('chat_rooms')
@Index(['work_id', 'room_key'], { unique: true })
export class ChatRoomEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Index() @Column({ type: 'uuid' }) work_id!: string;
  /** 客户端幂等键：同作品内唯一 */
  @Column({ type: 'varchar', length: 64 }) room_key!: string;
  @Column({ type: 'varchar', length: 120 }) name!: string;
  /** 参与角色 ID 列表 */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) roles!: string[];
  /** 随机系统种子（同种子 + 同输入 → 确定性结果） */
  @Column({ type: 'integer', nullable: true }) random_seed!: number | null;
  /** 当前步骤（step 一步一断，成功后 +1） */
  @Column({ type: 'integer', default: 0 }) step_index!: number;
  /** 分支选择记录 */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) branch!: Record<string, unknown>[];
  /** 房间独立上下文（plot sync-room push 注入 context_node_ids） */
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) context!: Record<string, unknown>;
  @Column({ type: 'varchar', length: 16, default: 'idle' }) status!: 'idle' | 'running' | 'paused' | 'done' | 'failed';
  /** 已提交推衍步骤（sync-room pull 读取） */
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) history!: Record<string, unknown>[];
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}