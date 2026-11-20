import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('version_snapshots')
export class VersionSnapshotEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) chapter_id!: string;
  @Column({ type: 'integer' }) version_no!: number;
  @Column({ type: 'jsonb' }) document!: Record<string, unknown>;
  @Column({ type: 'char', length: 64 }) content_hash!: string;
  @Column({ type: 'uuid', nullable: true }) created_by!: string | null;
  @Column({ type: 'varchar', length: 200, nullable: true }) note!: string | null;
  @Column({ type: 'varchar', length: 8 }) change_type!: string;
  @Column({ type: 'uuid', nullable: true }) revision_set_id!: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
}
