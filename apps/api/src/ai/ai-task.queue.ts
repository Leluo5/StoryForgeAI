import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { AiTaskQueuePort } from './ai-task.service';
import { env } from '../config/env';

export const AI_TASK_QUEUE_NAME = 'ai-task';

/**
 * BullMQ 队列封装（实现 A4 定义的 AiTaskQueuePort）。
 * - jobId = task.id（同任务幂等去重；跨任务去重由 UNIQUE(idempotency_key) 兜底）
 * - remove 只在任务仍在队列时生效（BullMQ 的 remove 对不存在 job 抛错，需捕获）
 * - 生命周期：由模块 provider 管理（onModuleDestroy 关闭连接）
 */
@Injectable()
export class AiTaskQueue implements AiTaskQueuePort, OnModuleDestroy {
  private readonly queue: Queue;

  constructor() {
    this.queue = new Queue(AI_TASK_QUEUE_NAME, {
      connection: { url: env.REDIS_URL, maxRetriesPerRequest: null },
      defaultJobOptions: {
        removeOnComplete: 1000,
        removeOnFail: 5000,
        // 重试策略：retryable 模型错误按指数退避重试，共 3 次尝试；超限由 failed 事件标 failed
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 }
      }
    });
  }

  async enqueue(taskId: string): Promise<void> {
    await this.queue.add('process', { taskId }, { jobId: taskId });
  }

  async remove(taskId: string): Promise<void> {
    const job = await this.queue.getJob(taskId);
    if (job) await job.remove();
  }

  /** 暴露原始 Queue（供测试/调试/Worker 同实例复用） */
  get raw(): Queue {
    return this.queue;
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
