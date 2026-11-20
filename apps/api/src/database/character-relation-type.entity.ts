import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

// M3c-2 关系类型：作品内 5 组 23 类默认种子，可改名/停用，code 稳定
// directed 定义方向能力；无方向类型不允许反向称谓（DB CHECK）
@Entity('character_relation_types')
export class CharacterRelationTypeEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'varchar', length: 40 }) code!: string;
  @Column({ type: 'varchar', length: 40 }) label!: string;
  @Column({ type: 'varchar', length: 40 }) group_key!: string;
  @Column({ type: 'varchar', length: 40 }) group_label!: string;
  @Column({ type: 'boolean', default: true }) directed!: boolean;
  @Column({ type: 'varchar', length: 40, nullable: true }) reverse_label!: string | null;
  @Column({ type: 'boolean', default: false }) is_builtin!: boolean;
  @Column({ type: 'integer', default: 0 }) sort_order!: number;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
