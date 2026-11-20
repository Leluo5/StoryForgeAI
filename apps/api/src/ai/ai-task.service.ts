import { Inject, Injectable, NotFoundException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type {
  AiTask,
  AiTaskStatus,
  CreateAiTaskRequest,
  ListAiTasksQuery,
  ListAiTasksResponse
} from '@storyforge/contracts';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AiTaskEventEntity } from '../database/ai-task-event.entity';
import { WorkEntity } from '../database/work.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { AuditService } from '../revision/audit.service';
import { AgentService } from '../agent/agent.service';
import { AiTaskEventBus, AI_TASK_EVENT_BUS } from './ai-task.sse';

// ───────────────────────────── 队列端口（A5 实现，避免 A4↔A5 循环依赖） ─────────────────────────────

export interface AiTaskQueuePort {
  /** 入队任务（jobId=task.id，去重由 UNIQUE(idempotency_key) 兜底） */
  enqueue(taskId: string): Promise<void>;
  /** 移除队列中的任务（取消时调用；不在队列中则忽略） */
  remove(taskId: string): Promise<void>;
}

export const AI_TASK_QUEUE = Symbol('AI_TASK_QUEUE');

// ───────────────────────────── 实体 ↔ 契约映射 ─────────────────────────────

function toAiTask(entity: AiTaskEntity): AiTask {
  return {
    id: entity.id,
    work_id: entity.work_id,
    chapter_id: entity.chapter_id,
    scope: entity.scope,
    tool: entity.tool,
    agent_id: entity.agent_id,
    input_summary: entity.input_summary,
    base_version: entity.base_version,
    status: entity.status as AiTaskStatus,
    event_seq: entity.event_seq,
    result_revision_set_id: entity.result_revision_set_id,
    error: entity.error,
    attempts: entity.attempts,
    created_by: entity.created_by,
    created_at: entity.created_at.toISOString(),
    updated_at: entity.updated_at.toISOString()
  };
}

/** 悲观锁章节行 + 归属校验（复用 M2 assertOwnedChapter 模式） */
async function assertOwnedChapter(
  manager: EntityManager,
  workId: string,
  chapterId: string,
  authorId: string,
  lock = false
): Promise<ChapterEntity> {
  const qb = manager.getRepository(ChapterEntity).createQueryBuilder('chapter')
    .innerJoin(WorkEntity, 'work', 'work.id = chapter.work_id')
    .where('chapter.id = :chapterId', { chapterId })
    .andWhere('chapter.work_id = :workId', { workId })
    .andWhere('work.author_id = :authorId', { authorId });
  if (lock) qb.setLock('pessimistic_write');
  const chapter = await qb.getOne();
  if (!chapter) throw new NotFoundException('Chapter not found');
  return chapter;
}

/** 悲观锁任务行 + 归属校验（任务 → 作品 → 作者；兼容无章节的剧情任务） */
async function assertOwnedTask(
  manager: EntityManager,
  workId: string,
  taskId: string,
  authorId: string,
  lock = false
): Promise<AiTaskEntity> {
  const qb = manager.getRepository(AiTaskEntity).createQueryBuilder('task')
    .innerJoin(WorkEntity, 'work', 'work.id = task.work_id')
    .where('task.id = :taskId', { taskId })
    .andWhere('task.work_id = :workId', { workId })
    .andWhere('work.author_id = :authorId', { authorId });
  if (lock) qb.setLock('pessimistic_write');
  const task = await qb.getOne();
  if (!task) throw new NotFoundException('AI task not found');
  return task;
}

/** 写进度事件：event_seq = task.event_seq + 1，同步推进 task.event_seq（UNIQUE(task_id, event_seq) 兜底） */
async function appendEvent(
  manager: EntityManager,
  task: AiTaskEntity,
  bus: AiTaskEventBus,
  type: 'queued' | 'running' | 'progress' | 'succeeded' | 'failed' | 'cancelled',
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
  await manager.save(task); // 持久化 event_seq 推进，否则 retry/cancel 会重复写同序号撞 UNIQUE(task_id, event_seq)
  // 广播给该任务的所有 SSE 订阅者（payload 完整，订阅者无需回读 DB；事务内广播安全）
  bus.publish(task.id, {
    id: event.id,
    task_id: task.id,
    event_seq: seq,
    type: type as 'queued',
    payload,
    created_at: event.created_at.toISOString()
  });
}

