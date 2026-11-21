import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// F11 写回字段行：写回单内的单字段前后值与撤销状态
// UNIQUE(writeback_id, field_key) 保证同一写回单内字段不重复（迁移建立）
// before_value null 表示原为空；after_value 为撤销冲突比对依据
@Entity('role_profile_writeback_fields')
export class RoleProfileWritebackFieldEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  // 所属写回单（FK role_profile_writebacks(id) ON DELETE CASCADE）
  @Column({ type: 'uuid' }) writeback_id!: string;
  // 字段名：identity / personality / experience（CHECK 约束在迁移建立）
  @Column({ type: 'varchar', length: 32 }) field_key!: string;
  // 写回前值，null 表示原为空
  @Column({ type: 'jsonb', nullable: true }) before_value!: unknown | null;
  // 写回后值，撤销冲突比对依据
  @Column({ type: 'jsonb', nullable: true }) after_value!: unknown | null;
  // 字段状态：applied / reverted（CHECK 约束在迁移建立）
  @Column({ type: 'varchar', length: 16 }) status!: string;
  // 撤销时间与执行人
  @Column({ type: 'timestamptz', nullable: true }) reverted_at!: Date | null;
  @Column({ type: 'uuid', nullable: true }) reverted_by!: string | null;
}
