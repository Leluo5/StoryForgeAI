import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

// AI 创作工具注册表：服务端权威的工具清单，工具可绑定执行 Agent、可启停
// 前端从 API 拉取工具清单（M3a 硬编码 4 工具由本表替代）
@Entity('ai_tools')
export class AiToolEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  // 工具标识（如 continue 续写），UNIQUE(tool_id) 服务端权威
  @Column({ type: 'varchar', length: 40 }) tool_id!: string;
  // 工具展示名
  @Column({ type: 'varchar', length: 80 }) name!: string;
  // 工具说明（可选）
  @Column({ type: 'varchar', length: 255, nullable: true }) description!: string | null;
  // 当前绑定执行 Agent（外键 ON DELETE SET NULL）
  @Column({ type: 'uuid', nullable: true }) agent_id!: string | null;
  // 是否启用（停用后新任务 409，进行中任务不受影响）
  @Column({ type: 'boolean', default: true }) enabled!: boolean;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
