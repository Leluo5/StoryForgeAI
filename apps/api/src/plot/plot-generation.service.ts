import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { documentToMarkdown } from '@storyforge/editor-schema';
import type {
  PlotGenerationDraft,
  PlotGenerationSource,
  PlotGenerationStatus,
  PlotTreeDraftPayload
} from '@storyforge/contracts';
import { AgentService } from '../agent/agent.service';
import { AI_TASK_QUEUE, type AiTaskQueuePort } from '../ai/ai-task.service';
import { AiTaskEventBus, AI_TASK_EVENT_BUS } from '../ai/ai-task.sse';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AiTaskEventEntity } from '../database/ai-task-event.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { PlotGenerationDraftEntity } from '../database/plot-generation-draft.entity';
import { PlotGroupEntity } from '../database/plot-group.entity';
import { PlotNodeEntity } from '../database/plot-node.entity';
import { PlotTreeEntity } from '../database/plot-tree.entity';
import { WorkEntity } from '../database/work.entity';
import { AuditService } from '../revision/audit.service';

export const PLOT_GENERATION_TOOL = 'plot_generate';

export type CreatePlotGenerationInput =
  | { source: 'outline'; text: string }
  | { source: 'novel_text'; chapter_id: string };

export interface CommitPlotGenerationInput {
  mode: 'replace' | 'append';
  parent_node_id?: string | null | undefined;
  confirm_overwrite: boolean;
}

function mapDraft(draft: PlotGenerationDraftEntity): PlotGenerationDraft {
  return {
    id: draft.id,
    work_id: draft.work_id,
    source: draft.source as PlotGenerationSource,
    input_text: draft.input_text,
    input_chapter_id: draft.input_chapter_id,
    status: draft.status as PlotGenerationStatus,
    payload: draft.payload as unknown as PlotGenerationDraft['payload'],
    error: draft.error,
    task_id: draft.task_id,
    created_at: draft.created_at.toISOString(),
    updated_at: draft.updated_at.toISOString()
  };
}

