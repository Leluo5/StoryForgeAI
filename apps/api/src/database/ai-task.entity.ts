import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

// AI 创作任务：一次 AI 工具调用（如 continue）的完整生命周期
// DB 是重连/重启恢复依据；SSE 只推送不承载状态
@Entity('ai_tasks')
export class AiTaskEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  // 幂等键（同键最多一个有效结果修订集，去重依据）
  @Column({ type: 'varchar', length: 128 }) idempotency_key!: string;
  // 作品级归属；工作流运行任务（scope='workflow_run'）无作品归属，可为空
  @Column({ type: 'uuid', nullable: true }) work_id!: string | null;
  // 章节任务必填；剧情推衍任务（scope='plot'）与工作流运行任务（scope='workflow_run'）为空
  @Column({ type: 'uuid', nullable: true }) chapter_id!: string | null;
  // 任务作用域：chapter（章节正文修订）/ plot（剧情推衍与结构生成）/ character（角色版图）/ role_profile（F11 角色资料生成）/ workflow_run（M4-T7 工作流运行）
  @Column({ type: 'varchar', length: 16, default: 'chapter' }) scope!: 'chapter' | 'plot' | 'character' | 'role_profile' | 'workflow_run';
  // F11 任务实际执行通道：flowise / coze（列由 1760700000000-collab-base 迁移建立，历史任务为 NULL）
  @Column({ type: 'varchar', length: 16, nullable: true }) channel!: string | null;
  // 工具标识（如 continue）
  @Column({ type: 'varchar', length: 40 }) tool!: string;
  // 执行 Agent（M3a 预留，M3b 接入）
  @Column({ type: 'uuid', nullable: true }) agent_id!: string | null;
  // 输入摘要（作品/章节/选区/参数）
  @Column({ type: 'jsonb' }) input_summary!: Record<string, unknown>;
  // 基准章节版本（AI 输出据此做 diff）
  @Column({ type: 'integer' }) base_version!: number;
  // queued → running → succeeded/failed/cancelled
  @Column({ type: 'varchar', length: 16 }) status!: string;
  // 已推送的最大事件序号
  @Column({ type: 'integer', default: 0 }) event_seq!: number;
  // 成功后的结果修订集（M2 载体 actor_type='ai'/ai_set=true）
  @Column({ type: 'uuid', nullable: true }) result_revision_set_id!: string | null;
  // 失败原因（结构化）
  @Column({ type: 'jsonb', nullable: true }) error!: Record<string, unknown> | null;
  // 已尝试次数
  @Column({ type: 'integer', default: 0 }) attempts!: number;
  @Column({ type: 'uuid' }) created_by!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
