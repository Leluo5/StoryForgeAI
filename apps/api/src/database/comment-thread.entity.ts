import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('comment_threads')
export class CommentThreadEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) chapter_id!: string;
  @Column({ type: 'jsonb' }) anchor!: Record<string, unknown>;
  @Column({ type: 'text' }) content!: string;
  @Column({ type: 'uuid' }) author_id!: string;
  @Column({ type: 'uuid', nullable: true }) parent_id!: string | null;
  @Column({ type: 'varchar', length: 12 }) status!: string;
  @Column({ type: 'varchar', length: 12 }) anchor_status!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
