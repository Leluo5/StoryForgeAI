import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AiTaskQueue, AI_TASK_QUEUE_NAME } from './ai-task.queue';
import { env } from '../config/env';
import { Redis } from 'ioredis';

let queue: AiTaskQueue;
let redis: Redis;

beforeEach(async () => {
  queue = new AiTaskQueue();
  redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  await redis.flushdb();
});

afterEach(async () => {
  await redis.flushdb();
  await queue.onModuleDestroy();
  await redis.quit();
});

describe('AiTaskQueue', () => {
  it('enqueues a job with jobId = task id and default attempts/backoff', async () => {
    const taskId = randomUUID();
    await queue.enqueue(taskId);

    const job = await queue.raw.getJob(taskId);
    expect(job).not.toBeNull();
    expect(job!.name).toBe('process');
    expect(job!.data).toEqual({ taskId });
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toMatchObject({ type: 'exponential', delay: 2000 });
  });

  it('is idempotent for the same task id (jobId dedupe)', async () => {
    const taskId = randomUUID();
    await queue.enqueue(taskId);
    await queue.enqueue(taskId); // 重复入队，jobId 相同 → BullMQ 去重

    const count = await queue.raw.getJobCountByTypes('wait', 'active', 'waiting-children');
    expect(count).toBe(1);
  });

  it('removes a job from the queue', async () => {
    const taskId = randomUUID();
    await queue.enqueue(taskId);
    expect(await queue.raw.getJob(taskId)).not.toBeUndefined();

    await queue.remove(taskId);
    expect(await queue.raw.getJob(taskId)).toBeUndefined();
  });

  it('ignores removing a job that is not in the queue', async () => {
    await expect(queue.remove(randomUUID())).resolves.toBeUndefined();
  });

  it('processes an enqueued job through a Worker', async () => {
    const taskId = randomUUID();
    const processed: string[] = [];
    const { Worker } = await import('bullmq');
    const worker = new Worker(AI_TASK_QUEUE_NAME, async (job) => {
      processed.push(job.data.taskId);
      return true;
    }, { connection: { url: env.REDIS_URL, maxRetriesPerRequest: null } });
    try {
      await queue.enqueue(taskId);
      await viWaitFor(() => processed.length === 1);
      expect(processed).toEqual([taskId]);
    } finally {
      await worker.close();
    }
  });
});

async function viWaitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
