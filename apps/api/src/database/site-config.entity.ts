import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, UpdateDateColumn } from 'typeorm';

// 作者级站点设置：每个作者一条（author_id 唯一），配置自己的站点信息、LLM 配置与平台凭据。
// 用户明确选择「完整入库含 api_key/pat」——打破「敏感凭据禁止入库」约束，对齐旧架构完整功能，风险由用户权衡接受。
// F4 作者级站点设置：作者登录即可访问自己的后台，无独立认证。
@Entity('site_config')
export class SiteConfigEntity {
  @PrimaryGeneratedColumn('uuid') id!: string;
  // 归属作者（外键 ON DELETE CASCADE），每作者唯一一条
  @Index({ unique: true })
  @Column({ type: 'uuid' }) author_id!: string;
  // 站点名称
  @Column({ type: 'varchar', length: 120, default: '我的创作站' }) site_name!: string;
  // 站点描述
  @Column({ type: 'text', default: '' }) site_description!: string;
  // 主题：light/dark
  @Column({ type: 'varchar', length: 16, default: 'light' }) theme!: string;
  // LLM 配置（完整含 base_url/api_key/model，用户选择完整入库）
  @Column({ type: 'jsonb', default: () => "'{}'" }) llm_config!: Record<string, unknown>;
  // 平台凭据（coze/flowise/fastgpt/n8n 的部署信息与令牌，作者级，消费方优先读取）
  @Column({ type: 'jsonb', default: () => "'{}'" }) platform_credentials!: Record<string, unknown>;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
