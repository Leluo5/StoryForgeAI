import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Job, Worker, UnrecoverableError } from 'bullmq';
import { env } from '../config/env';
import { AuditService } from '../revision/audit.service';
import { AgentArchiveOutboxEntity } from '../database/agent-archive-outbox.entity';
import { CollabArchiveService } from './collab-archive.service';
import { CollabUpstreamError } from './channel/collab-upstream.error';
import { COLLAB_ARCHIVE_QUEUE_NAME } from './collab-archive.queue';

/**
 * F11 归档投递消费处理器（T17）。
 * - 独立 Worker 消费 collab-archive 队列，与 AI 主链路隔离
 * - 每次投递：delivered 幂等返回；失败按指数退避重试
 * - 超限（attempts >= COLLAB_ARCHIVE_MAX_ATTEMPTS）或不可重试 → 置 failed + 审计，抛 UnrecoverableError 终止重试
 * - 重复重试返回当前状态，不新增记录（jobId=task_id 幂等 + outbox task_id UNIQUE 双保险）
 */
@Injectable()
export class CollabArchiveProcessor {
  private readonly logger = new Logger(CollabArchiveProcessor.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(CollabArchiveService) private readonly archiveService: CollabArchiveService,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  /** 创建消费该队列的 BullMQ Worker（main.ts 启动；测试可直接调用） */
  createWorker(): Worker {
    const worker = new Worker(
      COLLAB_ARCHIVE_QUEUE_NAME,
      (job) => this.process(job),
      {
        connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
        concurrency: 2
      }
    );
    worker.on('error', (err) => this.logger.error(`归档 Worker error: ${err.message}`));
    return worker;
  }

  /** 单次执行（BullMQ processor 回调） */
  async process(job: Job<{ taskId: string }>): Promise<void> {
    const { taskId } = job.data;
    const repo = this.dataSource.getRepository(AgentArchiveOutboxEntity);

    // 已投递 → 幂等返回（重复重试不新增记录）
    const existing = await repo.findOneBy({ task_id: taskId });
    if (existing?.status === 'delivered') {
      this.logger.log(`归档已投递 task=${taskId}，重复重试幂等返回`);
      return;
    }

    try {
      const result = await this.archiveService.deliver(taskId);
      await this.auditService.record(null, 'collab_archive_delivered', 'agent_archive_outbox', existing?.id ?? null, {
        task_id: taskId,
        external_id: result.externalId,
        attempts: result.attempts
      });
      this.logger.log(`归档投递成功 task=${taskId} external=${result.externalId}`);
    } catch (err) {
      // 读取最新 attempts（deliver 已 +1），判断是否超限
      const latest = await repo.findOneBy({ task_id: taskId });
      const attempts = latest?.attempts ?? 0;
      const isCollab = err instanceof CollabUpstreamError;
      const retryable = isCollab ? err.retryable : false;
      const exceeded = attempts >= env.COLLAB_ARCHIVE_MAX_ATTEMPTS;

      if (exceeded || !retryable) {
        // 超限 / 不可重试 → 置 failed + 审计，终止重试
        if (latest && latest.status !== 'failed') {
          latest.status = 'failed';
          latest.updated_at = new Date();
          await repo.save(latest);
        }
        const message = err instanceof Error ? err.message : String(err);
        const code = isCollab ? err.code : 'COLLAB_ARCHIVE_FAILED';
        await this.auditService.record(null, 'collab_archive_failed', 'agent_archive_outbox', latest?.id ?? null, {
          task_id: taskId,
          message,
          code,
          attempts
        }).catch((e) => this.logger.error(`归档失败审计写入错误: ${(e as Error).message}`));
        this.logger.error(`归档投递最终失败 task=${taskId} attempts=${attempts} code=${code}`);
        throw new UnrecoverableError(message);
      }

      // 未超限且可重试 → 重抛，BullMQ 指数退避重试
      throw err;
    }
  }
}
