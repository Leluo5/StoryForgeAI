import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

// M3c 剧情关联：linear（必须先发生，DAG）/ non_linear（无先后）
// 父子层级由 plot_nodes.parent_id 表达，不重复写入本表
@Entity('plot_links')
export class PlotLinkEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) tree_id!: string;
  @Column({ type: 'uuid' }) source_id!: string;
  @Column({ type: 'uuid' }) target_id!: string;
  @Column({ type: 'varchar', length: 16 }) type!: 'linear' | 'non_linear';
  @Column({ type: 'varchar', length: 255, nullable: true }) label!: string | null;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
}
