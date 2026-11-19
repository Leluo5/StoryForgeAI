import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { PlotTreeService } from './plot-tree.service';
import { PlotDerivationService } from './plot-derivation.service';
import { AgentService } from '../agent/agent.service';
import { AiTaskEventBus } from '../ai/ai-task.sse';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AiTaskEventEntity } from '../database/ai-task-event.entity';
import { DerivationStepEntity } from '../database/derivation-step.entity';
import { DerivationCandidateEntity } from '../database/derivation-candidate.entity';

let fixture: WritingFixture;
let plotTree: PlotTreeService;
let service: PlotDerivationService;
let enqueued: string[];
let startNodeId: string;
let treeId: string;

function buildService(): PlotDerivationService {
  const audit = { record: vi.fn(async () => ({ id: randomUUID() })) };
  const agentService = new AgentService(fixture.dataSource, audit as never, {} as never, {} as never, {} as never, {} as never);
  const queue = {
    enqueue: vi.fn(async (taskId: string) => {
      enqueued.push(taskId);
    }),
    remove: vi.fn(async () => undefined)
  };
  return new PlotDerivationService(fixture.dataSource, audit as never, agentService, queue, new AiTaskEventBus());
}

beforeEach(async () => {
  fixture = await createWritingFixture();
  plotTree = new PlotTreeService(fixture.dataSource, { record: vi.fn() } as never);
  const tree = await plotTree.createTree(fixture.authorId, fixture.workId, { title: '主线' });
  treeId = tree.tree!.id;
  const start = await plotTree.createNode(fixture.authorId, fixture.workId, {
    title: '起点',
    content: '雨夜',
    position: { x: 100, y: 50 }
  });
  startNodeId = start.node.id;
  await plotTree.createNode(fixture.authorId, fixture.workId, {
    title: '前情',
    summary: '主角接到委托',
    position: { x: 0, y: 0 }
  });
  enqueued = [];
  service = buildService();
});

afterEach(() => destroyWritingFixture(fixture));

async function createSession() {
  const premise = await fixture.dataSource
    .getRepository('PlotNodeEntity')
    .findOneByOrFail({ tree_id: treeId, title: '前情' });
  return service.createSession(fixture.authorId, fixture.workId, {
    start_node_id: startNodeId,
    place: '临江城',
    background: '雨季，主角追查一桩失踪案。',
    time_node: '第三日黄昏',
    premise_node_ids: [premise.id as string],
    related_node_ids: [],
    characters: [{ name: '主角', description: '冷静的捕快' }],
    random_enabled: true,
    random_character_enabled: false
  });
}

async function seedSteps(sessionId: string, count: number): Promise<void> {
  const repository = fixture.dataSource.getRepository(DerivationStepEntity);
  for (let index = 1; index <= count; index += 1) {
    await repository.save(
      repository.create({
        id: randomUUID(),
        session_id: sessionId,
        step_no: index,
        content: `第 ${index} 步内容`,
        event: index === 1 ? { title: '意外', description: '突发' } : null,
        new_characters: [],
        branches: [
          { id: 'branch_a', label: '追查', description: '' },
          { id: 'branch_b', label: '对峙', description: '' }
        ],
        chosen_branch_id: null,
        task_id: null
      })
    );
  }
}

