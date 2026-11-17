import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { Job, Worker, UnrecoverableError } from 'bullmq';
import type { ProseMirrorNode } from '@storyforge/contracts';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AiTaskEventEntity } from '../database/ai-task-event.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { AuditService } from '../revision/audit.service';
import { AI_TASK_QUEUE_NAME } from './ai-task.queue';
import { AiModelError, type AiModelProvider, type AiModelContext, AI_MODEL_PROVIDER } from './ai-model.provider';
import { AiTaskEventBus, AI_TASK_EVENT_BUS } from './ai-task.sse';
import { env } from '../config/env';

// ───────────────────────────── 结果映射端口（A6 实现，避免 A5↔A6 循环依赖） ─────────────────────────────

export interface AiRevisionSetResult {
  /** 修订集 id；章节基准版本已变化（stale）时为 null */
  revision_set_id: string | null;
  /** 候选输出基于旧版本生成，作者需提示重新生成 */
  stale: boolean;
}

export interface AiResultMapperPort {
  /**
   * 生成 AI 修订集（actor_type='ai' / ai_set=true）。
   * @param manager 调用方事务（修订集创建与任务状态推进需原子）
   */
  toAiRevisionSet(
    manager: EntityManager,
    ctx: { authorId: string; workId: string; chapterId: string; baseVersion: number; candidateDocument: ProseMirrorNode }
  ): Promise<AiRevisionSetResult>;
}

export const AI_RESULT_MAPPER = Symbol('AI_RESULT_MAPPER');

// ───────────────────────────── 处理器 ─────────────────────────────

/** 写进度事件：event_seq 单调递增（UNIQUE(task_id, event_seq) 兜底），同步推进并持久化 task.event_seq */
async function appendEvent(
  manager: EntityManager,
  task: AiTaskEntity,
  bus: AiTaskEventBus,
  type: 'running' | 'progress' | 'succeeded' | 'failed' | 'cancelled',
  payload: Record<string, unknown>
): Promise<void> {
  const seq = task.event_seq + 1;
  const event = manager.getRepository(AiTaskEventEntity).create();
  event.id = randomUUID();
  event.task_id = task.id;
  event.event_seq = seq;
  event.type = type;
  event.payload = payload;
  await manager.save(event);
  task.event_seq = seq;
  await manager.save(task);
  // 广播给该任务的所有 SSE 订阅者（payload 完整，订阅者无需回读 DB；事务内广播安全）
  bus.publish(task.id, {
    id: event.id,
    task_id: task.id,
    event_seq: seq,
    type: type as 'running',
    payload,
    created_at: event.created_at.toISOString()
  });
}

interface ProcessContext {
  taskId: string;
  authorId: string;
  workId: string;
  chapterId: string;
  tool: string;
  inputSummary: Record<string, unknown>;
  baseVersion: number;
  baseDocument: ProseMirrorNode;
}

/**
 * AI 任务处理器：消费 BullMQ 队列，执行一次 AI 创作任务。
 * 状态流：queued → running → succeeded / failed；被取消（cancelled）时检查点退出。
 * 失败语义：retryable 模型错误按 BullMQ 退避重试（共 attempts 次）；超限/不可重试标 failed。
 */
