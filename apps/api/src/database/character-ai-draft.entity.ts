import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { AiDraftInputScope, AiDraftKind, AiDraftStatus } from './character-enums';

// M3c-2 AI 候选草稿：一个 ai_tasks 任务最多产出一份（UNIQUE task_id）
// 模型原始输出只落 raw_payload，供服务端与审计使用
@Entity('character_ai_drafts')
export class CharacterAiDraftEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'varchar', length: 24 }) kind!: AiDraftKind;
  @Column({ type: 'varchar', length: 16 }) input_scope!: AiDraftInputScope;
  // 仅记录来源，不建业务关联
  @Column({ type: 'uuid', nullable: true }) input_chapter_id!: string | null;
  @Column({ type: 'varchar', length: 16, default: 'pending' }) status!: AiDraftStatus;
  @Column({ type: 'jsonb', nullable: true }) raw_payload!: Record<string, unknown> | null;
  @Column({ type: 'jsonb', nullable: true }) summary!: Record<string, unknown> | null;
  @Column({ type: 'jsonb', nullable: true }) error!: Record<string, unknown> | null;
  @Column({ type: 'uuid', nullable: true }) task_id!: string | null;
  @Column({ type: 'varchar', length: 128 }) idempotency_key!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
