import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { AnchorInvalidReason, AnchorStatus } from './character-enums';

// M3c-2 段落级归档锚点：按 (角色, 章节, paragraph_pid) 定位，不存段落全文
// excerpt_hash 仅服务端用于编辑漂移判定，不进入接口返回
@Entity('character_text_anchors')
export class CharacterTextAnchorEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'uuid' }) character_id!: string;
  @Column({ type: 'uuid' }) chapter_id!: string;
  @Column({ type: 'uuid' }) scan_id!: string;
  // 对应正文块节点 attrs.pid（UUID 格式）
  @Column({ type: 'varchar', length: 36 }) paragraph_pid!: string;
  @Column({ type: 'varchar', length: 60 }) matched_name!: string;
  @Column({ type: 'varchar', length: 120 }) excerpt!: string;
  @Column({ type: 'char', length: 64 }) excerpt_hash!: string;
  @Column({ type: 'varchar', length: 16, default: 'active' }) status!: AnchorStatus;
  @Column({ type: 'varchar', length: 24, nullable: true }) invalid_reason!: AnchorInvalidReason | null;
  @Column({ type: 'timestamptz', nullable: true }) dismissed_at!: Date | null;
  @Column({ type: 'uuid', nullable: true }) dismissed_by!: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
