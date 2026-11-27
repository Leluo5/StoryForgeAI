import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { AiTaskService, type AiTaskQueuePort } from '../ai/ai-task.service';
import { AiTaskEventBus } from '../ai/ai-task.sse';
import { AgentService } from '../agent/agent.service';
import { CharacterMapService, CHARACTER_MAP_TOOL } from './character-map.service';
import { AiTaskEntity } from '../database/ai-task.entity';

let fixture: WritingFixture;
let service: CharacterMapService;
let enqueued: string[];

beforeEach(async () => {
  fixture = await createWritingFixture();
  enqueued = [];
  const queue: AiTaskQueuePort = {
    enqueue: vi.fn(async (taskId: string) => { enqueued.push(taskId); }),
    remove: vi.fn(async () => undefined)
  };
  const aiTaskService = new AiTaskService(
    fixture.dataSource,
    { record: vi.fn(async () => ({ id: 'audit-1', action: 'ai_task_create', target_type: 'ai_task', target_id: 't-1', detail: {}, actor_id: fixture.authorId, created_at: new Date().toISOString() })) } as never,
    queue,
    new AiTaskEventBus(),
    new AgentService(fixture.dataSource, { record: vi.fn() } as never, {} as never, {} as never, {} as never, {} as never)
  );
  service = new CharacterMapService(fixture.dataSource, aiTaskService);
});

afterEach(() => destroyWritingFixture(fixture));

describe('CharacterMapService', () => {
  it('发起建图：创建 scope=character_map 的排队任务并入队', async () => {
    const { aiTaskId } = await service.generate(fixture.authorId, fixture.workId);
    const task = await fixture.dataSource.getRepository(AiTaskEntity).findOneByOrFail({ id: aiTaskId });
    expect(task.scope).toBe('character_map');
    expect(task.tool).toBe(CHARACTER_MAP_TOOL);
    expect(task.chapter_id).toBeNull();
    expect(task.base_version).toBe(0);
    expect(task.status).toBe('queued');
    expect(enqueued).toEqual([aiTaskId]);
  });

  it('重复发起（同幂等键）返回既有任务不重复入队', async () => {
    const first = await service.generate(fixture.authorId, fixture.workId);
    enqueued.length = 0;
    const second = await service.generate(fixture.authorId, fixture.workId);
    expect(second.aiTaskId).toBe(first.aiTaskId);
    expect(enqueued).toEqual([]);
  });

  it('作品不存在 → 404', async () => {
    await expect(service.generate(fixture.authorId, randomUUID())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('查询任务归属校验：非作者作品 → 404', async () => {
    const { aiTaskId } = await service.generate(fixture.authorId, fixture.workId);
    await expect(service.getTask(fixture.otherAuthorId, fixture.workId, aiTaskId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('查询任务：作者可读且返回 AiTask', async () => {
    const { aiTaskId } = await service.generate(fixture.authorId, fixture.workId);
    const task = await service.getTask(fixture.authorId, fixture.workId, aiTaskId);
    expect(task.id).toBe(aiTaskId);
    expect(task.scope).toBe('character_map');
  });
});
