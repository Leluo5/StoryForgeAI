// M3c-3 知识库 T12 作业队列（BullMQ `knowledge-jobs`）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.5、§2.2.7、§8.2
// 职责：BullMQ Queue 薄封装。幂等键去重与状态机在 processor/service（需查库），queue 只做投递。
import { Queue } from 'bullmq';
import type { ConnectionOptions } from 'bullmq';

export const KNOWLEDGE_JOBS_QUEUE_NAME = 'knowledge-jobs';

// 队列投递抽象：processor/service 依赖此接口而非具体 BullMQ Queue，便于单测注入内存实现
export interface KnowledgeJobQueue {
  add(jobId: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * 创建 BullMQ 作业队列。
 * @param connection BullMQ 连接参数（复用 ai-tasks 的 Redis 连接）
 */
export function createKnowledgeJobsQueue(connection: ConnectionOptions): KnowledgeJobQueue {
  const queue = new Queue(KNOWLEDGE_JOBS_QUEUE_NAME, { connection });
  return {
    async add(jobId: string): Promise<void> {
      // 每个作业一条消息；jobId 作为 messageId 保证去重
      await queue.add('knowledge-job', { jobId }, { jobId, removeOnComplete: 1000, removeOnFail: 1000 });
    },
    async close(): Promise<void> {
      await queue.close();
    }
  };
}