describe('PlotDerivationService', () => {
  it('creates a session bound to the start node and returns it with empty steps', async () => {
    const { session } = await createSession();
    expect(session.start_node_id).toBe(startNodeId);
    expect(session.status).toBe('idle');
    expect(session.step_index).toBe(0);
    expect(session.characters).toHaveLength(1);

    const detail = await service.getSession(fixture.authorId, fixture.workId, session.id);
    expect(detail.steps).toEqual([]);
    expect(detail.candidates).toEqual([]);
  });

  it('rejects a start node that does not belong to the work tree', async () => {
    await expect(
      service.createSession(fixture.authorId, fixture.workId, {
        start_node_id: randomUUID(),
        place: '别处',
        background: '背景',
        characters: [{ name: '甲', description: '' }]
      })
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('enqueues a plot task with the next step number and marks the session running', async () => {
    const { session } = await createSession();
    const result = await service.generateStep(fixture.authorId, fixture.workId, session.id);

    expect(result.task.scope).toBe('plot');
    expect(result.task.chapter_id).toBeNull();
    expect(result.task.status).toBe('queued');
    expect(result.session.status).toBe('running');
    expect(enqueued).toEqual([result.task.id]);

    const stored = await fixture.dataSource.getRepository(AiTaskEntity).findOneByOrFail({ id: result.task.id });
    expect(stored.input_summary).toMatchObject({
      session_id: session.id,
      step_no: 1,
      place: '临江城',
      time_node: '第三日黄昏',
      random_character_enabled: false
    });
    expect(Array.isArray(stored.input_summary.history)).toBe(true);

    const queued = await fixture.dataSource
      .getRepository(AiTaskEventEntity)
      .findOneBy({ task_id: result.task.id, type: 'queued' });
    expect(queued).not.toBeNull();
  });

  it('rejects a second step while a plot task is still pending', async () => {
    const { session } = await createSession();
    await service.generateStep(fixture.authorId, fixture.workId, session.id);
    await expect(service.generateStep(fixture.authorId, fixture.workId, session.id))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects step generation when the plot_derivation tool is disabled', async () => {
    const { session } = await createSession();
    await fixture.dataSource.query("UPDATE ai_tools SET enabled = false WHERE tool_id = 'plot_derivation'");
    await expect(service.generateStep(fixture.authorId, fixture.workId, session.id))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('updates step content and chosen branch, rejecting unknown branches', async () => {
    const { session } = await createSession();
    await seedSteps(session.id, 1);

    const updated = await service.updateStep(fixture.authorId, fixture.workId, session.id, 1, {
      content: '改写后的推进',
      chosen_branch_id: 'branch_b'
    });
    expect(updated.step.content).toBe('改写后的推进');
    expect(updated.step.chosen_branch_id).toBe('branch_b');

    await expect(
      service.updateStep(fixture.authorId, fixture.workId, session.id, 1, { chosen_branch_id: 'nope' })
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('builds a merged candidate when split_by_step is false and supersedes the pending one', async () => {
    const { session } = await createSession();
    await seedSteps(session.id, 2);

    const first = await service.createCandidate(fixture.authorId, fixture.workId, session.id, {
      placement: 'child'
    });
    expect(first.candidate.payload.nodes).toHaveLength(1);
    expect(first.candidate.payload.nodes[0]!.content).toContain('第 1 步内容');
    expect(first.candidate.payload.nodes[0]!.content).toContain('第 2 步内容');
    expect(first.candidate.status).toBe('pending');

    const second = await service.createCandidate(fixture.authorId, fixture.workId, session.id, {
      placement: 'child'
    });
    const previous = await fixture.dataSource
      .getRepository(DerivationCandidateEntity)
      .findOneByOrFail({ id: first.candidate.id });
    expect(previous.status).toBe('rejected');
    expect(second.candidate.status).toBe('pending');
  });

  it('chains nodes by parent_index when split_by_step is true', async () => {
    const { session } = await createSession();
    await seedSteps(session.id, 2);

    const { candidate } = await service.createCandidate(fixture.authorId, fixture.workId, session.id, {
      placement: 'child',
      split_by_step: true
    });
    expect(candidate.payload.nodes).toHaveLength(2);
    expect(candidate.payload.nodes[0]!.parent_index).toBeNull();
    expect(candidate.payload.nodes[1]!.parent_index).toBe(0);
  });

  it('rejects candidate creation when the session has no steps', async () => {
    const { session } = await createSession();
    await expect(
      service.createCandidate(fixture.authorId, fixture.workId, session.id, { placement: 'child' })
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('confirms a candidate by writing a child node and is idempotent on repeat', async () => {
    const { session } = await createSession();
    await seedSteps(session.id, 1);
    const { candidate } = await service.createCandidate(fixture.authorId, fixture.workId, session.id, {
      placement: 'child'
    });
    const before = await plotTree.getTree(fixture.authorId, fixture.workId);

    const confirmed = await service.confirmCandidate(fixture.authorId, fixture.workId, session.id, candidate.id, {});
    expect(confirmed.nodes).toHaveLength(1);
    expect(confirmed.nodes[0]!.parent_id).toBe(startNodeId);
    expect(confirmed.nodes[0]!.origin).toBe('derivation');
    expect(confirmed.version).toBe(before.tree!.version + 1);

    const repeat = await service.confirmCandidate(fixture.authorId, fixture.workId, session.id, candidate.id, {});
    expect(repeat.nodes.map((node) => node.id)).toEqual(confirmed.nodes.map((node) => node.id));

    const tree = await plotTree.getTree(fixture.authorId, fixture.workId);
    expect(tree.nodes).toHaveLength(before.nodes.length + 1);
  });

  it('refuses confirmation when the start node has been deleted', async () => {
    const { session } = await createSession();
    await seedSteps(session.id, 1);
    const { candidate } = await service.createCandidate(fixture.authorId, fixture.workId, session.id, {
      placement: 'child'
    });
    await plotTree.deleteNode(fixture.authorId, fixture.workId, startNodeId);

    await expect(
      service.confirmCandidate(fixture.authorId, fixture.workId, session.id, candidate.id, {})
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('inserts sibling placement right after the start node', async () => {
    const sibling = await plotTree.createNode(fixture.authorId, fixture.workId, {
      title: '后一个',
      position: { x: 300, y: 0 }
    });
    const { session } = await createSession();
    await seedSteps(session.id, 1);
    const { candidate } = await service.createCandidate(fixture.authorId, fixture.workId, session.id, {
      placement: 'sibling'
    });

    const confirmed = await service.confirmCandidate(fixture.authorId, fixture.workId, session.id, candidate.id, {});
    const created = confirmed.nodes[0]!;
    expect(created.parent_id).toBeNull();
    expect(created.sibling_order).toBe(1);

    const tree = await plotTree.getTree(fixture.authorId, fixture.workId);
    const shifted = tree.nodes.find((node) => node.id === sibling.node.id)!;
    expect(shifted.sibling_order).toBe(sibling.node.sibling_order + 1);
  });

  it('rejects a candidate and refuses to confirm it afterwards', async () => {
    const { session } = await createSession();
    await seedSteps(session.id, 1);
    const { candidate } = await service.createCandidate(fixture.authorId, fixture.workId, session.id, {
      placement: 'child'
    });

    const rejected = await service.rejectCandidate(fixture.authorId, fixture.workId, session.id, candidate.id);
    expect(rejected.candidate.status).toBe('rejected');
    // 幂等
    const again = await service.rejectCandidate(fixture.authorId, fixture.workId, session.id, candidate.id);
    expect(again.candidate.status).toBe('rejected');

    await expect(
      service.confirmCandidate(fixture.authorId, fixture.workId, session.id, candidate.id, {})
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
