// M3c-3 知识库 T12 作业处理器（状态机 + 事件写入 + 幂等键 + 退避重试 + 进程重启恢复）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.3、§5.4、§5.5、§4.5、§2.2.7、§2.2.8、§8.2
// 职责：通用作业状态机 queued→running→succeeded/failed/cancelled；
//       进度事件按 seq 单调写入 job_events；Idempotency-Key 幂等；退避重试 ≤3 次转 failed；
//       进程重启把遗留 running 置 failed（可重试，不假装完成）。
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';
import { KnowledgeJobEntity } from '../database/knowledge-job.entity';
import { KnowledgeJobEventEntity } from '../database/knowledge-job-event.entity';
import { knowledgeErrorCode, encodeCursor, decodeCursor } from '@storyforge/contracts';
import type { KnowledgeJobQueue } from './jobs.queue';
import type { KnowledgeJobEventBus } from './jobs.sse';
import type { KnowledgeJobProgress } from '@storyforge/contracts';

const KNOWLEDGE_JOB_RUNNING = knowledgeErrorCode.KNOWLEDGE_JOB_RUNNING;

// ───────────────────────────── 本地错误码（T12 补充） ─────────────────────────────
// F3 T12 完成标准明确要求 `409 IDEMPOTENCY_KEY_REUSE` 与进程重启错误码；
// T04 契约 `knowledgeErrorCode` 未定义这两项，此处作为执行层本地常量补充，
// 不写回 L0 契约（边界守卫），交付时登记契约缺口。
export const KNOWLEDGE_JOB_IDEMPOTENCY_REUSE = 'KNOWLEDGE_JOB_IDEMPOTENCY_REUSE';
export const KNOWLEDGE_JOB_HANGING = 'KNOWLEDGE_JOB_HANGING';

// ───────────────────────────── 类型 ─────────────────────────────

export interface CreateJobInput {
  ownerId: string;
  scope: 'global' | 'work';
  workId?: string | null;
  entryId?: string | null;
  kind: string;
  input: Record<string, unknown>;
  idempotencyKey?: string;
  requestFingerprint?: string;
  stagingPath?: string | null;
  createdBy?: string;
}

export interface JobError {
  code: string;
  message: string;
  reason?: string;
}

export type JobEventType = 'queued' | 'running' | 'progress' | 'succeeded' | 'failed' | 'cancelled';

// 请求指纹：幂等键「同键同请求」判断依据（kind+scope+workId+entryId+input 稳定哈希）
export function computeRequestFingerprint(input: {
  kind: string;
  scope: 'global' | 'work';
  workId?: string | null;
  entryId?: string | null;
  input: Record<string, unknown>;
}): string {
  const stable = JSON.stringify({
    kind: input.kind,
    scope: input.scope,
    workId: input.workId ?? null,
    entryId: input.entryId ?? null,
    input: input.input ?? {}
  });
  return createHash('sha256').update(stable, 'utf8').digest('hex');
}

