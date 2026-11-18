import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type {
  CandidateStatus,
  DerivationCandidate,
  DerivationSession,
  DerivationStatus,
  DerivationStep,
  PlotNode,
  PlotTreeDraftPayload
} from '@storyforge/contracts';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AiTaskEventEntity } from '../database/ai-task-event.entity';
import { DerivationCandidateEntity } from '../database/derivation-candidate.entity';
import { DerivationSessionEntity } from '../database/derivation-session.entity';
import { DerivationStepEntity } from '../database/derivation-step.entity';
import { PlotNodeEntity } from '../database/plot-node.entity';
import { PlotTreeEntity } from '../database/plot-tree.entity';
import { WorkEntity } from '../database/work.entity';
import { AuditService } from '../revision/audit.service';
import { AgentService } from '../agent/agent.service';
import { AI_TASK_QUEUE, type AiTaskQueuePort } from '../ai/ai-task.service';
import { AiTaskEventBus, AI_TASK_EVENT_BUS } from '../ai/ai-task.sse';

export const PLOT_DERIVATION_TOOL = 'plot_derivation';

export interface CreateDerivationSessionInput {
  start_node_id: string;
  place: string;
  background: string;
  time_node?: string | null | undefined;
  premise_node_ids?: string[] | undefined;
  related_node_ids?: string[] | undefined;
  characters: Array<{ name: string; description: string }>;
  random_enabled?: boolean | undefined;
  random_character_enabled?: boolean | undefined;
}

export interface UpdateDerivationSessionInput {
  place?: string | undefined;
  background?: string | undefined;
  time_node?: string | null | undefined;
  premise_node_ids?: string[] | undefined;
  related_node_ids?: string[] | undefined;
  characters?: Array<{ name: string; description: string }> | undefined;
  random_enabled?: boolean | undefined;
  random_character_enabled?: boolean | undefined;
  status?: 'paused' | 'finished' | undefined;
}

export interface UpdateDerivationStepInput {
  content?: string | undefined;
  chosen_branch_id?: string | null | undefined;
}

export interface CreateDerivationCandidateInput {
  split_by_step?: boolean | undefined;
  placement: 'child' | 'sibling';
  payload?: PlotTreeDraftPayload | undefined;
}

export interface ConfirmDerivationCandidateInput {
  expected_version?: number | undefined;
}

