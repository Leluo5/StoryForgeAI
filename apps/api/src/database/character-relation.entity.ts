import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';
import type { RelationLineStyle, RelationOrigin } from './character-enums';

// M3c-2 关系实例：directed 为类型快照，pair_key 用于同对角色去重
// 同一对角色同类型唯一（UNIQUE work_id + pair_key + type_id），不同关系类型可并存
@Entity('character_relations')
export class CharacterRelationEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'uuid' }) source_id!: string;
  @Column({ type: 'uuid' }) target_id!: string;
  @Column({ type: 'uuid' }) type_id!: string;
  @Column({ type: 'boolean' }) directed!: boolean;
  @Column({ type: 'varchar', length: 80 }) pair_key!: string;
  @Column({ type: 'varchar', length: 40 }) label!: string;
  @Column({ type: 'varchar', length: 40, nullable: true }) reverse_label!: string | null;
  @Column({ type: 'varchar', length: 7 }) color!: string;
  @Column({ type: 'varchar', length: 16, default: 'solid' }) line_style!: RelationLineStyle;
  // 冗余文字标签：隐藏颜色时仍可辨认关系
  @Column({ type: 'varchar', length: 40 }) tag!: string;
  @Column({ type: 'varchar', length: 16, default: 'manual' }) origin!: RelationOrigin;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
