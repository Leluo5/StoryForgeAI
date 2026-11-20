import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

// M3c-2 剧情节点归属：只存归属关系，不复制剧情内容（标题/正文/坐标仍在 plot_nodes）
// 专属是节点级属性：全部 exclusive 归属者都 archived 时才在读取期隐藏
@Entity('plot_node_character_owners')
export class PlotNodeCharacterOwnerEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'uuid' }) node_id!: string;
  @Column({ type: 'uuid' }) character_id!: string;
  @Column({ type: 'boolean', default: false }) is_exclusive!: boolean;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
}
