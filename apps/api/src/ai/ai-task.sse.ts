import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { DataSource } from 'typeorm';
import type { AiTaskEvent, AiTaskEventType } from '@storyforge/contracts';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AiTaskEventEntity } from '../database/ai-task-event.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { WorkEntity } from '../database/work.entity';

// ───────────────────────────── 事件总线 ─────────────────────────────

/**
 * 事件总线：进程内 EventEmitter，key = `task:${taskId}`。
 * 事件写入（appendEvent）后广播给该任务的所有 SSE 订阅者；进程重启后订阅丢失，
 * 由客户端重连 + since 补取（ai_task_events 表）恢复，SSE 只推送不承载状态。
 */
@Injectable()
export class AiTaskEventBus {
  private readonly emitter = new EventEmitter();

  private key(taskId: string): string {
    return `task:${taskId}`;
  }

  /** 广播一个任务事件给该任务的所有订阅者 */
  publish(taskId: string, event: AiTaskEvent): void {
    this.emitter.emit(this.key(taskId), event);
  }

  /** 订阅某任务的事件（幂等；同一 listener 重复订阅只注册一次） */
  subscribe(taskId: string, listener: (event: AiTaskEvent) => void): void {
    this.emitter.on(this.key(taskId), listener);
  }

  /** 取消订阅 */
  unsubscribe(taskId: string, listener: (event: AiTaskEvent) => void): void {
    this.emitter.off(this.key(taskId), listener);
  }
}

export const AI_TASK_EVENT_BUS = Symbol('AI_TASK_EVENT_BUS');

// ───────────────────────────── SSE 序列化 ─────────────────────────────

/** SSE 推送事件：type 含传输层包装 snapshot（对齐 contract aiTaskEventTypeSchema） */
export interface SsePushEvent {
  id: string;
  task_id: string;
  event_seq: number;
  type: AiTaskEventType;
  payload: Record<string, unknown>;
  created_at: string;
}

/** 实体 → 契约事件视图（ai_task_events 持久化事件，type 不含 snapshot） */
function toEventView(entity: AiTaskEventEntity): AiTaskEvent {
  return {
    id: entity.id,
    task_id: entity.task_id,
    event_seq: entity.event_seq,
    type: entity.type as AiTaskEvent['type'],
    payload: entity.payload,
    created_at: entity.created_at.toISOString()
  };
}

/**
 * SSE 帧序列化：`event: <type>\nid: <event_seq>\ndata: <json>\n\n`。
 * id 用于 Last-Event-ID 断线重连补取；事件序号不丢序（按写入/查询顺序推送）。
 */
function serializeEvent(event: SsePushEvent): string {
  return `event: ${event.type}\nid: ${event.event_seq}\ndata: ${JSON.stringify(event)}\n\n`;
}

// ───────────────────────────── SSE 连接处理 ─────────────────────────────

@Injectable()
export class AiTaskSseService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AI_TASK_EVENT_BUS) private readonly bus: AiTaskEventBus
  ) {}

  /**
   * SSE 连接处理（供 controller 调用；A8 接入 GET /works/:workId/ai-tasks/:taskId/events）。
   * 顺序：归属校验 → SSE 头 → snapshot → since 补取 → 实时转发 → 心跳 + 断开清理。
   * @param params.request  原始 HTTP 请求（监听 close）
   * @param params.response 原始 HTTP 响应（直接 write 事件帧）
   * @param params.lastEventId Last-Event-ID 请求头（断线重连）
   * @param params.since       查询参数 since（等价 Last-Event-ID）
   */
  async handleEvents(params: {
    authorId: string;
    workId: string;
    taskId: string;
    request: Request;
    response: Response;
    lastEventId?: string | null;
    since?: number;
  }): Promise<void> {
    const { authorId, workId, taskId, request, response, lastEventId, since } = params;

    // 1. 归属校验（任务 → 章节 → 作品 → 作者；无权限/不存在 → 404）
    const task = await this.assertOwnedTask(authorId, workId, taskId);

    // 2. SSE 响应头（no-cache + keep-alive + 关闭代理缓冲）
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders();

    // 3. 先推 snapshot（当前任务状态；SSE 只推送不承载状态，snapshot 提供连接时状态基线）
    const snapshot: SsePushEvent = {
      id: `snapshot-${task.id}`,
      task_id: task.id,
      event_seq: task.event_seq,
      type: 'snapshot',
      payload: {
        status: task.status,
        event_seq: task.event_seq,
        result_revision_set_id: task.result_revision_set_id,
        error: task.error,
        attempts: task.attempts,
        tool: task.tool
      },
      created_at: task.updated_at.toISOString()
    };
    response.write(serializeEvent(snapshot));

    // 4. since 补取：仅当客户端显式提供游标（Last-Event-ID 头 / since 查询参数）才补取历史。
    //    首次连接无游标时不补取（snapshot 已给状态基线，避免把任务创建以来的过程性事件重复推送）。
    //    游标 = max(Last-Event-ID, since)；仅推送 event_seq > 游标的遗漏事件。
    const headerCursor = Number(lastEventId ?? 0);
    const queryCursor = Number(since ?? 0);
    const hasHeader = lastEventId != null && String(lastEventId).trim() !== '' && Number.isFinite(headerCursor);
    const hasQuery = since != null && Number.isFinite(queryCursor);
    const hasCursor = hasHeader || hasQuery;
    if (hasCursor) {
      const sinceSeq = Math.max(headerCursor, queryCursor);
      const missed = await this.dataSource.getRepository(AiTaskEventEntity).createQueryBuilder('event')
        .where('event.task_id = :taskId', { taskId })
        .andWhere('event.event_seq > :since', { since: sinceSeq })
        .orderBy('event.event_seq', 'ASC')
        .getMany();
      for (const event of missed) {
        response.write(serializeEvent(toEventView(event)));
      }
    }

    // 5. 订阅事件总线，实时转发新事件（事件序号由 appendEvent 单调递增，不丢序）
    const listener = (event: AiTaskEvent): void => {
      response.write(serializeEvent(event));
    };
    this.bus.subscribe(taskId, listener);

    // 6. 心跳（15s 注释帧保活）+ 断开清理（清心跳 + 取消订阅）
    const heartbeat = setInterval(() => {
      response.write(': ping\n\n');
    }, 15_000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      this.bus.unsubscribe(taskId, listener);
    };
    request.on('close', cleanup);
  }

  /** 任务归属校验：任务 ∈ 作品 ∈ 作者，否则 404 */
  private async assertOwnedTask(authorId: string, workId: string, taskId: string): Promise<AiTaskEntity> {
    const task = await this.dataSource.getRepository(AiTaskEntity).createQueryBuilder('task')
      .innerJoin(ChapterEntity, 'chapter', 'chapter.id = task.chapter_id')
      .innerJoin(WorkEntity, 'work', 'work.id = chapter.work_id')
      .where('task.id = :taskId', { taskId })
      .andWhere('task.work_id = :workId', { workId })
      .andWhere('chapter.work_id = :workId', { workId })
      .andWhere('work.author_id = :authorId', { authorId })
      .getOne();
    if (!task) throw new NotFoundException('AI task not found');
    return task;
  }
}
