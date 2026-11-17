import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('audit_logs')
export class AuditLogEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid', nullable: true }) actor_id!: string | null;
  @Column({ type: 'varchar', length: 80 }) action!: string;
  @Column({ type: 'varchar', length: 40 }) target_type!: string;
  @Column({ type: 'uuid', nullable: true }) target_id!: string | null;
  @Column({ type: 'jsonb' }) detail!: Record<string, unknown>;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
}
