import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

// F11 协同配置：一作品一份，唯一允许的测试角色 + 执行 Agent + 白名单字段 + 开关
// PK 即 work_id（一作品一行），FK works(id) ON DELETE CASCADE（T04 迁移建立）
// test_character_id / agent_id 由服务层在同一事务内校验归属（实体层不设关系对象，仅存 id）
@Entity('collab_settings')
export class CollabSettingEntity {
  @PrimaryColumn({ type: 'uuid' }) work_id!: string;
  // 唯一允许的测试角色（FK characters(id) ON DELETE RESTRICT）
  @Column({ type: 'uuid' }) test_character_id!: string;
  // 执行 Agent（FK ai_agents(id) ON DELETE RESTRICT），通道取其 platform
  @Column({ type: 'uuid' }) agent_id!: string;
  // 允许自动写回的字段集合：CHECK 子集 {identity,personality,experience} 且 cardinality 2-3（T04 迁移建立）
  @Column({ type: 'text', array: true, default: () => "ARRAY['identity','personality','experience']" }) whitelist_fields!: string[];
  // 协同开关，默认关闭
  @Column({ type: 'boolean', default: false }) enabled!: boolean;
  @CreateDateColumn({ type: 'timestamptz' }) created_at!: Date;
  @UpdateDateColumn({ type: 'timestamptz' }) updated_at!: Date;
}
