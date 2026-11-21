import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

// F11 写回单：一次角色资料生成任务对应的写回记录（一任务最多一次写回）
// task_id UNIQUE，FK ai_tasks(id) ON DELETE CASCADE（T04 迁移建立）
// 撤销按字段执行，写回单 status 由字段行状态汇总得出
@Entity('role_profile_writebacks')
@Index('idx_role_profile_writebacks_character', ['work_id', 'character_id', 'applied_at'])
export class RoleProfileWritebackEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  // 一任务最多一次写回（UNIQUE 约束在迁移建立）
  @Column({ type: 'uuid', unique: true }) task_id!: string;
  // 归属与写回对象（FK works/characters(id) ON DELETE CASCADE）
  @Column({ type: 'uuid' }) work_id!: string;
  @Column({ type: 'uuid' }) character_id!: string;
  // 实际执行通道：flowise / coze（CHECK 约束在迁移建立）
  @Column({ type: 'varchar', length: 16 }) channel!: string;
  // 写回整体状态：applied / partially_reverted / reverted（CHECK 约束在迁移建立）
  @Column({ type: 'varchar', length: 24 }) status!: string;
  // 写回后角色 version（撤销冲突校验基准）
  @Column({ type: 'integer' }) applied_version!: number;
  // 执行人与时间
  @Column({ type: 'uuid' }) applied_by!: string;
  @CreateDateColumn({ type: 'timestamptz' }) applied_at!: Date;
}
