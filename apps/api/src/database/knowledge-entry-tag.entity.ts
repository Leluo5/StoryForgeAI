import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

// M3c-3 知识库 · 条目-标签关联表
// 复合主键 (entry_id, tag_id)；删除任一侧级联删除关联
// 结构来源：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §2.2.4
@Entity('knowledge_entry_tags')
export class KnowledgeEntryTagEntity {
  @PrimaryColumn({ type: 'uuid' })
  entry_id!: string;

  @PrimaryColumn({ type: 'uuid' })
  tag_id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
