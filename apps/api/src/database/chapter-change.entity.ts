import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('chapter_changes')
export class ChapterChangeEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) chapter_id!: string;
  @Column({ type: 'uuid' }) author_id!: string;
  @Column({ type: 'uuid', unique: true }) change_id!: string;
  @Column({ type: 'uuid' }) client_id!: string;
  @Column({ type: 'integer' }) sequence!: number;
  @Column({ type: 'integer' }) base_version!: number;
  @Column({ type: 'integer' }) server_version!: number;
  @Column({ type: 'jsonb' }) operations!: Array<Record<string, unknown>>;
  @Column({ type: 'char', length: 64 }) content_hash!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
}