@Injectable()
export class AiTaskService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(AI_TASK_QUEUE) private readonly queue: AiTaskQueuePort,
    @Inject(AI_TASK_EVENT_BUS) private readonly eventBus: AiTaskEventBus,
    @Inject(AgentService) private readonly agentService: AgentService
  ) {}

  /**
   * 发起 AI 创作任务（幂等去重）。
   * - 悲观锁章节行 + 归属校验
   * - 幂等键检查：已有有效结果 → 直接返回（不重复执行）；进行中 → 409；失败/取消 → 409（可 retry）
   * - 创建任务（queued, event_seq=0, base_version=chapter.version）+ 写 queued 事件 + 审计
   * - 事务提交后入队（enqueue 失败不影响任务创建，任务可恢复）
   */
  createTask(
    authorId: string,
    workId: string,
    chapterId: string,
    input: CreateAiTaskRequest
  ): Promise<{ task: AiTask; created: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const chapter = await assertOwnedChapter(manager, workId, chapterId, authorId, true);

      // 步骤 0（M3b）：工具存在且启用校验 + 解析执行 Agent（缺 Agent 时懒创建默认）
      const { agentId } = await this.agentService.resolveToolForTask(input.tool);
      const defaultAgent = await this.agentService.ensureDefaultAgent(authorId);

      const existing = await manager.getRepository(AiTaskEntity).findOneBy({ idempotency_key: input.idempotency_key });
      if (existing) {
        if (existing.status === 'succeeded' && existing.result_revision_set_id) {
          return { task: existing, created: false }; // 已有有效结果：幂等，不重复执行
        }
        if (existing.status === 'queued' || existing.status === 'running') {
          throw new ConflictException({
            message: 'AI task already in progress',
            details: { task_id: existing.id }
          });
        }
        throw new ConflictException({
          message: 'AI task exists and can be retried',
          details: { task_id: existing.id, retryable: true }
        });
      }

      const task = manager.getRepository(AiTaskEntity).create();
      task.id = randomUUID();
      task.idempotency_key = input.idempotency_key;
      task.work_id = workId;
      task.chapter_id = chapterId;
      task.tool = input.tool;
      // 步骤 2.5（M3b）：工具绑定 Agent 优先，否则回退作者默认 Agent
      task.agent_id = agentId ?? defaultAgent.id;
      task.input_summary = input.input_summary ?? {};
      task.base_version = chapter.version;
      task.status = 'queued';
      task.event_seq = 0;
      task.result_revision_set_id = null;
      task.error = null;
      task.attempts = 0;
      task.created_by = authorId;
      await manager.save(task);

      await appendEvent(manager, task, this.eventBus, 'queued', {
        tool: task.tool,
        base_version: task.base_version
      });

      await this.auditService.record(authorId, 'ai_task_create', 'ai_task', task.id, {
        chapter_id: chapterId,
        tool: task.tool,
        base_version: task.base_version
      }, workId);

      return { task, created: true };
    }).then(async (result) => {
      // 仅新建任务才入队；幂等命中不重复执行
      if (result.created) await this.queue.enqueue(result.task.id).catch(() => undefined);
      return { task: toAiTask(result.task), created: result.created };
    });
  }

  /** 单任务详情（作品内归属校验） */
  async getTask(authorId: string, workId: string, taskId: string): Promise<{ task: AiTask }> {
    const task = await assertOwnedTask(this.dataSource.manager, workId, taskId, authorId);
    return { task: toAiTask(task) };
  }

  /** 列出章节任务（分页 + status 过滤） */
  async listTasks(
    authorId: string,
    workId: string,
    chapterId: string,
    query: ListAiTasksQuery
  ): Promise<ListAiTasksResponse> {
    await assertOwnedChapter(this.dataSource.manager, workId, chapterId, authorId);
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const qb = this.dataSource.getRepository(AiTaskEntity).createQueryBuilder('task')
      .where('task.work_id = :workId', { workId })
      .andWhere('task.chapter_id = :chapterId', { chapterId });
    if (query.status) qb.andWhere('task.status = :status', { status: query.status });
    const [tasks, total] = await qb
      .orderBy('task.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();
    return { tasks: tasks.map(toAiTask), total, page, page_size: pageSize };
  }

  /**
   * 重试任务（仅 failed/cancelled 可重试；保留原幂等键）。
   * - 归属校验 + 悲观锁任务行
   * - status ∈ {failed, cancelled}？否则 422
   * - 置 queued，error=null，写 queued 事件，审计；提交后重新入队
   */
  retryTask(authorId: string, workId: string, taskId: string): Promise<{ task: AiTask }> {
    return this.dataSource.transaction(async (manager) => {
      const task = await assertOwnedTask(manager, workId, taskId, authorId, true);
      if (task.status !== 'failed' && task.status !== 'cancelled') {
        throw new UnprocessableEntityException({
          message: 'AI task is not retryable',
          details: { current_status: task.status }
        });
      }
      task.status = 'queued';
      task.error = null;
      await manager.save(task);

      await appendEvent(manager, task, this.eventBus, 'queued', {
        tool: task.tool,
        base_version: task.base_version
      });

      await this.auditService.record(authorId, 'ai_task_retry', 'ai_task', task.id, {
        chapter_id: task.chapter_id,
        tool: task.tool
      }, workId);

      return task;
    }).then(async (task) => {
      await this.queue.enqueue(task.id).catch(() => undefined);
      return { task: toAiTask(task) };
    });
  }

  /**
   * 取消任务（仅 queued/running 可取消；cancelled 幂等）。
   * - 归属校验 + 悲观锁任务行
   * - cancelled → 幂等返回；queued/running → 置 cancelled 写事件审计；其余 → 422
   * - 提交后从队列移除
   */
  cancelTask(authorId: string, workId: string, taskId: string): Promise<{ task: AiTask }> {
    return this.dataSource.transaction(async (manager) => {
      const task = await assertOwnedTask(manager, workId, taskId, authorId, true);
      if (task.status === 'cancelled') return { task, acted: false }; // 幂等：不重复写事件/审计/移除
      if (task.status !== 'queued' && task.status !== 'running') {
        throw new UnprocessableEntityException({
          message: 'AI task cannot be cancelled',
          details: { current_status: task.status }
        });
      }
      task.status = 'cancelled';
      await manager.save(task);

      await appendEvent(manager, task, this.eventBus, 'cancelled', {
        tool: task.tool
      });

      await this.auditService.record(authorId, 'ai_task_cancel', 'ai_task', task.id, {
        chapter_id: task.chapter_id,
        tool: task.tool
      }, workId);

      return { task, acted: true };
    }).then(async (result) => {
      if (result.acted) await this.queue.remove(result.task.id).catch(() => undefined);
      return { task: toAiTask(result.task) };
    });
  }
}
