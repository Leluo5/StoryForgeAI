import { Inject, Injectable, Logger, Optional, forwardRef } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { Job, Worker, UnrecoverableError } from 'bullmq';
import type { PlotTreeDraftPayload, ProseMirrorNode } from '@storyforge/contracts';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AiTaskEventEntity } from '../database/ai-task-event.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { AuditService } from '../revision/audit.service';
import { AI_TASK_QUEUE_NAME } from './ai-task.queue';
import { AiModelError, type AiModelProvider, type AiModelContext, AI_MODEL_PROVIDER } from './ai-model.provider';
import { AiTaskEventBus, AI_TASK_EVENT_BUS } from './ai-task.sse';
import { DerivationSessionEntity } from '../database/derivation-session.entity';
import { PlotGenerationDraftEntity } from '../database/plot-generation-draft.entity';
import { PlotNodeEntity } from '../database/plot-node.entity';
import {
  MockPlotModelProvider,
  PlotModelError,
  type PlotContextNode,
  type PlotModelProvider,
  type PlotStepCandidate,
  type PlotStepContext,
  type PlotTreeContext,
  PLOT_MODEL_PROVIDER
} from '../plot/plot-model.provider';
import { PlotTaskHandler } from '../plot/plot-task.handler';
import {
  CharacterTaskHandler,
  type CharacterTaskContext
} from '../character/character-task.handler';
import { CollabTaskHandler } from '../collab/collab-task.handler';
import { CollabUpstreamError } from '../collab/channel/collab-upstream.error';
import { env } from '../config/env';

// ───────────────────────────── 结果映射端口（A6 实现，避免 A5↔A6 循环依赖） ─────────────────────────────

export interface AiRevisionSetResult {
  /** 修订集 id；章节基准版本已变化（stale）时为 null */
  revision_set_id: string | null;
  /** 候选输出基于旧版本生成，作者需提示重新生成 */
  stale: boolean;
}

export interface AiResultMapperPort {
  /**
   * 生成 AI 修订集（actor_type='ai' / ai_set=true）。
   * @param manager 调用方事务（修订集创建与任务状态推进需原子）
   */
  toAiRevisionSet(
    manager: EntityManager,
    ctx: { authorId: string; workId: string; chapterId: string; baseVersion: number; candidateDocument: ProseMirrorNode }
  ): Promise<AiRevisionSetResult>;
}

export const AI_RESULT_MAPPER = Symbol('AI_RESULT_MAPPER');

// ───────────────────────────── 处理器 ─────────────────────────────

/** 写进度事件：event_seq 单调递增（UNIQUE(task_id, event_seq) 兜底），同步推进并持久化 task.event_seq */
async function appendEvent(
  manager: EntityManager,
  task: AiTaskEntity,
  bus: AiTaskEventBus,
  type: 'running' | 'progress' | 'succeeded' | 'failed' | 'cancelled',
  payload: Record<string, unknown>
): Promise<void> {
  const seq = task.event_seq + 1;
  const event = manager.getRepository(AiTaskEventEntity).create();
  event.id = randomUUID();
  event.task_id = task.id;
  event.event_seq = seq;
  event.type = type;
  event.payload = payload;
  await manager.save(event);
  task.event_seq = seq;
  await manager.save(task);
  // 广播给该任务的所有 SSE 订阅者（payload 完整，订阅者无需回读 DB；事务内广播安全）
  bus.publish(task.id, {
    id: event.id,
    task_id: task.id,
    event_seq: seq,
    type: type as 'running',
    payload,
    created_at: event.created_at.toISOString()
  });
}

interface BaseProcessContext {
  taskId: string;
  authorId: string;
  workId: string;
  tool: string;
  inputSummary: Record<string, unknown>;
}

interface ChapterProcessContext extends BaseProcessContext {
  kind: 'chapter';
  chapterId: string;
  baseVersion: number;
  baseDocument: ProseMirrorNode;
}

