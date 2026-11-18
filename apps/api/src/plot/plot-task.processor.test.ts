import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import type { Job } from 'bullmq';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { AiTaskProcessor, type AiResultMapperPort } from '../ai/ai-task.processor';
import { MockAiModelProvider } from '../ai/ai-model.provider';
import { AiTaskEventBus } from '../ai/ai-task.sse';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AiTaskEventEntity } from '../database/ai-task-event.entity';
import { DerivationSessionEntity } from '../database/derivation-session.entity';
import { DerivationStepEntity } from '../database/derivation-step.entity';
import { PlotTreeService } from './plot-tree.service';
import { PlotTaskHandler } from './plot-task.handler';
import { MockPlotModelProvider, PlotModelError } from './plot-model.provider';

let fixture: WritingFixture;
let sessionId: string;

function makeJob(taskId: string, attemptsMade = 0, totalAttempts = 3): Job<{ taskId: string }> {
  return { data: { taskId }, attemptsMade, opts: { attempts: totalAttempts } } as unknown as Job<{ taskId: string }>;
}

/** 章节映射器在剧情任务中不应被调用 */
function forbiddenMapper(): AiResultMapperPort {
  return {
    async toAiRevisionSet(): Promise<never> {
      throw new Error('chapter mapper must not run for plot tasks');
    }
  };
}

function buildProcessor(model = new MockPlotModelProvider()): AiTaskProcessor {
  return new AiTaskProcessor(
    fixture.dataSource,
    { record: vi.fn(async () => ({ id: randomUUID() })) } as never,
    new MockAiModelProvider(),
    forbiddenMapper(),
    new AiTaskEventBus(),
    model,
    new PlotTaskHandler()
  );
}

async function createPlotTask(stepNo = 1): Promise<AiTaskEntity> {
  const repository = fixture.dataSource.getRepository(AiTaskEntity);
  return repository.save(
    repository.create({
      id: randomUUID(),
      idempotency_key: `plot-${randomUUID()}`,
      work_id: fixture.workId,
      chapter_id: null,
      scope: 'plot',
      tool: 'plot_derivation',
      agent_id: null,
      input_summary: { session_id: sessionId, step_no: stepNo, history: [] },
      base_version: 0,
      status: 'queued',
      event_seq: 0,
      result_revision_set_id: null,
      error: null,
      attempts: 0,
      created_by: fixture.authorId
    })
  );
}

beforeEach(async () => {
  fixture = await createWritingFixture();
  const plotTree = new PlotTreeService(fixture.dataSource, { record: vi.fn() } as never);
  const tree = await plotTree.createTree(fixture.authorId, fixture.workId, { title: '主线' });
  const start = await plotTree.createNode(fixture.authorId, fixture.workId, {
    title: '起点',
    position: { x: 0, y: 0 }
  });
  const premise = await plotTree.createNode(fixture.authorId, fixture.workId, {
    title: '前情',
    summary: '主角接到委托',
    position: { x: 0, y: 0 }
  });
  const session = await fixture.dataSource.getRepository(DerivationSessionEntity).save({
    id: randomUUID(),
    work_id: fixture.workId,
    tree_id: tree.tree!.id,
    start_node_id: start.node.id,
    place: '临江城',
    background: '雨季，主角追查一桩失踪案。',
    time_node: '第三日黄昏',
    premise_node_ids: [premise.node.id],
    related_node_ids: [],
    characters: [{ name: '主角', description: '冷静的捕快' }],
    random_enabled: true,
    random_character_enabled: true,
    status: 'running',
    step_index: 0
  });
  sessionId = session.id;
});

afterEach(() => destroyWritingFixture(fixture));

describe('AiTaskProcessor (plot scope)', () => {
  it('runs a plot task to success and lands a derivation step without touching chapters', async () => {
    const task = await createPlotTask(1);
    const processor = buildProcessor();

    await processor.process(makeJob(task.id));

    const stored = await fixture.dataSource.getRepository(AiTaskEntity).findOneByOrFail({ id: task.id });
    expect(stored.status).toBe('succeeded');
    expect(stored.attempts).toBe(1);
    expect(stored.result_revision_set_id).toBeNull();

    const step = await fixture.dataSource
      .getRepository(DerivationStepEntity)
      .findOneByOrFail({ session_id: sessionId, step_no: 1 });
    expect(step.task_id).toBe(task.id);
    expect(step.branches).toHaveLength(2);

    const session = await fixture.dataSource
      .getRepository(DerivationSessionEntity)
      .findOneByOrFail({ id: sessionId });
    expect(session.status).toBe('paused');
    expect(session.step_index).toBe(1);

    const succeeded = await fixture.dataSource
      .getRepository(AiTaskEventEntity)
      .findOneBy({ task_id: task.id, type: 'succeeded' });
    expect(succeeded!.payload.step_id).toBe(step.id);
    expect(succeeded!.payload.session_id).toBe(sessionId);
  });

  it('feeds premise summaries and characters into the plot model context', async () => {
    const task = await createPlotTask(1);
    const model = new MockPlotModelProvider();
    const seen: unknown[] = [];
    const spy = {
      async generateStep(ctx: never) {
        seen.push(ctx);
        return model.generateStep(ctx);
      }
    };
    const processor = buildProcessor(spy as never);

    await processor.process(makeJob(task.id));

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      place: '临江城',
      timeNode: '第三日黄昏',
      characters: [{ name: '主角', description: '冷静的捕快' }],
      premiseNodes: [{ title: '前情', summary: '主角接到委托' }]
    });
  });

  it('keeps the task running for a retryable plot model error on a non-final attempt', async () => {
    const task = await createPlotTask(1);
    const processor = buildProcessor(new MockPlotModelProvider({ fail: true }));

    await expect(processor.process(makeJob(task.id, 0, 3))).rejects.toBeInstanceOf(PlotModelError);

    const stored = await fixture.dataSource.getRepository(AiTaskEntity).findOneByOrFail({ id: task.id });
    expect(stored.status).toBe('running');
    expect(stored.error).toBeNull();
    const steps = await fixture.dataSource
      .getRepository(DerivationStepEntity)
      .countBy({ session_id: sessionId });
    expect(steps).toBe(0);
  });

  it('marks the task failed on the final attempt', async () => {
    const task = await createPlotTask(1);
    const processor = buildProcessor(new MockPlotModelProvider({ fail: true }));

    await expect(processor.process(makeJob(task.id, 2, 3))).rejects.toBeInstanceOf(PlotModelError);

    const stored = await fixture.dataSource.getRepository(AiTaskEntity).findOneByOrFail({ id: task.id });
    expect(stored.status).toBe('failed');
    expect(stored.error).toMatchObject({ code: 'MOCK_PLOT_FAIL', retryable: true });
  });
});
