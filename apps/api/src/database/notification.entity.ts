import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('notifications')
export class NotificationEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) recipient_id!: string;
  @Column({ type: 'varchar', length: 16 }) type!: string;
  @Column({ type: 'jsonb', nullable: true }) linked_object!: Record<string, unknown> | null;
  @Column({ type: 'text' }) content!: string;
  @Column({ type: 'timestamptz', nullable: true }) read_at!: Date | null;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
}
