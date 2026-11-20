import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { AiTaskService, type AiTaskQueuePort } from './ai-task.service';
import { AiTaskEventBus } from './ai-task.sse';
import { AgentService } from '../agent/agent.service';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AiTaskEventEntity } from '../database/ai-task-event.entity';
import { RevisionSetEntity } from '../database/revision-set.entity';

let fixture: WritingFixture;
let service: AiTaskService;
let queue: AiTaskQueuePort;
let enqueued: string[];
let removed: string[];

function idempotencyKey(): string {
  return `m3a-a4-${randomUUID()}`;
}

beforeEach(async () => {
  fixture = await createWritingFixture();
  enqueued = [];
  removed = [];
  queue = {
    enqueue: vi.fn(async (taskId: string) => { enqueued.push(taskId); }),
    remove: vi.fn(async (taskId: string) => { removed.push(taskId); })
  };
  service = new AiTaskService(fixture.dataSource, {
    record: vi.fn(async () => ({ id: randomUUID(), action: 'ai_task_create', target_type: 'ai_task', target_id: randomUUID(), detail: {}, actor_id: fixture.authorId, created_at: new Date().toISOString() }))
  } as never, queue, new AiTaskEventBus(),
  new AgentService(fixture.dataSource, { record: vi.fn() } as never, {} as never, {} as never, {} as never, {} as never));
});

afterEach(() => destroyWritingFixture(fixture));