export interface AiTaskView {
  id: string;
  idempotency_key: string;
  work_id: string;
  chapter_id: string | null;
  scope: 'chapter' | 'plot';
  tool: string;
  agent_id: string | null;
  input_summary: Record<string, unknown>;
  base_version: number;
  status: string;
  event_seq: number;
  result_revision_set_id: string | null;
  error: Record<string, unknown> | null;
  attempts: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function toAiTaskView(task: AiTaskEntity): AiTaskView {
  return {
    id: task.id,
    idempotency_key: task.idempotency_key,
    work_id: task.work_id,
    chapter_id: task.chapter_id,
    scope: task.scope,
    tool: task.tool,
    agent_id: task.agent_id,
    input_summary: task.input_summary,
    base_version: task.base_version,
    status: task.status,
    event_seq: task.event_seq,
    result_revision_set_id: task.result_revision_set_id,
    error: task.error,
    attempts: task.attempts,
    created_by: task.created_by,
    created_at: task.created_at.toISOString(),
    updated_at: task.updated_at.toISOString()
  };
}

function mapSession(session: DerivationSessionEntity): DerivationSession {
  return {
    id: session.id,
    work_id: session.work_id,
    tree_id: session.tree_id,
    start_node_id: session.start_node_id,
    place: session.place,
    background: session.background,
    time_node: session.time_node,
    premise_node_ids: session.premise_node_ids,
    related_node_ids: session.related_node_ids,
    characters: session.characters,
    random_enabled: session.random_enabled,
    random_character_enabled: session.random_character_enabled,
    status: session.status as DerivationStatus,
    step_index: session.step_index,
    created_at: session.created_at.toISOString(),
    updated_at: session.updated_at.toISOString()
  };
}

function mapStep(step: DerivationStepEntity): DerivationStep {
  return {
    id: step.id,
    session_id: step.session_id,
    step_no: step.step_no,
    content: step.content,
    event: step.event as DerivationStep['event'],
    new_characters: step.new_characters as DerivationStep['new_characters'],
    branches: step.branches as DerivationStep['branches'],
    chosen_branch_id: step.chosen_branch_id,
    task_id: step.task_id,
    created_at: step.created_at.toISOString(),
    updated_at: step.updated_at.toISOString()
  };
}

function mapCandidate(candidate: DerivationCandidateEntity): DerivationCandidate {
  return {
    id: candidate.id,
    session_id: candidate.session_id,
    start_node_id: candidate.start_node_id,
    placement: candidate.placement,
    payload: candidate.payload as unknown as PlotTreeDraftPayload,
    status: candidate.status as CandidateStatus,
    confirmed_node_id: candidate.confirmed_node_id,
    created_at: candidate.created_at.toISOString(),
    confirmed_at: candidate.confirmed_at ? candidate.confirmed_at.toISOString() : null
  };
}

function mapNode(node: PlotNodeEntity): PlotNode {
  return {
    id: node.id,
    tree_id: node.tree_id,
    parent_id: node.parent_id,
    sibling_order: node.sibling_order,
    title: node.title,
    summary: node.summary,
    content: node.content,
    attributes: node.attributes as PlotNode['attributes'],
    position: { x: node.position_x, y: node.position_y },
    group_id: node.group_id,
    origin: node.origin as PlotNode['origin'],
    created_at: node.created_at.toISOString(),
    updated_at: node.updated_at.toISOString()
  };
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * 剧情推衍：会话 → 步骤（AI 任务异步生成）→ 候选 → 人工确认回写剧情树。
 * 回写必须人工确认；AI 结果只以候选形式存在。
 */
@Injectable()
export class PlotDerivationService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AgentService) private readonly agents: AgentService,
    @Inject(AI_TASK_QUEUE) private readonly queue: AiTaskQueuePort,
    @Inject(AI_TASK_EVENT_BUS) private readonly eventBus: AiTaskEventBus
  ) {}

  async createSession(
    authorId: string,
    workId: string,
    input: CreateDerivationSessionInput
  ): Promise<{ session: DerivationSession }> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      // 工具被禁用 → 409；缺失 → 404
      await this.agents.resolveToolForTask(PLOT_DERIVATION_TOOL);
      const tree = await this.assertOwnedTree(manager, authorId, workId);
      const nodeRepository = manager.getRepository(PlotNodeEntity);
      const start = await nodeRepository.findOneBy({ id: input.start_node_id, tree_id: tree.id });
      if (!start) throw new NotFoundException('Plot start node not found');

      const referenced = [...(input.premise_node_ids ?? []), ...(input.related_node_ids ?? [])];
      if (referenced.length > 0) {
        const found = await nodeRepository.count({
          where: referenced.map((id) => ({ id, tree_id: tree.id }))
        });
        if (found !== new Set(referenced).size) {
          throw new UnprocessableEntityException({ message: 'Plot node does not belong to the tree' });
        }
      }

      const repository = manager.getRepository(DerivationSessionEntity);
      const session = await repository.save(
        repository.create({
          id: randomUUID(),
          work_id: workId,
          tree_id: tree.id,
          start_node_id: start.id,
          place: input.place,
          background: input.background,
          time_node: input.time_node ?? null,
          premise_node_ids: input.premise_node_ids ?? [],
          related_node_ids: input.related_node_ids ?? [],
          characters: input.characters,
          random_enabled: input.random_enabled ?? true,
          random_character_enabled: input.random_character_enabled ?? true,
          status: 'idle',
          step_index: 0
        })
      );
      return { session: mapSession(session) };
    });
  }

  async getSession(
    authorId: string,
    workId: string,
    sessionId: string
  ): Promise<{ session: DerivationSession; steps: DerivationStep[]; candidates: DerivationCandidate[] }> {
    const session = await this.assertOwnedSession(this.dataSource.manager, authorId, workId, sessionId);
    const [steps, candidates] = await Promise.all([
      this.dataSource.getRepository(DerivationStepEntity).find({
        where: { session_id: sessionId },
        order: { step_no: 'ASC' }
      }),
      this.dataSource.getRepository(DerivationCandidateEntity).find({
        where: { session_id: sessionId },
        order: { created_at: 'DESC' }
      })
    ]);
    return {
      session: mapSession(session),
      steps: steps.map(mapStep),
      candidates: candidates.map(mapCandidate)
    };
  }

  async updateSession(
    authorId: string,
    workId: string,
    sessionId: string,
    input: UpdateDerivationSessionInput
  ): Promise<{ session: DerivationSession }> {
    return this.dataSource.transaction(async (manager) => {
      const session = await this.assertOwnedSession(manager, authorId, workId, sessionId, true);
      if (session.status === 'running' && input.status !== 'finished') {
        throw new ConflictException({ message: 'Session is running', details: { code: 'PLOT_SESSION_RUNNING' } });
      }
      if (input.place !== undefined) session.place = input.place;
      if (input.background !== undefined) session.background = input.background;
      if (input.time_node !== undefined) session.time_node = input.time_node;
      if (input.premise_node_ids !== undefined) session.premise_node_ids = input.premise_node_ids;
      if (input.related_node_ids !== undefined) session.related_node_ids = input.related_node_ids;
      if (input.characters !== undefined) session.characters = input.characters;
      if (input.random_enabled !== undefined) session.random_enabled = input.random_enabled;
      if (input.random_character_enabled !== undefined) {
        session.random_character_enabled = input.random_character_enabled;
      }
      if (input.status !== undefined) session.status = input.status;
      await manager.getRepository(DerivationSessionEntity).save(session);
      return { session: mapSession(session) };
    });
  }

  /** 发起下一步推衍：创建 scope='plot' 的 AI 任务并入队，状态置 running */
  async generateStep(
    authorId: string,
    workId: string,
    sessionId: string
  ): Promise<{ task: AiTaskView; session: DerivationSession }> {
    const result = await this.dataSource.transaction(async (manager) => {
      const session = await this.assertOwnedSession(manager, authorId, workId, sessionId, true);
      if (session.status === 'running') {
        throw new ConflictException({ message: 'Session is running', details: { code: 'PLOT_STEP_RUNNING' } });
      }
      if (session.status === 'finished') {
        throw new ConflictException({ message: 'Session is finished', details: { code: 'PLOT_SESSION_FINISHED' } });
      }
      if (session.status !== 'idle' && session.status !== 'paused') {
        throw new ConflictException({ message: 'Session is not ready', details: { code: 'PLOT_SESSION_NOT_READY' } });
      }

      const pending = await manager.getRepository(AiTaskEntity).createQueryBuilder('task')
        .where("task.scope = 'plot'")
        .andWhere("task.status IN ('queued', 'running')")
        .andWhere("task.input_summary ->> 'session_id' = :sessionId", { sessionId })
        .getOne();
      if (pending) {
        throw new ConflictException({ message: 'A step is already pending', details: { code: 'PLOT_STEP_RUNNING' } });
      }

      // 工具被禁用 → 409；缺失 → 404
      const { agentId } = await this.agents.resolveToolForTask(PLOT_DERIVATION_TOOL);

      const recent = await manager.getRepository(DerivationStepEntity).find({
        where: { session_id: session.id },
        order: { step_no: 'DESC' },
        take: 5
      });
      const history = recent.reverse().map((step) => clip(step.content, 200));
      const stepNo = session.step_index + 1;

      const taskRepository = manager.getRepository(AiTaskEntity);
      const task = await taskRepository.save(
        taskRepository.create({
          id: randomUUID(),
          idempotency_key: `plot-${session.id}-${stepNo}-${randomUUID().slice(0, 8)}`,
          work_id: workId,
          chapter_id: null,
          scope: 'plot',
          tool: PLOT_DERIVATION_TOOL,
          agent_id: agentId,
          input_summary: {
            session_id: session.id,
            step_no: stepNo,
            tree_id: session.tree_id,
            start_node_id: session.start_node_id,
            place: session.place,
            time_node: session.time_node,
            random_enabled: session.random_enabled,
            random_character_enabled: session.random_character_enabled,
            history
          },
          base_version: 0,
          status: 'queued',
          event_seq: 0,
          result_revision_set_id: null,
          error: null,
          attempts: 0,
          created_by: authorId
        })
      );

      await this.appendEvent(manager, task, 'queued', { tool: task.tool, session_id: session.id, step_no: stepNo });

      session.status = 'running';
      await manager.getRepository(DerivationSessionEntity).save(session);

      await this.audit.record(authorId, 'ai_task_create', 'ai_task', task.id, {
        tool: task.tool,
        session_id: session.id,
        step_no: stepNo
      }, workId);

      return { task, session };
    });

    await this.queue.enqueue(result.task.id).catch(() => undefined);
    return { task: toAiTaskView(result.task), session: mapSession(result.session) };
  }

  async updateStep(
    authorId: string,
    workId: string,
    sessionId: string,
    stepNo: number,
    input: UpdateDerivationStepInput
  ): Promise<{ step: DerivationStep }> {
    return this.dataSource.transaction(async (manager) => {
      const session = await this.assertOwnedSession(manager, authorId, workId, sessionId);
      const repository = manager.getRepository(DerivationStepEntity);
      const step = await repository.findOneBy({ session_id: session.id, step_no: stepNo });
      if (!step) throw new NotFoundException('Derivation step not found');

      if (input.chosen_branch_id !== undefined && input.chosen_branch_id !== null) {
        const branches = step.branches as DerivationStep['branches'];
        const exists = branches.some((branch) => branch.id === input.chosen_branch_id);
        if (!exists) {
          throw new UnprocessableEntityException({ message: 'Unknown branch', details: { code: 'PLOT_BRANCH_UNKNOWN' } });
        }
      }
      if (input.content !== undefined) step.content = input.content;
      if (input.chosen_branch_id !== undefined) step.chosen_branch_id = input.chosen_branch_id;

      await repository.save(step);
      return { step: mapStep(step) };
    });
  }

  async createCandidate(
    authorId: string,
    workId: string,
    sessionId: string,
    input: CreateDerivationCandidateInput
  ): Promise<{ candidate: DerivationCandidate }> {
    return this.dataSource.transaction(async (manager) => {
      const session = await this.assertOwnedSession(manager, authorId, workId, sessionId, true);
      const steps = await manager.getRepository(DerivationStepEntity).find({
        where: { session_id: session.id },
        order: { step_no: 'ASC' }
      });
      if (steps.length === 0) {
        throw new UnprocessableEntityException({ message: 'Session has no steps', details: { code: 'PLOT_NO_STEPS' } });
      }

      const payload = input.payload ?? this.buildPayload(manager, session, steps, input.split_by_step ?? false);

      // 同一会话只保留一个待确认候选，旧的自动置为 rejected
      await manager.getRepository(DerivationCandidateEntity).update(
        { session_id: session.id, status: 'pending' },
        { status: 'rejected' }
      );

      const repository = manager.getRepository(DerivationCandidateEntity);
      const candidate = await repository.save(
        repository.create({
          id: randomUUID(),
          session_id: session.id,
          start_node_id: session.start_node_id,
          placement: input.placement,
          payload: payload as unknown as Record<string, unknown>,
          status: 'pending',
          confirmed_node_id: null,
          confirmed_at: null
        })
      );
      return { candidate: mapCandidate(candidate) };
    });
  }

  /** 人工确认回写：候选 → 剧情树节点（事务 + 版本推进 + 审计，重复确认幂等） */
  async confirmCandidate(
    authorId: string,
    workId: string,
    sessionId: string,
    candidateId: string,
    input: ConfirmDerivationCandidateInput
  ): Promise<{ nodes: PlotNode[]; version: number }> {
    return this.dataSource.transaction(async (manager) => {
      const session = await this.assertOwnedSession(manager, authorId, workId, sessionId, true);
      const candidateRepository = manager.getRepository(DerivationCandidateEntity);
      const candidate = await candidateRepository.findOneBy({ id: candidateId, session_id: session.id });
      if (!candidate) throw new NotFoundException('Derivation candidate not found');

      const treeRepository = manager.getRepository(PlotTreeEntity);
      const tree = await treeRepository.createQueryBuilder('tree')
        .setLock('pessimistic_write')
        .where('tree.id = :treeId', { treeId: session.tree_id })
        .getOne();
      if (!tree) throw new ConflictException({ message: 'Plot tree missing', details: { code: 'PLOT_TREE_MISSING' } });

      if (candidate.status === 'confirmed') {
        const ids = (candidate.payload as { confirmed_node_ids?: string[] }).confirmed_node_ids ?? [];
        const nodeRepository = manager.getRepository(PlotNodeEntity);
        let existing: PlotNodeEntity[] = [];
        if (ids.length > 0) {
          existing = await nodeRepository.find({ where: ids.map((id) => ({ id, tree_id: tree.id })) });
        } else if (candidate.confirmed_node_id) {
          existing = await nodeRepository.find({
            where: { id: candidate.confirmed_node_id, tree_id: tree.id }
          });
        }
        return { nodes: existing.map(mapNode), version: tree.version };
      }
      if (candidate.status === 'rejected') {
        throw new ConflictException({ message: 'Candidate rejected', details: { code: 'PLOT_CANDIDATE_REJECTED' } });
      }
      if (input.expected_version !== undefined && input.expected_version !== tree.version) {
        throw new ConflictException({ code: 'PLOT_VERSION_CONFLICT', current_version: tree.version });
      }

      const nodeRepository = manager.getRepository(PlotNodeEntity);
      // 用候选快照的起点定位，起点被删时返回 409 让作者重选
      const start = await nodeRepository.findOneBy({ id: candidate.start_node_id, tree_id: tree.id });
      if (!start) {
        throw new ConflictException({ message: 'Start node missing', details: { code: 'PLOT_START_NODE_MISSING' } });
      }

      const payload = candidate.payload as unknown as PlotTreeDraftPayload;
      const nodes = payload.nodes;
      let placementParentId: string | null;
      let firstSiblingOrder = 0;
      if (candidate.placement === 'sibling') {
        placementParentId = start.parent_id;
        firstSiblingOrder = start.sibling_order + 1;
        // 起点之后的所有兄弟节点后移一位
        const shift = nodeRepository.createQueryBuilder()
          .update()
          .set({ sibling_order: () => 'sibling_order + 1' })
          .where('tree_id = :treeId', { treeId: tree.id })
          .andWhere('sibling_order >= :order', { order: firstSiblingOrder });
        if (placementParentId === null) shift.andWhere('parent_id IS NULL');
        else shift.andWhere('parent_id = :parentId', { parentId: placementParentId });
        await shift.execute();
      } else {
        placementParentId = start.id;
        const row = await nodeRepository.createQueryBuilder('node')
          .select('MAX(node.sibling_order)', 'max')
          .where('node.tree_id = :treeId', { treeId: tree.id })
          .andWhere('node.parent_id = :parentId', { parentId: start.id })
          .getRawOne<{ max: number | null }>();
        firstSiblingOrder = row?.max === null || row?.max === undefined ? 0 : Number(row.max) + 1;
      }

      const created: PlotNodeEntity[] = [];
      for (const [index, draft] of nodes.entries()) {
        const parentIndex = draft.parent_index;
        let parentId: string | null;
        if (parentIndex === null || parentIndex === undefined) {
          parentId = placementParentId;
        } else {
          const parent = created[parentIndex];
          if (!parent || parentIndex >= index) {
            throw new UnprocessableEntityException({ message: 'Invalid parent_index', details: { code: 'PLOT_PAYLOAD_INVALID' } });
          }
          parentId = parent.id;
        }
        const node = await nodeRepository.save(
          nodeRepository.create({
            id: randomUUID(),
            tree_id: tree.id,
            parent_id: parentId,
            sibling_order: index === 0 ? firstSiblingOrder : 0,
            title: draft.title,
            summary: draft.summary ?? null,
            content: draft.content ?? '',
            attributes: {},
            position_x: start.position_x + 240 * (index + 1),
            position_y: start.position_y + 120,
            group_id: null,
            origin: 'derivation'
          })
        );
        created.push(node);
      }

      candidate.status = 'confirmed';
      candidate.confirmed_node_id = created[0]!.id;
      candidate.confirmed_at = new Date();
      candidate.payload = {
        ...(candidate.payload as Record<string, unknown>),
        confirmed_node_ids: created.map((node) => node.id)
      };
      await candidateRepository.save(candidate);

      tree.version += 1;
      await treeRepository.update({ id: tree.id }, { version: tree.version, updated_at: new Date() });

      await this.audit.record(authorId, 'plot_candidate_confirm', 'plot_candidate', candidate.id, {
        session_id: session.id,
        node_ids: created.map((node) => node.id),
        version: tree.version
      }, workId);

      return { nodes: created.map(mapNode), version: tree.version };
    });
  }

  async rejectCandidate(
    authorId: string,
    workId: string,
    sessionId: string,
    candidateId: string
  ): Promise<{ candidate: DerivationCandidate }> {
    return this.dataSource.transaction(async (manager) => {
      const session = await this.assertOwnedSession(manager, authorId, workId, sessionId);
      const repository = manager.getRepository(DerivationCandidateEntity);
      const candidate = await repository.findOneBy({ id: candidateId, session_id: session.id });
      if (!candidate) throw new NotFoundException('Derivation candidate not found');
      if (candidate.status === 'confirmed') {
        throw new ConflictException({ message: 'Candidate already confirmed', details: { code: 'PLOT_CANDIDATE_CONFIRMED' } });
      }
      if (candidate.status !== 'rejected') {
        candidate.status = 'rejected';
        await repository.save(candidate);
        await this.audit.record(authorId, 'plot_candidate_reject', 'plot_candidate', candidate.id, {
          session_id: session.id
        }, workId);
      }
      return { candidate: mapCandidate(candidate) };
    });
  }

  // ── 内部工具 ──

  private buildPayload(
    manager: EntityManager,
    session: DerivationSessionEntity,
    steps: DerivationStepEntity[],
    splitByStep: boolean
  ): PlotTreeDraftPayload {
    if (splitByStep) {
      return {
        nodes: steps.map((step, index) => {
          const event = step.event as DerivationStep['event'];
          return {
            title: clip(`第${step.step_no}步：${event?.title ?? step.content.slice(0, 20)}`, 120),
            summary: event?.title ?? null,
            content: step.content,
            parent_index: index === 0 ? null : index - 1
          };
        })
      };
    }
    const firstEvent = steps[0]?.event as DerivationStep['event'];
    return {
      nodes: [
        {
          title: clip(`${session.place} · 推衍`, 120),
          summary: firstEvent?.title ?? null,
          content: steps.map((step) => step.content).join('\n\n'),
          parent_index: null
        }
      ]
    };
  }

  private async assertOwnedWork(manager: EntityManager, authorId: string, workId: string): Promise<void> {
    const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('Work not found');
  }

  private async assertOwnedTree(
    manager: EntityManager,
    authorId: string,
    workId: string
  ): Promise<PlotTreeEntity> {
    await this.assertOwnedWork(manager, authorId, workId);
    const tree = await manager.getRepository(PlotTreeEntity).findOneBy({ work_id: workId });
    if (!tree) throw new NotFoundException('Plot tree not found');
    return tree;
  }

  private async assertOwnedSession(
    manager: EntityManager,
    authorId: string,
    workId: string,
    sessionId: string,
    lock = false
  ): Promise<DerivationSessionEntity> {
    await this.assertOwnedWork(manager, authorId, workId);
    const qb = manager.getRepository(DerivationSessionEntity).createQueryBuilder('session')
      .where('session.id = :sessionId', { sessionId })
      .andWhere('session.work_id = :workId', { workId });
    if (lock) qb.setLock('pessimistic_write');
    const session = await qb.getOne();
    if (!session) throw new NotFoundException('Derivation session not found');
    return session;
  }

  private async appendEvent(
    manager: EntityManager,
    task: AiTaskEntity,
    type: 'queued',
    payload: Record<string, unknown>
  ): Promise<void> {
    const seq = task.event_seq + 1;
    const repository = manager.getRepository(AiTaskEventEntity);
    const event = repository.create({
      id: randomUUID(),
      task_id: task.id,
      event_seq: seq,
      type,
      payload
    });
    await manager.save(event);
    task.event_seq = seq;
    await manager.save(task);
    this.eventBus.publish(task.id, {
      id: event.id,
      task_id: task.id,
      event_seq: seq,
      type,
      payload,
      created_at: event.created_at.toISOString()
    });
  }
}
