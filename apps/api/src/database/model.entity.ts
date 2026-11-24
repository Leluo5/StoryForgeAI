import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

// 作者级 AI 模型选型目录：作者可维护自己的可用模型注册表，
// 供 Agent（model_id）与工作流（llm_config.model）选型引用。
// 静态注册表资源，两态（active/disabled）+ 直接硬删，非版本化。
@Entity('ai_models')
export class ModelEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  // 归属作者（外键 ON DELETE CASCADE）
  @Column({ type: 'uuid' }) author_id!: string;
  // 展示名
  @Column({ type: 'varchar', length: 80 }) name!: string;
  // 厂商
  @Column({ type: 'varchar', length: 24, default: 'other' }) provider!: string;
  // 能力标识（如 gpt-4o-mini），UNIQUE(author_id, model_id)
  @Column({ type: 'varchar', length: 80 }) model_id!: string;
  // 上下文窗口（tokens）
  @Column({ type: 'int', default: 0 }) context_window!: number;
  // 是否支持工具调用
  @Column({ type: 'boolean', default: false }) supports_tools!: boolean;
  // 是否支持视觉输入
  @Column({ type: 'boolean', default: false }) supports_vision!: boolean;
  // 输入价格（元/1K tokens）
  @Column({ type: 'numeric', precision: 12, scale: 4, default: 0 }) input_price!: string;
  // 输出价格（元/1K tokens）
  @Column({ type: 'numeric', precision: 12, scale: 4, default: 0 }) output_price!: string;
  // 货币代码
  @Column({ type: 'varchar', length: 8, default: 'USD' }) currency!: string;
  // 状态：active/disabled
  @Column({ type: 'varchar', length: 16, default: 'active' }) status!: string;
  // 排序权重（升序，小的在前）
  @Column({ type: 'int', default: 0 }) sort_order!: number;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
