import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

// M3c 自动建树草稿（第二阶段）：解析结果先进草稿，预览确认后才提交到正式树
@Entity('plot_generation_drafts')
export class PlotGenerationDraftEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  // outline（大纲文本）/ novel_text（章节文本）
  @Column({ type: 'varchar', length: 16 }) source!: string;
  @Column({ type: 'text' }) input_text!: string;
  // 仅作解析输入，不建立节点-章节关联
  @Column({ type: 'uuid', nullable: true }) input_chapter_id!: string | null;
  // pending/succeeded/failed/committed/discarded
  @Column({ type: 'varchar', length: 16, default: 'pending' }) status!: string;
  @Column({ type: 'jsonb', nullable: true }) payload!: Record<string, unknown> | null;
  @Column({ type: 'jsonb', nullable: true }) error!: Record<string, unknown> | null;
  @Column({ type: 'uuid', nullable: true }) task_id!: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