@Injectable()
export class AiTaskProcessor {
  private readonly logger = new Logger(AiTaskProcessor.name);

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(AI_MODEL_PROVIDER) private readonly model: AiModelProvider,
    @Inject(AI_RESULT_MAPPER) private readonly mapper: AiResultMapperPort,
    @Inject(AI_TASK_EVENT_BUS) private readonly eventBus: AiTaskEventBus
  ) {}

  /** 创建消费该队列的 BullMQ Worker（A8 在 main.ts 启动；测试可直接调用） */
  createWorker(): Worker {
    const worker = new Worker(
      AI_TASK_QUEUE_NAME,
      (job) => this.process(job),
      {
        connection: { url: this.redisUrl(), maxRetriesPerRequest: null },
        concurrency: 4
      }
    );
    // 兜底：最终失败但 DB 任务仍非终态 → 标 failed（process 内已处理，此处仅防进程异常遗漏）
    worker.on('failed', (job, err) => void this.onJobFailed(job, err));
    worker.on('error', (err) => this.logger.error(`Worker error: ${err.message}`));
    return worker;
  }

  /** 单次执行（BullMQ processor 回调） */
  async process(job: Job<{ taskId: string }>): Promise<void> {
    const taskId = job.data.taskId;
    const attempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= attempts;
    try {
      const started = await this.startRunning(taskId, job.attemptsMade);
      if (started.skipped) return; // 任务已被取消/完成，无事可做

      const candidate = await this.model.generate(started.context);
      const outcome = await this.finishSucceeded(started.context, candidate.candidateDocument);
      if (outcome.skipped) return; // 执行期间被取消
    } catch (err) {
      // 不可重试或最后一次尝试 → 标 failed；否则保持 running，由 BullMQ 退避重试
      const retryable = err instanceof AiModelError ? err.retryable : false;
      const shouldMarkFailed = isFinalAttempt || !retryable;
      if (shouldMarkFailed) {
        await this.markFailed(taskId, err).catch(() => undefined);
      }
      if (!retryable && !(err instanceof UnrecoverableError)) {
        throw new UnrecoverableError(err instanceof Error ? err.message : 'Unrecoverable model error');
      }
      throw err;
    }
  }

  /** 事务1：锁任务，queued→running（重试进入时 running 直接放行），读基准章节 */
  private async startRunning(taskId: string, attemptsMade: number): Promise<{ skipped: boolean; context: ProcessContext }> {
    return this.dataSource.transaction(async (manager) => {
      const task = await manager.getRepository(AiTaskEntity).createQueryBuilder('task')
        .where('task.id = :taskId', { taskId })
        .setLock('pessimistic_write')
        .getOne();
      if (!task) return { skipped: true, context: null as never };

      // 终态（已取消/已成功/已失败）→ 检查点退出；仅 queued 或 running（重试）可进入
      if (task.status === 'cancelled' || task.status === 'succeeded' || task.status === 'failed') {
        return { skipped: true, context: null as never };
      }
      const wasQueued = task.status === 'queued';
      task.status = 'running';
      task.attempts = task.attempts + 1;
      if (wasQueued) {
        await appendEvent(manager, task, this.eventBus, 'running', { tool: task.tool, attempts: task.attempts });
      } else {
        await manager.save(task); // 重试进入：仅推进 attempts，不重复写 running 事件
      }

      const chapter = await manager.getRepository(ChapterEntity).findOneByOrFail({ id: task.chapter_id });
      return {
        skipped: false,
        context: {
          taskId: task.id,
          authorId: task.created_by,
          workId: task.work_id,
          chapterId: task.chapter_id,
          tool: task.tool,
          inputSummary: task.input_summary,
          baseVersion: task.base_version,
          baseDocument: chapter.document as ProseMirrorNode
        }
      };
    });
  }

  /** 事务2：锁任务，创建修订集 + succeeded + 事件 + 审计（原子；执行期间被取消则跳过） */
  private async finishSucceeded(
    context: ProcessContext,
    candidateDocument: ProseMirrorNode
  ): Promise<{ skipped: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const task = await manager.getRepository(AiTaskEntity).createQueryBuilder('task')
        .where('task.id = :taskId', { taskId: context.taskId })
        .setLock('pessimistic_write')
        .getOne();
      if (!task || task.status !== 'running') return { skipped: true }; // 被取消/状态异常 → 不落地结果

      const result = await this.mapper.toAiRevisionSet(manager, {
        authorId: context.authorId,
        workId: context.workId,
        chapterId: context.chapterId,
        baseVersion: context.baseVersion,
        candidateDocument
      });

      task.status = 'succeeded';
      task.result_revision_set_id = result.revision_set_id;
      await appendEvent(manager, task, this.eventBus, 'succeeded', {
        tool: context.tool,
        revision_set_id: result.revision_set_id,
        stale: result.stale,
        base_version: context.baseVersion
      });

      await this.auditService.record(context.authorId, 'ai_task_succeeded', 'ai_task', task.id, {
        chapter_id: context.chapterId,
        tool: context.tool,
        revision_set_id: result.revision_set_id,
        stale: result.stale
      }, context.workId);

      return { skipped: false };
    });
  }

  /** 标记任务失败：锁任务，仅 running/queued 可转 failed（终态跳过，幂等） */
  private async markFailed(taskId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const retryable = err instanceof AiModelError ? err.retryable : true;
    const code = err instanceof AiModelError ? err.code : 'UNKNOWN';
    await this.dataSource.transaction(async (manager) => {
      const task = await manager.getRepository(AiTaskEntity).createQueryBuilder('task')
        .where('task.id = :taskId', { taskId })
        .setLock('pessimistic_write')
        .getOne();
      if (!task) return;
      if (task.status === 'cancelled' || task.status === 'succeeded' || task.status === 'failed') return;

      task.status = 'failed';
      task.error = { message, code, retryable };
      await appendEvent(manager, task, this.eventBus, 'failed', { message, code, retryable });

      await this.auditService.record(task.created_by, 'ai_task_failed', 'ai_task', task.id, {
        chapter_id: task.chapter_id,
        tool: task.tool,
        message,
        code,
        retryable
      }, task.work_id);
    });
  }

  /** Worker 'failed' 兜底：最终失败但 DB 仍非终态 → 标 failed（process 内已处理则幂等跳过） */
  private async onJobFailed(job: Job<{ taskId: string }> | undefined, err: Error): Promise<void> {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return; // 还会重试，不标
    await this.markFailed(job.data.taskId, err).catch((e) => this.logger.error(`markFailed fallback error: ${(e as Error).message}`));
  }

  private redisUrl(): string {
    return env.REDIS_URL;
  }
}
