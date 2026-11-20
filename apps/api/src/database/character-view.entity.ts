import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

// M3c-2 自定义视图：只保存筛选与布局，不复制角色资料
// 每作品仅一张默认视图（部分唯一索引，迁移中建立）
@Entity('character_views')
export class CharacterViewEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'varchar', length: 60 }) name!: string;
  @Column({ type: 'boolean', default: false }) is_default!: boolean;
  // 六维筛选 + 关键词，受控结构由契约 strict 校验
  @Column({ type: 'jsonb', default: () => "'{}'" }) filters!: Record<string, unknown>;
  // 视图设置乐观锁；拖拽布局不推进
  @Column({ type: 'integer', default: 1 }) version!: number;
  @Column({ type: 'integer', default: 0 }) sort_order!: number;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
