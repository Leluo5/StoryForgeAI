import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import type { AiItemKind, AiItemStatus, DuplicateResolution } from './character-enums';

// M3c-2 AI 候选条目：可逐条确认，payload 按 kind 使用受控结构
// 确认 / 拒绝幂等重放依赖 status + resolved_entity_id，不额外建幂等表
@Entity('character_ai_candidate_items')
export class CharacterAiCandidateItemEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) draft_id!: string;
  @Column({ type: 'integer' }) item_index!: number;
  @Column({ type: 'varchar', length: 16 }) kind!: AiItemKind;
  @Column({ type: 'jsonb' }) payload!: Record<string, unknown>;
  // 依赖的其他 item_index
  @Column({ type: 'jsonb', default: () => "'[]'" }) dependencies!: number[];
  // [{character_id,name,matched_on}]
  @Column({ type: 'jsonb', default: () => "'[]'" }) suspected_duplicates!: Array<Record<string, unknown>>;
  @Column({ type: 'varchar', length: 16, default: 'pending' }) status!: AiItemStatus;
  @Column({ type: 'varchar', length: 16, nullable: true }) resolution!: DuplicateResolution | null;
  @Column({ type: 'uuid', nullable: true }) resolved_entity_id!: string | null;
  @Column({ type: 'timestamptz', nullable: true }) resolved_at!: Date | null;
}
