import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

// M3c 剧情树：一个作品一棵主树，version 为结构乐观锁
@Entity('plot_trees')
export class PlotTreeEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  // 所属作品（UNIQUE(work_id)，一作品一树）
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'varchar', length: 120 }) title!: string;
  // 来源：manual/outline/novel_text/import
  @Column({ type: 'varchar', length: 16, default: 'manual' }) source!: string;
  // 导入导出结构版本号
  @Column({ type: 'integer', default: 1 }) schema_version!: number;
  // 结构乐观锁：结构写入 +1，坐标更新不推进
  @Column({ type: 'integer', default: 1 }) version!: number;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
