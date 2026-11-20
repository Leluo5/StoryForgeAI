import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

// M3c 剧情分组 / 泳道：仅视觉归类，删除时节点解组而非删除
@Entity('plot_groups')
export class PlotGroupEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) tree_id!: string;
  @Column({ type: 'varchar', length: 80 }) name!: string;
  // group（分组框）/ swimlane（泳道）
  @Column({ type: 'varchar', length: 16 }) kind!: string;
  @Column({ type: 'integer', default: 0 }) order_index!: number;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
