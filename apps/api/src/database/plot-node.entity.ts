import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

// M3c 剧情节点：parent_id 表达主线父子层级（自引用级联删子树）
// position 独立维护，拖拽只更新坐标不推进树结构版本
@Entity('plot_nodes')
export class PlotNodeEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) tree_id!: string;
  // 父节点（空为根节点）
  @Column({ type: 'uuid', nullable: true }) parent_id!: string | null;
  @Column({ type: 'integer', default: 0 }) sibling_order!: number;
  @Column({ type: 'varchar', length: 120 }) title!: string;
  @Column({ type: 'varchar', length: 255, nullable: true }) summary!: string | null;
  @Column({ type: 'text', default: '' }) content!: string;
  // 受控属性：time_point/place/status（Zod strict 校验）
  @Column({ type: 'jsonb', default: {} }) attributes!: Record<string, unknown>;
  @Column({ type: 'integer', default: 0 }) position_x!: number;
  @Column({ type: 'integer', default: 0 }) position_y!: number;
  // 所属分组/泳道（删除分组时 SET NULL）
  @Column({ type: 'uuid', nullable: true }) group_id!: string | null;
  // 来源：manual/derivation/outline/novel_text/import
  @Column({ type: 'varchar', length: 16, default: 'manual' }) origin!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
