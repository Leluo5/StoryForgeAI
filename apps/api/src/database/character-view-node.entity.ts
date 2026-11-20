import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

// M3c-2 视图成员与布局：显式成员保证「本视图布局」稳定，新增角色不自动挤入
// x / y 为空表示尚未手动排布，由前端确定性布局补位
@Entity('character_view_nodes')
export class CharacterViewNodeEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) view_id!: string;
  @Column({ type: 'uuid' }) character_id!: string;
  @Column({ type: 'integer', nullable: true }) x!: number | null;
  @Column({ type: 'integer', nullable: true }) y!: number | null;
  @Column({ type: 'boolean', default: false }) arranged!: boolean;
  // 列表等价路径排序
  @Column({ type: 'integer', default: 0 }) sort_index!: number;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
