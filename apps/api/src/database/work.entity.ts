import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

@Entity('works')
export class WorkEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) author_id!: string;
  @Column({ type: 'varchar', length: 120 }) title!: string;
  @Column({ type: 'text', default: '' }) description!: string;
  @Column({ type: 'varchar', length: 16, default: 'active' }) status!: 'active' | 'archived';
  @Column({ type: 'boolean', default: true }) is_public!: boolean;
  @Column({ type: 'varchar', length: 64, default: '' }) access_code!: string;
  // ── F3 在线体验（Coze 绑定字段，旧 work_manager 公开字段子集）──
  @Column({ type: 'varchar', nullable: true }) coze_bot_id!: string | null;
  @Column({ type: 'text', nullable: true }) pat_token!: string | null;
  @Column({ type: 'varchar', length: 32, default: 'chat' }) interaction_type!: string;
  @Column({ type: 'text', nullable: true }) system_prompt!: string | null;
  @Column({ type: 'text', nullable: true }) prologue!: string | null;
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) suggested_questions!: unknown[];
  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" }) parameters!: unknown[];
  @Column({ type: 'varchar', nullable: true }) model_name!: string | null;
  @Column({ type: 'varchar', nullable: true }) response_format!: string | null;
  @Column({ type: 'varchar', nullable: true }) icon_url!: string | null;
  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" }) coze_meta!: Record<string, unknown>;
  @Column({ type: 'uuid', nullable: true }) project_id!: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