describe('AiTaskService', () => {
  it('creates a queued task, writes a queued event and enqueues the job', async () => {
    const key = idempotencyKey();
    const { task } = await service.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'continue',
      input_summary: { selection: { from: 0, to: 10 } },
      idempotency_key: key
    });

    expect(task.status).toBe('queued');
    expect(task.tool).toBe('continue');
    expect(task.base_version).toBe(0);
    expect(task.event_seq).toBe(1);
    expect(enqueued).toEqual([task.id]);

    const events = await fixture.dataSource.getRepository(AiTaskEventEntity).findBy({ task_id: task.id });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe('queued');
    expect(event.event_seq).toBe(1);

    const stored = await fixture.dataSource.getRepository(AiTaskEntity).findOneByOrFail({ id: task.id });
    expect(stored.idempotency_key).toBe(key);
    expect(stored.created_by).toBe(fixture.authorId);
  });

  it('returns the existing task with its result when the idempotency key is reused after success', async () => {
    const key = idempotencyKey();
    const first = await service.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'continue', input_summary: {}, idempotency_key: key
    });
    // 插入真实 revision_set（result_revision_set_id 有 FK 约束）
    const revisionSet = await fixture.dataSource.getRepository(RevisionSetEntity).save(
      fixture.dataSource.getRepository(RevisionSetEntity).create({
        id: randomUUID(),
        chapter_id: fixture.chapterId,
        base_version: 0,
        actor_type: 'ai',
        actor_id: null,
        operations: [{ index: 0, step: 'replace', from: 0, to: 1 }],
        status: 'pending',
        ai_set: true
      })
    );
    const repo = fixture.dataSource.getRepository(AiTaskEntity);
    const stored = await repo.findOneByOrFail({ id: first.task.id });
    stored.status = 'succeeded';
    stored.result_revision_set_id = revisionSet.id;
    await repo.save(stored);

    // 幂等键复用：直接返回已有结果，不重复执行
    const second = await service.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'continue', input_summary: {}, idempotency_key: key
    });
    expect(second.task.id).toBe(first.task.id);
    expect(second.task.status).toBe('succeeded');
    expect(second.task.result_revision_set_id).toBe(revisionSet.id);
    expect(enqueued).toHaveLength(1); // 未重复入队
  });

  it('rejects a reused idempotency key while the task is queued', async () => {
    const key = idempotencyKey();
    const first = await service.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'continue', input_summary: {}, idempotency_key: key
    });
    expect(first.task.status).toBe('queued');

    await expect(service.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'continue', input_summary: {}, idempotency_key: key
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects a reused idempotency key after failure with retryable flag', async () => {
    const key = idempotencyKey();
    const first = await service.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'continue', input_summary: {}, idempotency_key: key
    });
    const repo = fixture.dataSource.getRepository(AiTaskEntity);
    const stored = await repo.findOneByOrFail({ id: first.task.id });
    stored.status = 'failed';
    await repo.save(stored);

    await expect(service.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'continue', input_summary: {}, idempotency_key: key
    })).rejects.toMatchObject({ response: { details: { retryable: true } } });
  });

  it('rejects when the chapter does not belong to the work', async () => {
    await expect(service.createTask(fixture.authorId, randomUUID(), fixture.chapterId, {
      tool: 'continue', input_summary: {}, idempotency_key: idempotencyKey()
    })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects when the author does not own the work', async () => {
    await expect(service.createTask(fixture.otherAuthorId, fixture.workId, fixture.chapterId, {
      tool: 'continue', input_summary: {}, idempotency_key: idempotencyKey()
    })).rejects.toBeInstanceOf(NotFoundException);
  });

  it('gets a task within the work scope', async () => {
    const { task } = await service.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'rewrite', input_summary: {}, idempotency_key: idempotencyKey()
    });
    const got = await service.getTask(fixture.authorId, fixture.workId, task.id);
    expect(got.task.id).toBe(task.id);
    expect(got.task.tool).toBe('rewrite');
  });

  it('rejects getting a task from another work', async () => {
    const { task } = await service.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'continue', input_summary: {}, idempotency_key: idempotencyKey()
    });
    await expect(service.getTask(fixture.authorId, randomUUID(), task.id)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists tasks with status filter and pagination', async () => {
    await service.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'continue', input_summary: {}, idempotency_key: idempotencyKey()
    });
    await service.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'polish', input_summary: {}, idempotency_key: idempotencyKey()
    });
    const all = await service.listTasks(fixture.authorId, fixture.workId, fixture.chapterId, {});
    expect(all.total).toBe(2);
    expect(all.tasks).toHaveLength(2);

    const queued = await service.listTasks(fixture.authorId, fixture.workId, fixture.chapterId, { status: 'queued' });
    expect(queued.total).toBe(2);

    await service.listTasks(fixture.authorId, fixture.workId, fixture.chapterId, { page: 1, page_size: 1 });
    const page = await service.listTasks(fixture.authorId, fixture.workId, fixture.chapterId, { page: 1, page_size: 1 });
    expect(page.tasks).toHaveLength(1);
  });

  it('retries a failed task and re-enqueues it', async () => {
    const { task } = await service.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'continue', input_summary: {}, idempotency_key: idempotencyKey()
    });
    const repo = fixture.dataSource.getRepository(AiTaskEntity);
    const stored = await repo.findOneByOrFail({ id: task.id });
    stored.status = 'failed';
    stored.error = { message: 'model timeout', retryable: true };
    await repo.save(stored);

    enqueued.length = 0;
    const retried = await service.retryTask(fixture.authorId, fixture.workId, task.id);
    expect(retried.task.status).toBe('queued');
    expect(retried.task.error).toBeNull();
    expect(enqueued).toContain(task.id);

    const events = await fixture.dataSource.getRepository(AiTaskEventEntity).findBy({ task_id: task.id });
    const last = events[events.length - 1]!;
    expect(last.type).toBe('queued');
  });

  it('rejects retrying a task that is not failed/cancelled', async () => {
    const { task } = await service.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'continue', input_summary: {}, idempotency_key: idempotencyKey()
    });
    await expect(service.retryTask(fixture.authorId, fixture.workId, task.id))
      .rejects.toMatchObject({ response: { details: { current_status: 'queued' } } });
  });

  it('cancels a queued task and removes it from the queue', async () => {
    const { task } = await service.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'continue', input_summary: {}, idempotency_key: idempotencyKey()
    });
    const cancelled = await service.cancelTask(fixture.authorId, fixture.workId, task.id);
    expect(cancelled.task.status).toBe('cancelled');
    expect(removed).toContain(task.id);

    const events = await fixture.dataSource.getRepository(AiTaskEventEntity).findBy({ task_id: task.id });
    const last = events[events.length - 1]!;
    expect(last.type).toBe('cancelled');
  });

  it('is idempotent when cancelling an already cancelled task', async () => {
    const { task } = await service.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'continue', input_summary: {}, idempotency_key: idempotencyKey()
    });
    await service.cancelTask(fixture.authorId, fixture.workId, task.id);
    removed.length = 0;
    const again = await service.cancelTask(fixture.authorId, fixture.workId, task.id);
    expect(again.task.status).toBe('cancelled');
    expect(removed).toHaveLength(0); // 幂等：不再重复移除
  });

  it('rejects cancelling a task that already succeeded', async () => {
    const { task } = await service.createTask(fixture.authorId, fixture.workId, fixture.chapterId, {
      tool: 'continue', input_summary: {}, idempotency_key: idempotencyKey()
    });
    // 插入真实 revision_set（result_revision_set_id 有 FK 约束）
    const revisionSet = await fixture.dataSource.getRepository(RevisionSetEntity).save(
      fixture.dataSource.getRepository(RevisionSetEntity).create({
        id: randomUUID(),
        chapter_id: fixture.chapterId,
        base_version: 0,
        actor_type: 'ai',
        actor_id: null,
        operations: [{ index: 0, step: 'replace', from: 0, to: 1 }],
        status: 'pending',
        ai_set: true
      })
    );
    const repo = fixture.dataSource.getRepository(AiTaskEntity);
    const stored = await repo.findOneByOrFail({ id: task.id });
    stored.status = 'succeeded';
    stored.result_revision_set_id = revisionSet.id;
    await repo.save(stored);

    await expect(service.cancelTask(fixture.authorId, fixture.workId, task.id))
      .rejects.toMatchObject({ response: { details: { current_status: 'succeeded' } } });
  });
});