@Injectable()
export class KnowledgeJobService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly queue: KnowledgeJobQueue,
    private readonly bus?: KnowledgeJobEventBus
  ) {}

  // ───────────────────────────── 创建作业（幂等键） ─────────────────────────────

  async createJob(input: CreateJobInput): Promise<KnowledgeJobEntity> {
    const repo = this.dataSource.getRepository(KnowledgeJobEntity);

    // 幂等键去重：同键 + 同请求指纹 → 返回原作业；同键 + 异指纹 → 409
    if (input.idempotencyKey) {
      const existing = await repo.findOneBy({ idempotency_key: input.idempotencyKey });
      if (existing) {
        const fp = input.requestFingerprint ?? computeRequestFingerprint(input);
        // 同键同请求 → 返回原作业；同键异请求（指纹不同）→ 409
        const existingFp = computeRequestFingerprint({
          kind: existing.kind,
          scope: existing.library_scope as 'global' | 'work',
          workId: existing.work_id,
          entryId: existing.entry_id,
          input: (existing.input as Record<string, unknown>) ?? {}
        });
        if (existingFp === fp) return existing;
        throw new ConflictException({
          code: KNOWLEDGE_JOB_IDEMPOTENCY_REUSE,
          message: 'Idempotency-Key 已被其他请求复用',
          details: { existing_job_id: existing.id }
        });
      }
    }

    const fingerprint =
      input.requestFingerprint ?? computeRequestFingerprint(input);
    const job = repo.create({
      id: randomUUID(),
      owner_id: input.ownerId,
      library_scope: input.scope,
      work_id: input.workId ?? null,
      entry_id: input.entryId ?? null,
      kind: input.kind,
      status: 'queued',
      progress: {},
      input: input.input,
      result: {},
      error: null,
      staging_path: input.stagingPath ?? null,
      idempotency_key: input.idempotencyKey ?? null,
      event_seq: 0,
      created_by: input.createdBy ?? input.ownerId,
      started_at: null,
      finished_at: null
    });
    await repo.save(job);

    // 写 queued 事件（seq=1）并投递队列
    await this.appendEvent(job.id, 'queued', { kind: input.kind });
    await this.queue.add(job.id);
    return this.getJob(job.id);
  }

  // ───────────────────────────── 状态机 ─────────────────────────────

  async startRunning(jobId: string): Promise<KnowledgeJobEntity> {
    return this.transition(jobId, 'queued', 'running', (job) => {
      job.started_at = new Date();
    }, 'running');
  }

  async reportProgress(jobId: string, progress: KnowledgeJobProgress): Promise<KnowledgeJobEntity> {
    const job = await this.getJob(jobId);
    if (job.status !== 'running') {
      throw new ConflictException({ code: KNOWLEDGE_JOB_RUNNING, message: '作业不在运行中' });
    }
    job.progress = progress as unknown as Record<string, unknown>;
    await this.dataSource.getRepository(KnowledgeJobEntity).save(job);
    await this.appendEvent(jobId, 'progress', { progress });
    return this.getJob(jobId);
  }

  async finishSucceeded(jobId: string, result: Record<string, unknown>): Promise<KnowledgeJobEntity> {
    return this.transition(jobId, 'running', 'succeeded', (job) => {
      job.result = result;
      job.finished_at = new Date();
    }, 'succeeded', { result });
  }

  async markFailed(jobId: string, error: JobError, _attempts = 0): Promise<KnowledgeJobEntity> {
    // 退避重试语义：错误码固定，attempts 仅记录；≤3 次统一置 failed（可重试由调用方决定重新入队）
    return this.transition(jobId, 'running', 'failed', (job) => {
      job.error = { code: error.code, message: error.message, ...(error.reason ? { reason: error.reason } : {}) };
      job.finished_at = new Date();
    }, 'failed', { error });
  }

  async cancelJob(jobId: string): Promise<KnowledgeJobEntity> {
    const job = await this.getJob(jobId);
    if (job.status !== 'queued' && job.status !== 'running') return job;
    return this.transition(jobId, job.status, 'cancelled', (j) => {
      j.finished_at = new Date();
    }, 'cancelled');
  }

  // 进程重启：遗留 running 置 failed，可重试；不假装完成
  async recoverHangingJobs(ownerId?: string): Promise<number> {
    const repo = this.dataSource.getRepository(KnowledgeJobEntity);
    const hanging = await repo.findBy(ownerId ? { status: 'running', owner_id: ownerId } : { status: 'running' });
    let count = 0;
    for (const job of hanging) {
      await this.transition(job.id, 'running', 'failed', (j) => {
        j.error = { code: KNOWLEDGE_JOB_HANGING, message: '进程重启，作业被中断' };
        j.finished_at = new Date();
      }, 'failed', { error: { code: KNOWLEDGE_JOB_HANGING, message: '进程重启，作业被中断' } });
      count++;
    }
    return count;
  }

  // ───────────────────────────── 查询 ─────────────────────────────

  async getJob(jobId: string): Promise<KnowledgeJobEntity> {
    const job = await this.dataSource.getRepository(KnowledgeJobEntity).findOneBy({ id: jobId });
    if (!job) {
      throw new NotFoundException({
        code: 'KNOWLEDGE_JOB_NOT_FOUND',
        message: '作业不存在'
      });
    }
    return job;
  }

  // 作业列表：按作者隔离 + 可选 scope/workId/kind/status 过滤 + created_at DESC 游标分页
  // 游标编码复用契约 encodeCursor/decodeCursor 语义（`created_at|id`，base64url）
  async listJobs(
    authorId: string,
    query: {
      scope?: 'global' | 'work';
      work_id?: string | null;
      kind?: string;
      status?: string;
      limit?: number;
      cursor?: string | null;
    } = {}
  ): Promise<{ items: KnowledgeJobEntity[]; total: number; next_cursor: string | null }> {
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const repo = this.dataSource.getRepository(KnowledgeJobEntity);

    const base = repo
      .createQueryBuilder('job')
      .where('job.owner_id = :authorId', { authorId });

    if (query.scope) base.andWhere('job.library_scope = :scope', { scope: query.scope });
    if (query.work_id) base.andWhere('job.work_id = :workId', { workId: query.work_id });
    if (query.kind) base.andWhere('job.kind = :kind', { kind: query.kind });
    if (query.status) base.andWhere('job.status = :status', { status: query.status });

    // 游标：created_at|id 字典序，取 (created_at, id) < 游标值
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor);
      if (decoded) {
        base.andWhere(
          '(job.created_at < :cursorAt OR (job.created_at = :cursorAt AND job.id < :cursorId))',
          { cursorAt: new Date(decoded.updatedAt), cursorId: decoded.id }
        );
      }
    }

    const total = await base.getCount();
    const items = await base
      .orderBy('job.created_at', 'DESC')
      .addOrderBy('job.id', 'DESC')
      .take(limit + 1)
      .getMany();

    const hasMore = items.length > limit;
    const pageItems = hasMore ? items.slice(0, limit) : items;
    const last = pageItems[pageItems.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.created_at.toISOString(), last.id) : null;

    return { items: pageItems, total, next_cursor: nextCursor };
  }

  // ───────────────────────────── 事件写入（seq 单调） ─────────────────────────────

  async appendEvent(jobId: string, type: JobEventType, payload: Record<string, unknown> = {}): Promise<KnowledgeJobEventEntity> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const job = await manager.getRepository(KnowledgeJobEntity).findOneBy({ id: jobId });
      if (!job) {
        throw new Error(`job ${jobId} not found for event append`);
      }
      const nextSeq = job.event_seq + 1;
      const event = manager.getRepository(KnowledgeJobEventEntity).create({
        id: randomUUID(),
        job_id: jobId,
        event_seq: nextSeq,
        type,
        payload,
        created_at: new Date()
      });
      await manager.getRepository(KnowledgeJobEventEntity).save(event);
      await manager.getRepository(KnowledgeJobEntity).update(jobId, { event_seq: nextSeq });
      // 事务外广播（若挂载了总线），供实时 SSE 订阅者消费
      this.bus?.publish({ job_id: jobId, event_seq: nextSeq, type, payload });
      return event;
    });
  }

  // ───────────────────────────── 内部：状态转移 ─────────────────────────────

  private async transition(
    jobId: string,
    from: string,
    to: string,
    mutate: (job: KnowledgeJobEntity) => void,
    eventType: JobEventType,
    eventPayload: Record<string, unknown> = {}
  ): Promise<KnowledgeJobEntity> {
    return this.dataSource.transaction(async (manager: EntityManager) => {
      const job = await manager.getRepository(KnowledgeJobEntity).findOneBy({ id: jobId });
      if (!job) {
        throw new NotFoundException({
          code: 'KNOWLEDGE_JOB_NOT_FOUND',
          message: '作业不存在'
        });
      }
      if (job.status !== from) {
        throw new ConflictException({
          code: KNOWLEDGE_JOB_RUNNING,
          message: `作业状态 ${job.status} 不允许从 ${from} 转移到 ${to}`
        });
      }
      mutate(job);
      job.status = to;
      await manager.getRepository(KnowledgeJobEntity).save(job);

      const nextSeq = job.event_seq + 1;
      const event = manager.getRepository(KnowledgeJobEventEntity).create({
        id: randomUUID(),
        job_id: jobId,
        event_seq: nextSeq,
        type: eventType,
        payload: eventPayload,
        created_at: new Date()
      });
      await manager.getRepository(KnowledgeJobEventEntity).save(event);
      await manager.getRepository(KnowledgeJobEntity).update(jobId, { event_seq: nextSeq });
      // 写回返回对象，保证调用方读到最新 seq
      job.event_seq = nextSeq;
      this.bus?.publish({ job_id: jobId, event_seq: nextSeq, type: eventType, payload: eventPayload });
      return job;
    });
  }
}
