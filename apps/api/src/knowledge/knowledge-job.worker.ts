// M3c-3 知识库 · 作业 Worker（F2 §1.4、§5.3）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §1.4、§5.3
//
// 职责：消费 knowledge-jobs 队列，按 kind 分派 7 类作业：
//   structure / outline → KnowledgeStructureHandler（结构化管线）
//   export_markdown / import_markdown → 导入导出（T25，由 KnowledgePortabilityService 接入）
//   export_backup / restore_backup → 备份恢复（T26，由 KnowledgeBackupService 接入）
//   ingest → 上传编排（由 KnowledgeIngestService 接入）
//
// 范式对齐 ai-task.processor.createWorker（main.ts 启动；测试可直接调用）。
// 分派说明（T27 收官）：
//   structure / outline → KnowledgeStructureHandler（结构化管线，内部落终态）
//   ingest → 上传编排（条目已由 KnowledgeIngestService 创建，此处仅确认）
//   export_markdown / import_markdown / export_backup / restore_backup
//     → 导入导出（T25）/ 备份恢复（T26）：这些作业由对应 service **同步创建并立即终态**
//       （succeeded，或 queued 仅作 preview 暂存、不经队列投递），worker 实际收不到它们。
//       若防御性收到 queued 的此类作业，直接确认成功（不重复执行，避免重复写库）。
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import { DataSource } from 'typeorm';
import { env } from '../config/env';
import { KNOWLEDGE_JOBS_QUEUE_NAME } from './jobs.queue';
import { KnowledgeJobService, type JobError } from './jobs.processor';
import { KnowledgeStructureHandler } from './knowledge-structure.handler';
import { KnowledgePortabilityService } from './knowledge-portability.service';
import { KnowledgeBackupService } from './knowledge-backup.service';
import { KnowledgeEntryEntity } from '../database/knowledge-entry.entity';
import type { KnowledgeScope, KnowledgeEntryType } from '@storyforge/contracts';

interface StructureJobInput {
  entry_id?: string;
  source?: string;
  file_name?: string;
}

@Injectable()
export class KnowledgeJobWorker {
  private readonly logger = new Logger(KnowledgeJobWorker.name);

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    private readonly jobService: KnowledgeJobService,
    private readonly structureHandler: KnowledgeStructureHandler,
    private readonly portabilityService: KnowledgePortabilityService,
    private readonly backupService: KnowledgeBackupService
  ) {}

  /** 创建消费该队列的 BullMQ Worker（main.ts 启动） */
  createWorker(): Worker {
    const worker = new Worker(
      KNOWLEDGE_JOBS_QUEUE_NAME,
      (job) => this.process(job),
      {
        connection: { url: this.redisUrl(), maxRetriesPerRequest: null },
        concurrency: 4
      }
    );
    worker.on('error', (err) => this.logger.error(`Worker error: ${err.message}`));
    return worker;
  }

  /** BullMQ processor 回调 */
  async process(job: Job<{ jobId: string }>): Promise<void> {
    const jobId = job.data.jobId;
    try {
      const entity = await this.jobService.getJob(jobId);
      // 非 queued（已取消/完成）跳过
      if (entity.status !== 'queued') return;

      await this.jobService.startRunning(jobId);

      switch (entity.kind) {
        case 'structure':
        case 'outline':
          await this.handleStructure(jobId, { ...entity, library_scope: entity.library_scope as KnowledgeScope });
          break;
        case 'ingest':
          await this.handleIngest(jobId, entity);
          break;
        case 'export_markdown':
        case 'import_markdown':
        case 'export_backup':
        case 'restore_backup':
          // 导入导出（T25）/ 备份恢复（T26）：作业由对应 service 同步创建并立即终态
          // （succeeded，或 queued 仅作 preview 暂存、不经队列投递），worker 实际收不到它们。
          // 若防御性收到 queued 的此类作业，确认成功即可（不重复执行，避免重复写库）。
          await this.handlePortability(jobId, entity.kind, entity);
          break;
        default:
          await this.jobService.markFailed(jobId, {
            code: 'KNOWLEDGE_JOB_UNKNOWN_KIND',
            message: `未知作业类型：${entity.kind}`
          });
      }
    } catch (err) {
      const error = this.toError(err);
      await this.jobService.markFailed(jobId, error).catch(() => undefined);
    }
  }

  // ───────────────────────────── 结构化 ─────────────────────────────

  private async handleStructure(
    jobId: string,
    entity: { id: string; entry_id: string | null; input: Record<string, unknown>; owner_id: string; library_scope: KnowledgeScope; work_id: string | null }
  ): Promise<void> {
    const input = entity.input as StructureJobInput;
    const entryId = input.entry_id ?? entity.entry_id;
    if (!entryId) {
      await this.jobService.markFailed(jobId, { code: 'KNOWLEDGE_ENTRY_NOT_FOUND', message: '作业缺少 entry_id' });
      return;
    }
    const entry = await this.dataSource.getRepository(KnowledgeEntryEntity).findOneBy({ id: entryId });
    if (!entry || entry.deleted_at) {
      await this.jobService.markFailed(jobId, { code: 'KNOWLEDGE_ENTRY_NOT_FOUND', message: '知识条目不存在' });
      return;
    }
    // 结构化管线（内部 finishSucceeded / markFailed）
    await this.structureHandler.handle(jobId, {
      entryId: entry.id,
      rawContent: entry.original_text,
      entryType: entry.entry_type as KnowledgeEntryType,
      title: entry.title,
      scope: entry.library_scope as KnowledgeScope,
      workId: entry.work_id,
      ownerId: entry.owner_id
    });
  }

  // ───────────────────────────── 上传（ingest） ─────────────────────────────

  private async handleIngest(
    jobId: string,
    entity: { id: string; entry_id: string | null; input: Record<string, unknown>; owner_id: string }
  ): Promise<void> {
    // 上传作业：条目已由 KnowledgeIngestService 创建，此处仅回传成功（实际结构化由 structure 作业完成）
    const input = entity.input as StructureJobInput;
    await this.jobService.finishSucceeded(jobId, {
      entry_id: input.entry_id ?? entity.entry_id,
      source: input.source ?? 'ingest'
    });
  }

  // ───────────────────────────── 导入导出 / 备份恢复（同步终态） ─────────────────────────────

  private async handlePortability(
    jobId: string,
    kind: string,
    entity: { id: string; entry_id: string | null; input: Record<string, unknown>; owner_id: string }
  ): Promise<void> {
    // 这四类作业（export_markdown/import_markdown/export_backup/restore_backup）由对应 service
    // **同步创建并立即终态**（succeeded，或 queued 仅作 preview 暂存、不经队列投递），因此 worker
    // 实际不会收到它们。此处为防御性接入：若意外收到 queued 的此类作业，直接确认成功——
    // 不调用 service 的同步方法（会重新创建作业造成重复写库）。
    // 保留 portabilityService / backupService 注入以备未来改为异步执行时接入。
    const input = entity.input as StructureJobInput;
    await this.jobService.finishSucceeded(jobId, {
      kind,
      entry_id: input.entry_id ?? entity.entry_id,
      source: input.source ?? 'portability'
    });
  }

  private redisUrl(): string {
    return env.REDIS_URL;
  }

  private toError(err: unknown): JobError {
    if (err instanceof Error) return { code: 'KNOWLEDGE_JOB_PROCESS_FAILED', message: err.message };
    return { code: 'KNOWLEDGE_JOB_PROCESS_FAILED', message: '作业处理失败' };
  }
}
