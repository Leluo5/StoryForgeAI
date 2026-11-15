import type { ProseMirrorNode } from '@storyforge/contracts';
import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('chapters')
export class ChapterEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'uuid' }) volume_id!: string;
  @Column({ type: 'varchar', length: 200 }) title!: string;
  @Column({ type: 'integer' }) position!: number;
  @Column({ type: 'jsonb' }) document!: ProseMirrorNode;
  @Column({ type: 'integer', default: 0 }) version!: number;
  @Column({ type: 'char', length: 64 }) content_hash!: string;
}
