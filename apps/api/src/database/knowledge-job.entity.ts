import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn
} from 'typeorm';

// M3c-3 知识库 · 知识库作业表
// 解析、结构化、大纲、导入、导出、备份恢复均为作业；写操作可幂等重试
// 结构来源：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §2.2.7
@Entity('knowledge_jobs')
export class KnowledgeJobEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  owner_id!: string;

  // global / work
  @Column({ type: 'varchar', length: 8 })
  library_scope!: string;

  @Column({ type: 'uuid', nullable: true })
  work_id!: string | null;

  // FK ON DELETE SET NULL
  @Column({ type: 'uuid', nullable: true })
  entry_id!: string | null;

  // ingest / structure / outline / export_markdown / export_backup / import_markdown / restore_backup
  @Column({ type: 'varchar', length: 24 })
  kind!: string;

  // queued / running / succeeded / failed / cancelled
  @Column({ type: 'varchar', length: 16, default: 'queued' })
  status!: string;

  // 阶段、已处理/总数、百分比
  @Column({ type: 'jsonb', default: () => "'{}'" })
  progress!: Record<string, unknown>;

  // 不含原文全文；大文本与文件走 staging
  @Column({ type: 'jsonb', default: () => "'{}'" })
  input!: Record<string, unknown>;

  // 统计、冲突、产物元数据
  @Column({ type: 'jsonb', default: () => "'{}'" })
  result!: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  error!: Record<string, unknown> | null;

  // 上传文件或导入包的临时路径
  @Column({ type: 'varchar', length: 255, nullable: true })
  staging_path!: string | null;

  // 导出产物路径
  @Column({ type: 'varchar', length: 255, nullable: true })
  artifact_path!: string | null;

  @Column({ type: 'integer', nullable: true })
  artifact_size!: number | null;

  @Column({ type: 'char', length: 64, nullable: true })
  artifact_hash!: string | null;

  @Column({ type: 'varchar', length: 128, nullable: true })
  idempotency_key!: string | null;

  @Column({ type: 'integer', default: 0 })
  event_seq!: number;

  @Column({ type: 'uuid' })
  created_by!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  started_at!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  finished_at!: Date | null;
}
