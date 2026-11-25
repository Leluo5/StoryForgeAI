// M3c-3 知识库 T12 SSE 事件总线与服务
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.6、§2.2.8、§8.2、§11.1（对齐 ai-task.sse.ts）
// 职责：进程内事件广播 + 断线重放（Last-Event-ID / after_seq）+ 终态关闭 + 404。
// 流式心跳与超时重连由 controller 层（T24）提供 Express 实现；本文件提供可测核心。
import { EventEmitter } from 'node:events';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { KnowledgeJobEventEntity } from '../database/knowledge-job-event.entity';
import { KnowledgeJobEntity } from '../database/knowledge-job.entity';

export interface JobEventView {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  at: string;
}

export interface ReplaySnapshot {
  events: JobEventView[];
  terminal: boolean;
  status: string;
}

export interface SseSink {
  write(data: string): void;
  close(): void;
}

/**
 * 进程内事件总线：job_id → 订阅者。写入 job_events 后 publish，供实时 SSE 转发。
 * 与 ai-task.sse.ts 范式一致；断线重放以 DB 为真相源（event_seq），总线只做在线广播。
 */
@Injectable()
export class KnowledgeJobEventBus {
  private readonly emitter = new EventEmitter();

  publish(event: { job_id: string; event_seq: number; type: string; payload: Record<string, unknown> }): void {
    this.emitter.emit(event.job_id, event);
  }

  subscribe(jobId: string, listener: (event: { event_seq: number; type: string; payload: Record<string, unknown> }) => void): () => void {
    this.emitter.on(jobId, listener);
    return () => this.emitter.off(jobId, listener);
  }
}

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * SSE 服务：重放快照（after_seq 之后的事件）+ 实时转发 + 终态关闭 + 404。
 * controller 层调用 streamEvents，传入 Express res 包装的 SseSink。
 */
@Injectable()
export class KnowledgeJobSseService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(KnowledgeJobEventBus) private readonly bus: KnowledgeJobEventBus
  ) {}

  async getJob(jobId: string): Promise<KnowledgeJobEntity> {
    const job = await this.dataSource.getRepository(KnowledgeJobEntity).findOneBy({ id: jobId });
    if (!job) {
      throw new NotFoundException({ code: 'KNOWLEDGE_JOB_NOT_FOUND', message: '作业不存在' });
    }
    return job;
  }

  // 断线重放快照：after_seq 之后的事件（含终态标记）
  async buildReplaySnapshot(jobId: string, afterSeq: number): Promise<ReplaySnapshot> {
    const job = await this.getJob(jobId);
    const events = await this.dataSource
      .getRepository(KnowledgeJobEventEntity)
      .find({ where: { job_id: jobId }, order: { event_seq: 'ASC' } });
    const after = events.filter((e) => e.event_seq > afterSeq);
    const replayEvents: JobEventView[] = after.map((e) => ({
      seq: e.event_seq,
      type: e.type,
      payload: (e.payload as Record<string, unknown>) ?? {},
      at: e.created_at.toISOString()
    }));
    // 同步终态作业（导出/备份/恢复提交）在请求内直接置 succeeded，可能未写 job_events 行；
    // 若终态且无任何可重放事件，合成一帧终态事件，保证 SSE 客户端可观测到终态并关闭。
    if (replayEvents.length === 0 && TERMINAL_STATUSES.has(job.status)) {
      replayEvents.push({
        seq: Math.max(job.event_seq ?? 0, afterSeq + 1),
        type: job.status,
        payload: (job.result as Record<string, unknown>) ?? {},
        at: job.created_at.toISOString()
      });
    }
    return {
      events: replayEvents,
      terminal: TERMINAL_STATUSES.has(job.status),
      status: job.status
    };
  }

  /**
   * 流式事件：先重放快照，再订阅实时；终态或断线后关闭。
   * 若作业不存在 → 抛出 NotFoundException（controller 层转 404）。
   */
  async streamEvents(jobId: string, afterSeq: number, sink: SseSink): Promise<void> {
    const snap = await this.buildReplaySnapshot(jobId, afterSeq);
    for (const ev of snap.events) {
      sink.write(this.serializeEvent(ev));
    }
    if (snap.terminal) {
      sink.close();
      return;
    }

    // 实时转发：订阅后若有新事件，publish 触发写 sink；终态到达后关闭
    const unsubscribe = this.bus.subscribe(jobId, (event) => {
      const view: JobEventView = {
        seq: event.event_seq,
        type: event.type,
        payload: event.payload,
        at: new Date().toISOString()
      };
      sink.write(this.serializeEvent(view));
      if (TERMINAL_STATUSES.has(event.type)) {
        unsubscribe();
        sink.close();
      }
    });

    // 兜底：订阅时若已终态（竞态），关闭
    try {
      const latest = await this.getJob(jobId);
      if (TERMINAL_STATUSES.has(latest.status)) {
        unsubscribe();
        sink.close();
      }
    } catch {
      unsubscribe();
      sink.close();
    }
  }

  private serializeEvent(ev: JobEventView): string {
    return `data: ${JSON.stringify({ event: ev.type, seq: ev.seq, payload: ev.payload, at: ev.at })}\n\n`;
  }
}
