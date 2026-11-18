import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { PlotTreeService } from './plot-tree.service';
import { PlotTaskHandler, type PlotStepCandidate } from './plot-task.handler';
import { DerivationSessionEntity } from '../database/derivation-session.entity';
import { DerivationStepEntity } from '../database/derivation-step.entity';

let fixture: WritingFixture;
let handler: PlotTaskHandler;
let sessionId: string;

const candidate: PlotStepCandidate = {
  content: '主角在雨夜追踪陌生信使，发现密信。',
  event: { title: '意外遭遇', description: '信使突然折返' },
  new_characters: [{ name: '信使', description: '沉默寡言' }],
  branches: [
    { id: 'branch_a', label: '继续跟踪', description: '' },
    { id: 'branch_b', label: '当场拦下', description: '' }
  ]
};

beforeEach(async () => {
  fixture = await createWritingFixture();
  handler = new PlotTaskHandler();
  const plotTree = new PlotTreeService(fixture.dataSource, { record: vi.fn() } as never);
  const tree = await plotTree.createTree(fixture.authorId, fixture.workId, { title: '主线' });
  const created = await plotTree.createNode(fixture.authorId, fixture.workId, {
    title: '起点',
    position: { x: 0, y: 0 }
  });
  const session = await fixture.dataSource.getRepository(DerivationSessionEntity).save({
    id: randomUUID(),
    work_id: fixture.workId,
    tree_id: tree.tree!.id,
    start_node_id: created.node.id,
    place: '临江城',
    background: '雨季，主角追查一桩失踪案。',
    time_node: '第三日黄昏',
    premise_node_ids: [],
    related_node_ids: [],
    characters: [{ name: '主角', description: '冷静的捕快' }],
    status: 'running',
    step_index: 0
  });
  sessionId = session.id;
});

afterEach(() => destroyWritingFixture(fixture));

describe('PlotTaskHandler', () => {
  it('writes a derivation step and pauses the session at the new step index', async () => {
    const taskId = randomUUID();
    const result = await fixture.dataSource.transaction((manager) =>
      handler.writeStep(manager, {
        taskId,
        sessionId,
        workId: fixture.workId,
        stepNo: 1,
        candidate
      })
    );

    expect(result.created).toBe(true);
    expect(result.step_no).toBe(1);

    const step = await fixture.dataSource
      .getRepository(DerivationStepEntity)
      .findOneByOrFail({ session_id: sessionId, step_no: 1 });
    expect(step.id).toBe(result.step_id);
    expect(step.task_id).toBe(taskId);
    expect(step.content).toBe(candidate.content);
    expect(step.branches).toHaveLength(2);
    expect(step.new_characters).toHaveLength(1);

    const session = await fixture.dataSource
      .getRepository(DerivationSessionEntity)
      .findOneByOrFail({ id: sessionId });
    expect(session.status).toBe('paused');
    expect(session.step_index).toBe(1);
  });

  it('is idempotent for a repeated step number', async () => {
    const input = {
      taskId: randomUUID(),
      sessionId,
      workId: fixture.workId,
      stepNo: 2,
      candidate
    };
    const first = await fixture.dataSource.transaction((manager) => handler.writeStep(manager, input));
    const second = await fixture.dataSource.transaction((manager) => handler.writeStep(manager, input));

    expect(second.created).toBe(false);
    expect(second.step_id).toBe(first.step_id);
    const count = await fixture.dataSource
      .getRepository(DerivationStepEntity)
      .countBy({ session_id: sessionId, step_no: 2 });
    expect(count).toBe(1);
  });

  it('rejects an unknown session', async () => {
    await expect(
      fixture.dataSource.transaction((manager) =>
        handler.writeStep(manager, {
          taskId: randomUUID(),
          sessionId: randomUUID(),
          workId: fixture.workId,
          stepNo: 1,
          candidate
        })
      )
    ).rejects.toThrow();
  });
});
