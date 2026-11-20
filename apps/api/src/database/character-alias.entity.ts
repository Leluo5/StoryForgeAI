import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

// M3c-2 角色别名：同一角色别名不重复，按作品 + alias_key 检索疑似重复
@Entity('character_aliases')
export class CharacterAliasEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'uuid' }) character_id!: string;
  @Column({ type: 'varchar', length: 60 }) alias!: string;
  @Column({ type: 'varchar', length: 60 }) alias_key!: string;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
}
