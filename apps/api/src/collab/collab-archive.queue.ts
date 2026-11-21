import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { env } from '../config/env';

export const COLLAB_ARCHIVE_QUEUE_NAME = 'collab-archive';

/**
 * F11 归档投递独立队列（T17）。
 * - 与主 ai-task 队列隔离：n8n 抖动不阻塞 AI 主链路
 * - jobId = task_id（同任务幂等去重，防重复重试新增记录）
 * - 指数退避 + 最多 COLLAB_ARCHIVE_MAX_ATTEMPTS（默认 5）
 * - 生命周期：由模块 provider 管理（onModuleDestroy 关闭连接）
 */
@Injectable()
export class CollabArchiveQueue implements OnModuleDestroy {
  private readonly queue: Queue;

  constructor() {
    this.queue = new Queue(COLLAB_ARCHIVE_QUEUE_NAME, {
      connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
      defaultJobOptions: {
        removeOnComplete: 1000,
        removeOnFail: 1000,
        attempts: env.COLLAB_ARCHIVE_MAX_ATTEMPTS,
        backoff: { type: 'exponential', delay: 5000 }
      }
    });
  }

  /** 入队一次投递（jobId = taskId，重复入队幂等，不新增 job） */
  async enqueue(taskId: string): Promise<void> {
    await this.queue.add('deliver', { taskId }, { jobId: taskId });
  }

  /** 暴露原始 Queue（供 Worker 同实例复用 / 测试调试） */
  get raw(): Queue {
    return this.queue;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
