import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EntityManager } from 'typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import type { ProseMirrorNode } from '@storyforge/contracts';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { AiTaskProcessor, type AiResultMapperPort, type AiRevisionSetResult } from './ai-task.processor';
import { MockAiModelProvider, AiModelError } from './ai-model.provider';
import { AiTaskService } from './ai-task.service';
import { AgentService } from '../agent/agent.service';
import { AiTaskEventBus } from './ai-task.sse';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AiTaskEventEntity } from '../database/ai-task-event.entity';
import { RevisionSetEntity } from '../database/revision-set.entity';

let fixture: WritingFixture;
let processor: AiTaskProcessor;
let mapperCalls: number;
let mapperStale: boolean;

function idempotencyKey(): string {
  return `m3a-a5-${randomUUID()}`;
}

function makeMapper(): AiResultMapperPort {
  return {
    async toAiRevisionSet(
      manager: EntityManager,
      ctx: { authorId: string; workId: string; chapterId: string; baseVersion: number }
    ): Promise<AiRevisionSetResult> {
      mapperCalls += 1;
      const revisionSet = await manager.getRepository(RevisionSetEntity).save(
        manager.getRepository(RevisionSetEntity).create({
          id: randomUUID(),
          chapter_id: ctx.chapterId,
          base_version: ctx.baseVersion,
          actor_type: 'ai',
          actor_id: null,
          operations: [{ index: 0, step: { type: 'replace', from: 0, to: 1 }, status: 'pending' }],
          status: 'pending',
          ai_set: true
        })
      );
      return { revision_set_id: revisionSet.id, stale: mapperStale };
    }
  };
}

function makeJob(taskId: string, attemptsMade: number, totalAttempts = 3): Job<{ taskId: string }> {
  return {
    data: { taskId },
    attemptsMade,
    opts: { attempts: totalAttempts }
  } as unknown as Job<{ taskId: string }>;
}

async function createQueuedTask(tool: 'continue' | 'rewrite' | 'expand' | 'polish' = 'continue'): Promise<AiTaskEntity> {
  const service = new AiTaskService(fixture.dataSource, {
    record: vi.fn(async () => ({ id: randomUUID() }))
  } as never, {
    enqueue: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined)
  }, new AiTaskEventBus(),
  new AgentService(fixture.dataSource, { record: vi.fn() } as never));
  const { task } = await service.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
    tool, input_summary: { selection: { from: 0, to: 10 } }, idempotency_key: idempotencyKey()
  });
  return fixture.dataSource.getRepository(AiTaskEntity).findOneByOrFail({ id: task.id });
}

beforeEach(async () => {
  fixture = await createWritingFixture();
  mapperCalls = 0;
  mapperStale = false;
});

afterEach(async () => {
  await destroyWritingFixture(fixture);
});