interface PlotDerivationProcessContext extends BaseProcessContext {
  kind: 'plot';
  operation: 'derivation';
  sessionId: string;
  stepNo: number;
  plot: PlotStepContext;
}

interface PlotGenerationProcessContext extends BaseProcessContext {
  kind: 'plot';
  operation: 'generation';
  draftId: string;
  plot: PlotTreeContext;
}

type PlotProcessContext = PlotDerivationProcessContext | PlotGenerationProcessContext;

interface CharacterProcessContext extends BaseProcessContext {
  kind: 'character';
}

interface RoleProfileProcessContext extends BaseProcessContext {
  kind: 'role_profile';
}

type ProcessContext = ChapterProcessContext | PlotProcessContext | CharacterProcessContext | RoleProfileProcessContext;

/**
 * AI 任务处理器：消费 BullMQ 队列，执行一次 AI 创作任务。
 * 状态流：queued → running → succeeded / failed；被取消（cancelled）时检查点退出。
 * 失败语义：retryable 模型错误按 BullMQ 退避重试（共 attempts 次）；超限/不可重试标 failed。
 */
@Injectable()
export class AiTaskProcessor {
  private readonly logger = new Logger(AiTaskProcessor.name);

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly auditService: AuditService,
    @Inject(AI_MODEL_PROVIDER) private readonly model: AiModelProvider,
    @Inject(AI_RESULT_MAPPER) private readonly mapper: AiResultMapperPort,
    @Inject(AI_TASK_EVENT_BUS) private readonly eventBus: AiTaskEventBus,
    @Inject(PLOT_MODEL_PROVIDER) private readonly plotModel: PlotModelProvider = new MockPlotModelProvider(),
    @Inject(PlotTaskHandler) private readonly plotHandler: PlotTaskHandler = new PlotTaskHandler(),
    @Optional()
    @Inject(forwardRef(() => CharacterTaskHandler))
    private readonly characterHandler?: CharacterTaskHandler,
    @Optional()
    @Inject(CollabTaskHandler)
    private readonly collabHandler?: CollabTaskHandler
  ) {}

  /** 创建消费该队列的 BullMQ Worker（A8 在 main.ts 启动；测试可直接调用） */
  createWorker(): Worker {
    const worker = new Worker(
      AI_TASK_QUEUE_NAME,
      (job) => this.process(job),
      {
        connection: { url: this.redisUrl(), maxRetriesPerRequest: null },
        concurrency: 4
      }
    );
    // 兜底：最终失败但 DB 任务仍非终态 → 标 failed（process 内已处理，此处仅防进程异常遗漏）
    worker.on('failed', (job, err) => void this.onJobFailed(job, err));
    worker.on('error', (err) => this.logger.error(`Worker error: ${err.message}`));
    return worker;
  }

  /** 单次执行（BullMQ processor 回调） */
  async process(job: Job<{ taskId: string }>): Promise<void> {
    const taskId = job.data.taskId;
    const attempts = job.opts.attempts ?? 1;
    const isFinalAttempt = job.attemptsMade + 1 >= attempts;
    try {
      const started = await this.startRunning(taskId, job.attemptsMade);
      if (started.skipped) return; // 任务已被取消/完成，无事可做

      if (started.context.kind === 'character') {
        if (!this.characterHandler) {
          throw new Error('CharacterTaskHandler 未装配');
        }
        const summary = await this.characterHandler.handle({
          taskId: started.context.taskId,
          authorId: started.context.authorId,
          workId: started.context.workId,
          tool: started.context.tool,
          inputSummary: started.context.inputSummary
        });
        await this.finishCharacterSucceeded(started.context, summary);
        return;
      }

      if (started.context.kind === 'role_profile') {
        if (!this.collabHandler) {
          throw new Error('CollabTaskHandler 未装配');
        }
        const summary = await this.collabHandler.handle({
          taskId: started.context.taskId,
          authorId: started.context.authorId,
          workId: started.context.workId,
          tool: started.context.tool,
          inputSummary: started.context.inputSummary
        });
        await this.finishRoleProfileSucceeded(started.context, summary);
        return;
      }

      if (started.context.kind === 'plot') {
        if (started.context.operation === 'generation') {
          const payload = await this.plotModel.generateTree(started.context.plot);
          await this.finishPlotGenerationSucceeded(started.context, payload);
          return;
        }
        const plotCandidate = await this.plotModel.generateStep(started.context.plot);
        await this.finishPlotSucceeded(started.context, plotCandidate);
        return;
      }

      const candidate = await this.model.generate(started.context);
      const outcome = await this.finishSucceeded(started.context, candidate.candidateDocument);
      if (outcome.skipped) return; // 执行期间被取消
    } catch (err) {
      // 不可重试或最后一次尝试 → 标 failed；否则保持 running，由 BullMQ 退避重试
      const retryable =
        err instanceof AiModelError || err instanceof PlotModelError ? err.retryable : false;
      const shouldMarkFailed = isFinalAttempt || !retryable;
      if (shouldMarkFailed) {
        await this.markFailed(taskId, err).catch(() => undefined);
      }
      if (!retryable && !(err instanceof UnrecoverableError)) {
        throw new UnrecoverableError(err instanceof Error ? err.message : 'Unrecoverable model error');
      }
      throw err;
    }
  }

  /** 事务1：锁任务，queued→running（重试进入时 running 直接放行），读基准章节 */
  private async startRunning(taskId: string, attemptsMade: number): Promise<{ skipped: boolean; context: ProcessContext }> {
    return this.dataSource.transaction(async (manager) => {
      const task = await manager.getRepository(AiTaskEntity).createQueryBuilder('task')
        .where('task.id = :taskId', { taskId })
        .setLock('pessimistic_write')
        .getOne();
      if (!task) return { skipped: true, context: null as never };

      // 终态（已取消/已成功/已失败）→ 检查点退出；仅 queued 或 running（重试）可进入
      if (task.status === 'cancelled' || task.status === 'succeeded' || task.status === 'failed') {
        return { skipped: true, context: null as never };
      }
      const wasQueued = task.status === 'queued';
      task.status = 'running';
      task.attempts = task.attempts + 1;
      if (wasQueued) {
        await appendEvent(manager, task, this.eventBus, 'running', { tool: task.tool, attempts: task.attempts });
      } else {
        await manager.save(task); // 重试进入：仅推进 attempts，不重复写 running 事件
      }

      // scope='character' 的任务无章节，直接构建角色上下文
      if (task.scope === 'character') {
        return {
          skipped: false,
          context: {
            kind: 'character',
            taskId: task.id,
            authorId: task.created_by,
            workId: task.work_id,
            tool: task.tool,
            inputSummary: task.input_summary
          }
        };
      }

      // scope='role_profile'（F11）任务无章节，通道已在任务创建时写入 task.channel
      if (task.scope === 'role_profile') {
        if (task.channel !== 'flowise' && task.channel !== 'coze') {
          throw new Error(`Role profile task ${task.id} missing valid channel`);
        }
        return {
          skipped: false,
          context: {
            kind: 'role_profile',
            taskId: task.id,
            authorId: task.created_by,
            workId: task.work_id,
            tool: task.tool,
            inputSummary: task.input_summary
          }
        };
      }

      // scope='plot' 的任务无章节，按推衍会话构建上下文
      if (task.scope === 'plot') {
        return { skipped: false, context: await this.buildPlotContext(manager, task) };
      }

      // scope='chapter' 的任务必有章节（DB 迁移已允许 plot 任务为空）
      if (!task.chapter_id) throw new Error(`Chapter task ${task.id} missing chapter_id`);
      const chapter = await manager.getRepository(ChapterEntity).findOneByOrFail({ id: task.chapter_id });
      return {
        skipped: false,
        context: {
          kind: 'chapter',
          taskId: task.id,
          authorId: task.created_by,
          workId: task.work_id,
          chapterId: task.chapter_id,
          tool: task.tool,
          inputSummary: task.input_summary,
          baseVersion: task.base_version,
          baseDocument: chapter.document as ProseMirrorNode
        }
      };
    });
  }

  /** 按工具构建剧情任务上下文，避免自动建树误入推衍会话链路。 */
  private async buildPlotContext(manager: EntityManager, task: AiTaskEntity): Promise<PlotProcessContext> {
    if (task.tool === 'plot_generate') return this.buildPlotGenerationContext(manager, task);
    if (task.tool !== 'plot_derivation') throw new Error(`Unsupported plot tool ${task.tool}`);

    const sessionId = typeof task.input_summary?.session_id === 'string' ? task.input_summary.session_id : null;
    const stepNo = Number(task.input_summary?.step_no);
    if (!sessionId) throw new Error(`Plot task ${task.id} missing session_id`);
    if (!Number.isInteger(stepNo) || stepNo < 1) throw new Error(`Plot task ${task.id} has invalid step_no`);

    const session = await manager
      .getRepository(DerivationSessionEntity)
      .findOneBy({ id: sessionId, work_id: task.work_id });
    if (!session) throw new Error(`Plot task ${task.id} session ${sessionId} not found`);

    const nodeRepository = manager.getRepository(PlotNodeEntity);
    const loadNodes = async (ids: string[]): Promise<PlotContextNode[]> => {
      if (ids.length === 0) return [];
      const nodes = await nodeRepository.find({ where: ids.map((id) => ({ id, tree_id: session.tree_id })) });
      const byId = new Map(nodes.map((node) => [node.id, node]));
      // 保持会话中记录的先后顺序，已删除的节点静默忽略
      return ids
        .map((id) => byId.get(id))
        .filter((node): node is PlotNodeEntity => Boolean(node))
        .map((node) => ({ id: node.id, title: node.title, summary: node.summary }));
    };

    const history = Array.isArray(task.input_summary?.history)
      ? (task.input_summary.history as unknown[]).filter((item): item is string => typeof item === 'string')
      : [];

    return {
      kind: 'plot',
      operation: 'derivation',
      taskId: task.id,
      authorId: task.created_by,
      workId: task.work_id,
      tool: task.tool,
      inputSummary: task.input_summary,
      sessionId: session.id,
      stepNo,
      plot: {
        workId: task.work_id,
        sessionId: session.id,
        stepNo,
        place: session.place,
        background: session.background,
        timeNode: session.time_node,
        premiseNodes: await loadNodes(session.premise_node_ids),
        relatedNodes: await loadNodes(session.related_node_ids),
        characters: session.characters,
        randomEnabled: session.random_enabled,
        randomCharacterEnabled: session.random_character_enabled,
        history
      }
    };
  }

  private async buildPlotGenerationContext(
    manager: EntityManager,
    task: AiTaskEntity
  ): Promise<PlotGenerationProcessContext> {
    const draftId = typeof task.input_summary?.draft_id === 'string' ? task.input_summary.draft_id : null;
    if (!draftId) throw new Error(`Plot generation task ${task.id} missing draft_id`);
    const draft = await manager.getRepository(PlotGenerationDraftEntity).findOneBy({ id: draftId, work_id: task.work_id });
    if (!draft || draft.task_id !== task.id) throw new Error(`Plot generation task ${task.id} draft not found`);

    return {
      kind: 'plot',
      operation: 'generation',
      taskId: task.id,
      authorId: task.created_by,
      workId: task.work_id,
      tool: task.tool,
      inputSummary: task.input_summary,
      draftId: draft.id,
      plot: {
        workId: task.work_id,
        draftId: draft.id,
        source: draft.source as PlotTreeContext['source'],
        inputText: draft.input_text
      }
    };
  }

  private async finishPlotGenerationSucceeded(
    context: PlotGenerationProcessContext,
    payload: PlotTreeDraftPayload
  ): Promise<{ skipped: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const task = await manager.getRepository(AiTaskEntity).createQueryBuilder('task')
        .where('task.id = :taskId', { taskId: context.taskId })
        .setLock('pessimistic_write')
        .getOne();
      if (!task || task.status !== 'running') return { skipped: true };

      const result = await this.plotHandler.writeGeneration(manager, {
        taskId: task.id,
        draftId: context.draftId,
        workId: context.workId,
        payload
      });
      task.status = 'succeeded';
      await appendEvent(manager, task, this.eventBus, 'succeeded', {
        tool: context.tool,
        draft_id: result.draft_id
      });
      await this.auditService.record(context.authorId, 'ai_task_succeeded', 'ai_task', task.id, {
        tool: context.tool,
        draft_id: result.draft_id
      }, context.workId);
      return { skipped: false };
    });
  }

  /** 事务2（剧情）：锁任务，写入推衍步骤 + succeeded + 事件 + 审计（原子） */
  private async finishPlotSucceeded(
    context: PlotDerivationProcessContext,
    candidate: PlotStepCandidate
  ): Promise<{ skipped: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const task = await manager.getRepository(AiTaskEntity).createQueryBuilder('task')
        .where('task.id = :taskId', { taskId: context.taskId })
        .setLock('pessimistic_write')
        .getOne();
      if (!task || task.status !== 'running') return { skipped: true };

      const result = await this.plotHandler.writeStep(manager, {
        taskId: task.id,
        sessionId: context.sessionId,
        workId: context.workId,
        stepNo: context.stepNo,
        candidate
      });

      task.status = 'succeeded';
      await appendEvent(manager, task, this.eventBus, 'succeeded', {
        tool: context.tool,
        session_id: context.sessionId,
        step_no: result.step_no,
        step_id: result.step_id
      });

      await this.auditService.record(context.authorId, 'ai_task_succeeded', 'ai_task', task.id, {
        tool: context.tool,
        session_id: context.sessionId,
        step_no: result.step_no,
        step_id: result.step_id
      }, context.workId);

      return { skipped: false };
    });
  }

  /** 事务2：锁任务，创建修订集 + succeeded + 事件 + 审计（原子；执行期间被取消则跳过） */
  private async finishSucceeded(
    context: ChapterProcessContext,
    candidateDocument: ProseMirrorNode
  ): Promise<{ skipped: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const task = await manager.getRepository(AiTaskEntity).createQueryBuilder('task')
        .where('task.id = :taskId', { taskId: context.taskId })
        .setLock('pessimistic_write')
        .getOne();
      if (!task || task.status !== 'running') return { skipped: true }; // 被取消/状态异常 → 不落地结果

      const result = await this.mapper.toAiRevisionSet(manager, {
        authorId: context.authorId,
        workId: context.workId,
        chapterId: context.chapterId,
        baseVersion: context.baseVersion,
        candidateDocument
      });

      task.status = 'succeeded';
      task.result_revision_set_id = result.revision_set_id;
      await appendEvent(manager, task, this.eventBus, 'succeeded', {
        tool: context.tool,
        revision_set_id: result.revision_set_id,
        stale: result.stale,
        base_version: context.baseVersion
      });

      await this.auditService.record(context.authorId, 'ai_task_succeeded', 'ai_task', task.id, {
        chapter_id: context.chapterId,
        tool: context.tool,
        revision_set_id: result.revision_set_id,
        stale: result.stale
      }, context.workId);

      return { skipped: false };
    });
  }

  /** 事务2（角色）：锁任务，succeeded + SSE 事件 + 审计（原子） */
  private async finishCharacterSucceeded(
    context: CharacterProcessContext,
    summary: Record<string, unknown>
  ): Promise<{ skipped: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const task = await manager.getRepository(AiTaskEntity).createQueryBuilder('task')
        .where('task.id = :taskId', { taskId: context.taskId })
        .setLock('pessimistic_write')
        .getOne();
      if (!task || task.status !== 'running') return { skipped: true };

      task.status = 'succeeded';
      await appendEvent(manager, task, this.eventBus, 'succeeded', {
        tool: context.tool,
        ...summary
      });

      await this.auditService.record(context.authorId, 'ai_task_succeeded', 'ai_task', task.id, {
        tool: context.tool,
        scope: 'character',
        ...summary
      }, context.workId);

      return { skipped: false };
    });
  }

  /** F11 角色资料任务成功：锁任务 → succeeded + 审计（写回已由 handler 在事务内完成） */
  private async finishRoleProfileSucceeded(
    context: RoleProfileProcessContext,
    summary: Record<string, unknown>
  ): Promise<{ skipped: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const task = await manager.getRepository(AiTaskEntity).createQueryBuilder('task')
        .where('task.id = :taskId', { taskId: context.taskId })
        .setLock('pessimistic_write')
        .getOne();
      if (!task || task.status !== 'running') return { skipped: true };

      task.status = 'succeeded';
      await appendEvent(manager, task, this.eventBus, 'succeeded', {
        tool: context.tool,
        ...summary
      });

      await this.auditService.record(context.authorId, 'ai_task_succeeded', 'ai_task', task.id, {
        tool: context.tool,
        scope: 'role_profile',
        ...summary
      }, context.workId);

      return { skipped: false };
    });
  }

  /** 标记任务失败：锁任务，仅 running/queued 可转 failed（终态跳过，幂等） */
  private async markFailed(taskId: string, err: unknown): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    const isModel = err instanceof AiModelError || err instanceof PlotModelError;
    const isCollab = err instanceof CollabUpstreamError;
    const retryable = isModel || isCollab
      ? (err as { retryable: boolean }).retryable
      : true;
    const code = isModel || isCollab
      ? (err as { code: string }).code
      : 'UNKNOWN';
    const pendingCharacter: {
      context: CharacterTaskContext | null;
      error: Record<string, unknown> | null;
    } = { context: null, error: null };

    await this.dataSource.transaction(async (manager) => {
      const task = await manager.getRepository(AiTaskEntity).createQueryBuilder('task')
        .where('task.id = :taskId', { taskId })
        .setLock('pessimistic_write')
        .getOne();
      if (!task) return;
      if (task.status === 'cancelled' || task.status === 'succeeded' || task.status === 'failed') return;

      task.status = 'failed';
      task.error = { message, code, retryable };
      if (task.scope === 'plot' && task.tool === 'plot_generate') {
        await this.plotHandler.failGeneration(manager, {
          taskId: task.id,
          workId: task.work_id,
          error: task.error
        });
      }
      if (task.scope === 'character') {
        pendingCharacter.context = {
          taskId: task.id,
          authorId: task.created_by,
          workId: task.work_id,
          tool: task.tool,
          inputSummary: task.input_summary
        };
        pendingCharacter.error = task.error;
      }
      await appendEvent(manager, task, this.eventBus, 'failed', { message, code, retryable });

      await this.auditService.record(task.created_by, 'ai_task_failed', 'ai_task', task.id, {
        chapter_id: task.chapter_id,
        tool: task.tool,
        message,
        code,
        retryable
      }, task.work_id);
    });

    if (pendingCharacter.context && this.characterHandler) {
      await this.characterHandler
        .failDraft(pendingCharacter.context, pendingCharacter.error ?? { message, code, retryable })
        .catch(() => undefined);
    }
  }

  /** Worker 'failed' 兜底：最终失败但 DB 仍非终态 → 标 failed（process 内已处理则幂等跳过） */
  private async onJobFailed(job: Job<{ taskId: string }> | undefined, err: Error): Promise<void> {
    if (!job) return;
    const attempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < attempts) return; // 还会重试，不标
    await this.markFailed(job.data.taskId, err).catch((e) => this.logger.error(`markFailed fallback error: ${(e as Error).message}`));
  }

  private redisUrl(): string {
    return env.REDIS_URL;
  }
}