@Injectable()
export class PlotGenerationService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AgentService) private readonly agents: AgentService,
    @Inject(AI_TASK_QUEUE) private readonly queue: AiTaskQueuePort,
    @Inject(AI_TASK_EVENT_BUS) private readonly eventBus: AiTaskEventBus
  ) {}

  async create(
    authorId: string,
    workId: string,
    input: CreatePlotGenerationInput
  ): Promise<{ draft: PlotGenerationDraft }> {
    const result = await this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const { agentId } = await this.agents.resolveToolForTask(PLOT_GENERATION_TOOL);

      let text: string;
      let chapterId: string | null = null;
      if (input.source === 'outline') {
        text = input.text;
      } else {
        const chapter = await manager.getRepository(ChapterEntity).createQueryBuilder('chapter')
          .innerJoin(WorkEntity, 'work', 'work.id = chapter.work_id')
          .where('chapter.id = :chapterId', { chapterId: input.chapter_id })
          .andWhere('chapter.work_id = :workId', { workId })
          .andWhere('work.author_id = :authorId', { authorId })
          .getOne();
        if (!chapter) throw new NotFoundException('Chapter not found');
        text = documentToMarkdown(chapter.document);
        chapterId = chapter.id;
      }

      const draftRepository = manager.getRepository(PlotGenerationDraftEntity);
      const draft = await draftRepository.save(draftRepository.create({
        id: randomUUID(),
        work_id: workId,
        source: input.source,
        input_text: text,
        input_chapter_id: chapterId,
        status: 'pending',
        payload: null,
        error: null,
        task_id: null
      }));

      const taskRepository = manager.getRepository(AiTaskEntity);
      const task = await taskRepository.save(taskRepository.create({
        id: randomUUID(),
        idempotency_key: `plot-generate-${draft.id}`,
        work_id: workId,
        chapter_id: null,
        scope: 'plot',
        tool: PLOT_GENERATION_TOOL,
        agent_id: agentId,
        input_summary: { draft_id: draft.id, source: input.source, input_chapter_id: chapterId },
        base_version: 0,
        status: 'queued',
        event_seq: 0,
        result_revision_set_id: null,
        error: null,
        attempts: 0,
        created_by: authorId
      }));
      draft.task_id = task.id;
      await draftRepository.save(draft);
      await this.appendQueuedEvent(manager, task, draft.id);

      await this.audit.record(authorId, 'ai_task_create', 'ai_task', task.id, {
        tool: task.tool,
        draft_id: draft.id,
        source: input.source
      }, workId);
      return draft;
    });

    await this.queue.enqueue(result.task_id!).catch(() => undefined);
    return { draft: mapDraft(result) };
  }

  async get(authorId: string, workId: string, draftId: string): Promise<{ draft: PlotGenerationDraft }> {
    await this.assertOwnedWork(this.dataSource.manager, authorId, workId);
    const draft = await this.dataSource.getRepository(PlotGenerationDraftEntity).findOneBy({ id: draftId, work_id: workId });
    if (!draft) throw new NotFoundException('Plot generation draft not found');
    return { draft: mapDraft(draft) };
  }

  async update(
    authorId: string,
    workId: string,
    draftId: string,
    payload: PlotTreeDraftPayload
  ): Promise<{ draft: PlotGenerationDraft }> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const repository = manager.getRepository(PlotGenerationDraftEntity);
      const draft = await repository.createQueryBuilder('draft')
        .setLock('pessimistic_write')
        .where('draft.id = :draftId', { draftId })
        .andWhere('draft.work_id = :workId', { workId })
        .getOne();
      if (!draft) throw new NotFoundException('Plot generation draft not found');
      if (draft.status !== 'succeeded') {
        throw new ConflictException({ message: 'Plot generation draft is not editable', details: { code: 'PLOT_GENERATION_NOT_EDITABLE' } });
      }
      draft.payload = payload as unknown as Record<string, unknown>;
      await repository.save(draft);
      return { draft: mapDraft(draft) };
    });
  }

  async commit(
    authorId: string,
    workId: string,
    draftId: string,
    input: CommitPlotGenerationInput
  ): Promise<{ draft: PlotGenerationDraft; version: number }> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const draftRepository = manager.getRepository(PlotGenerationDraftEntity);
      const draft = await draftRepository.createQueryBuilder('draft')
        .setLock('pessimistic_write')
        .where('draft.id = :draftId', { draftId })
        .andWhere('draft.work_id = :workId', { workId })
        .getOne();
      if (!draft) throw new NotFoundException('Plot generation draft not found');
      if (draft.status !== 'succeeded') {
        throw new ConflictException({ message: 'Plot generation draft is not ready', details: { code: 'PLOT_GENERATION_NOT_READY' } });
      }
      const treeRepository = manager.getRepository(PlotTreeEntity);
      const tree = await treeRepository.createQueryBuilder('tree')
        .setLock('pessimistic_write')
        .where('tree.work_id = :workId', { workId })
        .getOne();
      if (!tree) throw new ConflictException({ message: 'Plot tree missing', details: { code: 'PLOT_TREE_MISSING' } });

      const nodeRepository = manager.getRepository(PlotNodeEntity);
      let placementParentId: string | null = null;
      let nextRootOrder = 0;
      if (input.mode === 'replace') {
        await nodeRepository.delete({ tree_id: tree.id });
        await manager.getRepository(PlotGroupEntity).delete({ tree_id: tree.id });
      } else {
        if (input.parent_node_id) {
          const parent = await nodeRepository.findOneBy({ id: input.parent_node_id, tree_id: tree.id });
          if (!parent) throw new NotFoundException('Parent plot node not found');
          placementParentId = parent.id;
        }
        const siblings = nodeRepository.createQueryBuilder('node')
          .select('COALESCE(MAX(node.sibling_order), -1)', 'max')
          .where('node.tree_id = :treeId', { treeId: tree.id });
        if (placementParentId) siblings.andWhere('node.parent_id = :placementParentId', { placementParentId });
        else siblings.andWhere('node.parent_id IS NULL');
        const row = await siblings.getRawOne<{ max: string | number | null }>();
        nextRootOrder = Number(row?.max ?? -1) + 1;
      }

      const created: PlotNodeEntity[] = [];
      const payload = draft.payload as unknown as PlotTreeDraftPayload;
      for (const [index, draftNode] of payload.nodes.entries()) {
        const parentIndex = draftNode.parent_index;
        const isRoot = parentIndex === null || parentIndex === undefined;
        let parentId: string | null;
        if (isRoot) {
          parentId = placementParentId;
        } else {
          const parent = created[parentIndex];
          if (!parent || parentIndex >= index) {
            throw new UnprocessableEntityException({ message: 'Invalid parent_index', details: { code: 'PLOT_PAYLOAD_INVALID' } });
          }
          parentId = parent.id;
        }
        const siblingOrder = isRoot
          ? nextRootOrder + created.filter((item) => item.parent_id === placementParentId).length
          : created.filter((item) => item.parent_id === parentId).length;
        const node = await nodeRepository.save(nodeRepository.create({
          id: randomUUID(),
          tree_id: tree.id,
          parent_id: parentId,
          sibling_order: siblingOrder,
          title: draftNode.title,
          summary: draftNode.summary ?? null,
          content: draftNode.content ?? '',
          attributes: {},
          position_x: 0,
          position_y: 0,
          group_id: null,
          origin: draft.source
        }));
        created.push(node);
      }

      if (input.mode === 'replace') tree.source = draft.source;
      tree.version += 1;
      tree.updated_at = new Date();
      await treeRepository.save(tree);
      draft.status = 'committed';
      await draftRepository.save(draft);
      await this.audit.record(authorId, 'plot_generation_commit', 'plot_generation', draft.id, {
        mode: input.mode,
        node_ids: created.map((node) => node.id),
        version: tree.version
      }, workId, manager);
      return { draft: mapDraft(draft), version: tree.version };
    });
  }

  async discard(authorId: string, workId: string, draftId: string): Promise<{ draft: PlotGenerationDraft }> {
    return this.dataSource.transaction(async (manager) => {
      await this.assertOwnedWork(manager, authorId, workId);
      const repository = manager.getRepository(PlotGenerationDraftEntity);
      const draft = await repository.createQueryBuilder('draft')
        .setLock('pessimistic_write')
        .where('draft.id = :draftId', { draftId })
        .andWhere('draft.work_id = :workId', { workId })
        .getOne();
      if (!draft) throw new NotFoundException('Plot generation draft not found');
      if (draft.status === 'committed') {
        throw new ConflictException({ message: 'Plot generation draft already committed', details: { code: 'PLOT_GENERATION_COMMITTED' } });
      }
      if (draft.status !== 'discarded') {
        draft.status = 'discarded';
        await repository.save(draft);
      }
      return { draft: mapDraft(draft) };
    });
  }

  private async assertOwnedWork(manager: EntityManager, authorId: string, workId: string): Promise<void> {
    const work = await manager.getRepository(WorkEntity).findOneBy({ id: workId, author_id: authorId });
    if (!work) throw new NotFoundException('Work not found');
  }

  private async appendQueuedEvent(manager: EntityManager, task: AiTaskEntity, draftId: string): Promise<void> {
    const repository = manager.getRepository(AiTaskEventEntity);
    const event = repository.create({
      id: randomUUID(),
      task_id: task.id,
      event_seq: task.event_seq + 1,
      type: 'queued',
      payload: { tool: task.tool, draft_id: draftId }
    });
    await repository.save(event);
    task.event_seq = event.event_seq;
    await manager.save(task);
    this.eventBus.publish(task.id, {
      id: event.id,
      task_id: task.id,
      event_seq: event.event_seq,
      type: 'queued',
      payload: event.payload,
      created_at: event.created_at.toISOString()
    });
  }
}
