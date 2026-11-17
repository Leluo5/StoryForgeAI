import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('todos')
export class TodoEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'uuid', nullable: true }) chapter_id!: string | null;
  @Column({ type: 'uuid', nullable: true }) comment_id!: string | null;
  @Column({ type: 'uuid', nullable: true }) revision_set_id!: string | null;
  @Column({ type: 'varchar', length: 200 }) title!: string;
  @Column({ type: 'text', nullable: true }) description!: string | null;
  @Column({ type: 'uuid', nullable: true }) assignee_id!: string | null;
  @Column({ type: 'varchar', length: 16 }) status!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