describe('AiTaskProcessor', () => {
  it('runs a queued task to success: running → model → mapper → succeeded with revision_set_id', async () => {
    const task = await createQueuedTask();
    const model = new MockAiModelProvider();
    processor = new AiTaskProcessor(fixture.dataSource, {
      record: vi.fn(async () => ({ id: randomUUID() }))
    } as never, model, makeMapper(), new AiTaskEventBus());

    await processor.process(makeJob(task.id, 0));

    const stored = await fixture.dataSource.getRepository(AiTaskEntity).findOneByOrFail({ id: task.id });
    expect(stored.status).toBe('succeeded');
    expect(stored.result_revision_set_id).not.toBeNull();
    expect(stored.attempts).toBe(1);
    expect(mapperCalls).toBe(1);

    const events = await fixture.dataSource.getRepository(AiTaskEventEntity).findBy({ task_id: task.id });
    const types = events.map((e) => e.type);
    expect(types).toContain('running');
    expect(types).toContain('succeeded');
    // 事件序号单调递增
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i]!.event_seq).toBeGreaterThan(events[i - 1]!.event_seq);
    }
    const succeeded = events.find((e) => e.type === 'succeeded')!;
    expect(succeeded.payload.revision_set_id).toBe(stored.result_revision_set_id);
    expect(succeeded.payload.stale).toBe(false);
  });

  it('marks stale when the mapper reports a stale result', async () => {
    const task = await createQueuedTask();
    mapperStale = true;
    processor = new AiTaskProcessor(fixture.dataSource, {
      record: vi.fn(async () => ({ id: randomUUID() }))
    } as never, new MockAiModelProvider(), makeMapper(), new AiTaskEventBus());

    await processor.process(makeJob(task.id, 0));

    const stored = await fixture.dataSource.getRepository(AiTaskEntity).findOneByOrFail({ id: task.id });
    expect(stored.status).toBe('succeeded');
    const succeeded = await fixture.dataSource.getRepository(AiTaskEventEntity).findOneBy({
      task_id: task.id, type: 'succeeded'
    });
    expect(succeeded!.payload.stale).toBe(true);
  });

  it('rethrows a retryable model error on a non-final attempt without marking failed', async () => {
    const task = await createQueuedTask();
    processor = new AiTaskProcessor(fixture.dataSource, {
      record: vi.fn(async () => ({ id: randomUUID() }))
    } as never, new MockAiModelProvider({ fail: true }), makeMapper(), new AiTaskEventBus());

    await expect(processor.process(makeJob(task.id, 0))).rejects.toBeInstanceOf(AiModelError);

    const stored = await fixture.dataSource.getRepository(AiTaskEntity).findOneByOrFail({ id: task.id });
    expect(stored.status).toBe('running'); // 保留 running，等待 BullMQ 退避重试
    expect(stored.error).toBeNull();
  });

  it('marks failed on the final attempt after retries are exhausted', async () => {
    const task = await createQueuedTask();
    processor = new AiTaskProcessor(fixture.dataSource, {
      record: vi.fn(async () => ({ id: randomUUID() }))
    } as never, new MockAiModelProvider({ fail: true }), makeMapper(), new AiTaskEventBus());

    // 第 3 次尝试（attemptsMade=2, total=3）→ 超限标 failed
    await expect(processor.process(makeJob(task.id, 2, 3))).rejects.toBeInstanceOf(AiModelError);

    const stored = await fixture.dataSource.getRepository(AiTaskEntity).findOneByOrFail({ id: task.id });
    expect(stored.status).toBe('failed');
    expect(stored.error).toMatchObject({ code: 'MOCK_FAIL', retryable: true });

    const failed = await fixture.dataSource.getRepository(AiTaskEventEntity).findOneBy({
      task_id: task.id, type: 'failed'
    });
    expect(failed).not.toBeNull();
    expect(failed!.payload.code).toBe('MOCK_FAIL');
  });

  it('marks failed immediately and throws UnrecoverableError for a non-retryable model error', async () => {
    const task = await createQueuedTask();
    const failingModel = {
      async generate(): Promise<never> {
        throw new AiModelError('permission denied', false, 'MOCK_FATAL');
      }
    };
    processor = new AiTaskProcessor(fixture.dataSource, {
      record: vi.fn(async () => ({ id: randomUUID() }))
    } as never, failingModel, makeMapper(), new AiTaskEventBus());

    await expect(processor.process(makeJob(task.id, 0))).rejects.toBeInstanceOf(UnrecoverableError);

    const stored = await fixture.dataSource.getRepository(AiTaskEntity).findOneByOrFail({ id: task.id });
    expect(stored.status).toBe('failed');
    expect(stored.error).toMatchObject({ code: 'MOCK_FATAL', retryable: false });
  });

  it('skips result landing when the task is cancelled during execution', async () => {
    const task = await createQueuedTask();
    const model = {
      async generate(): Promise<{ candidateDocument: ProseMirrorNode }> {
        // 模拟执行期间被取消：置为 cancelled
        await fixture.dataSource.getRepository(AiTaskEntity).update({ id: task.id }, { status: 'cancelled' });
        return { candidateDocument: { type: 'doc', content: [] } };
      }
    };
    processor = new AiTaskProcessor(fixture.dataSource, {
      record: vi.fn(async () => ({ id: randomUUID() }))
    } as never, model, makeMapper(), new AiTaskEventBus());

    await processor.process(makeJob(task.id, 0));

    const stored = await fixture.dataSource.getRepository(AiTaskEntity).findOneByOrFail({ id: task.id });
    expect(stored.status).toBe('cancelled'); // 不覆盖取消状态
    expect(stored.result_revision_set_id).toBeNull();
    expect(mapperCalls).toBe(0);
  });

  it('skips execution when the task is already terminal (idempotent re-delivery)', async () => {
    const task = await createQueuedTask();
    await fixture.dataSource.getRepository(AiTaskEntity).update({ id: task.id }, { status: 'succeeded' });
    const model = new MockAiModelProvider();
    processor = new AiTaskProcessor(fixture.dataSource, {
      record: vi.fn(async () => ({ id: randomUUID() }))
    } as never, model, makeMapper(), new AiTaskEventBus());

    await processor.process(makeJob(task.id, 0));

    const stored = await fixture.dataSource.getRepository(AiTaskEntity).findOneByOrFail({ id: task.id });
    expect(stored.status).toBe('succeeded');
    expect(mapperCalls).toBe(0); // 未重复执行
  });
});
