import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('revision_sets')
export class RevisionSetEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) chapter_id!: string;
  @Column({ type: 'integer' }) base_version!: number;
  @Column({ type: 'varchar', length: 16 }) actor_type!: string;
  @Column({ type: 'uuid', nullable: true }) actor_id!: string | null;
  @Column({ type: 'jsonb' }) operations!: Array<Record<string, unknown>>;
  @Column({ type: 'varchar', length: 24 }) status!: string;
  @Column({ type: 'boolean', default: false }) ai_set!: boolean;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
}
