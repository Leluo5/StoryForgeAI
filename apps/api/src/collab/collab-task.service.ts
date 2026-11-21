import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type { CollabArchiveStatus, CollabRoleField, CollabSettings, CollabTaskDetail, CollabWriteback, CollabWritebackField, CollabWritebackListResponse, CreateRoleProfileTaskRequest } from '@storyforge/contracts';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AiTaskEventEntity } from '../database/ai-task-event.entity';
import { AgentTaskCitationEntity } from '../database/agent-task-citation.entity';
import { RoleProfileWritebackEntity } from '../database/role-profile-writeback.entity';
import { RoleProfileWritebackFieldEntity } from '../database/role-profile-writeback-field.entity';
import { AgentArchiveOutboxEntity } from '../database/agent-archive-outbox.entity';
import { CharacterEntity } from '../database/character.entity';
import { AgentEntity } from '../database/agent.entity';
import { WorkEntity } from '../database/work.entity';
import { CollabService } from './collab.service';
import { CollabReadinessService } from './collab-readiness.service';
import { AI_TASK_QUEUE, type AiTaskQueuePort } from '../ai/ai-task.service';
import { AiTaskEventBus, AI_TASK_EVENT_BUS } from '../ai/ai-task.sse';
import { AuditService } from '../revision/audit.service';
import { CollabArchiveQueue } from './collab-archive.queue';

// F11 角色资料协同任务：创建（POST role-profile/tasks）与查询详情（GET role-profile/tasks/:taskId）
// 校验链（F2 §8.1）：作品归属 → 协同启用 → 测试角色匹配 → 字段白名单 → 通道就绪 → 幂等 → 创建入队

export interface CreateRoleProfileTaskInput extends CreateRoleProfileTaskRequest {
  /** 幂等键：Idempotency-Key 请求头（缺省随机生成） */
  idempotencyKey?: string;
}

@Injectable()
export class CollabTaskService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(CollabService) private readonly collab: CollabService,
    @Inject(CollabReadinessService) private readonly readiness: CollabReadinessService,
    @Inject(AI_TASK_QUEUE) private readonly queue: AiTaskQueuePort,
    @Inject(AI_TASK_EVENT_BUS) private readonly eventBus: AiTaskEventBus,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(CollabArchiveQueue) private readonly archiveQueue: CollabArchiveQueue
  ) {}

  /**
   * 创建角色资料协同任务。
   * 仅在协同启用、请求角色 = 配置测试角色、请求字段 ⊆ 白名单、通道已配置时才创建。
   */
  async createRoleProfileTask(
    authorId: string,
    workId: string,
    input: CreateRoleProfileTaskInput
  ): Promise<{ task: AiTaskEntity }> {
    const idempotencyKey = (input.idempotencyKey ?? '').trim() || `role-profile-${randomUUID()}`;

    return this.dataSource.transaction(async (manager) => {
      // 1. 协同配置（含作品归属校验；未配置视为未启用）
      const settings = await this.collab.getCollabSettings(authorId, workId);
      if (!settings) {
        throw new ConflictException({ code: 'COLLAB_DISABLED', message: '协同未启用' });
      }
      if (!settings.enabled) {
        throw new ConflictException({ code: 'COLLAB_DISABLED', message: '协同未启用' });
      }

      // 2. 测试角色匹配：仅配置的测试角色可发起
      if (input.character_id !== settings.test_character_id) {
        throw new ConflictException({ code: 'COLLAB_TEST_ROLE_MISMATCH', message: '角色不是配置的测试角色' });
      }
      const character = await manager.getRepository(CharacterEntity).findOneBy({
        id: input.character_id,
        work_id: workId
      });
      if (!character || character.status !== 'active') {
        throw new NotFoundException({ code: 'COLLAB_TEST_ROLE_MISMATCH', message: '测试角色必须属于该作品且为 active' });
      }

      // 3. 字段白名单：请求字段必须 ⊆ 配置白名单，且非空
      if (input.fields.length === 0) {
        throw new BadRequestException({ code: 'COLLAB_FIELD_NOT_ALLOWED', message: '至少选择 1 个字段' });
      }
      const allowed = new Set<CollabRoleField>(settings.whitelist_fields);
      const disallowed = input.fields.filter((field) => !allowed.has(field));
      if (disallowed.length > 0) {
        throw new BadRequestException({ code: 'COLLAB_FIELD_NOT_ALLOWED', message: `字段不在白名单: ${disallowed.join(', ')}` });
      }

      // 4. 通道就绪：取配置 Agent 的通道，需已配置
      const readiness = await this.readiness.getReadiness(authorId, workId);
      const channel = await this.resolveChannel(manager, settings, authorId, workId);
      const channelReady = readiness.channels[channel];
      if (!channelReady || !channelReady.configured) {
        throw new ConflictException({ code: 'COLLAB_CHANNEL_NOT_CONFIGURED', message: `通道 ${channel} 未配置` });
      }

      // 5. 幂等：同 idempotency_key 已存在则直接返回既有任务（不重复入队）
      const existing = await manager.getRepository(AiTaskEntity).findOneBy({
        idempotency_key: idempotencyKey,
        work_id: workId,
        scope: 'role_profile'
      });
      if (existing) return { task: existing, created: false };

      // 6. 创建任务（scope='role_profile'）
      const taskRepository = manager.getRepository(AiTaskEntity);
      const task = await taskRepository.save(taskRepository.create({
        id: randomUUID(),
        idempotency_key: idempotencyKey,
        work_id: workId,
        chapter_id: null,
        scope: 'role_profile',
        channel,
        tool: 'role_profile_generate',
        agent_id: settings.agent_id,
        input_summary: {
          character_id: input.character_id,
          fields: input.fields,
          instruction: input.instruction
        },
        base_version: character.version,
        status: 'queued',
        event_seq: 0,
        result_revision_set_id: null,
        error: null,
        attempts: 0,
        created_by: authorId
      }));

      await this.appendQueuedEvent(manager, task);
      await this.audit.record(authorId, 'ai_task_create', 'ai_task', task.id, {
        tool: task.tool,
        scope: 'role_profile',
        character_id: input.character_id,
        fields: input.fields
      }, workId);

      return { task, created: true };
    }).then(async (result) => {
      // 入队失败不阻断创建（任务状态已 queued，处理器兜底）；幂等命中不重复入队
      if (result.created) {
        await this.queue.enqueue(result.task.id).catch(() => undefined);
      }
      return { task: result.task };
    });
  }

  /**
   * 查询任务详情：任务 + 引用 + 写回单 + 归档状态。
   */
  async getTaskDetail(authorId: string, workId: string, taskId: string): Promise<CollabTaskDetail> {
    // 作品归属前置校验（复用 CollabService，保证跨作品不可读）
    await this.collab.getCollabSettings(authorId, workId).catch(() => {
      throw new NotFoundException('作品不存在');
    });

    const task = await this.dataSource.getRepository(AiTaskEntity).findOneBy({
      id: taskId,
      work_id: workId,
      scope: 'role_profile'
    });
    if (!task) throw new NotFoundException('协同任务不存在');

    const [citations, writeback, archive] = await Promise.all([
      this.dataSource.getRepository(AgentTaskCitationEntity).find({
        where: { task_id: taskId },
        order: { score: 'DESC' }
      }),
      this.dataSource.getRepository(RoleProfileWritebackEntity).findOneBy({ task_id: taskId }),
      this.dataSource.getRepository(AgentArchiveOutboxEntity).findOneBy({ task_id: taskId })
    ]);

    return {
      task: {
        id: task.id,
        status: task.status as CollabTaskDetail['task']['status'],
        channel: task.channel as CollabTaskDetail['task']['channel'],
        error: task.error
      },
      citations: citations.map((citation) => ({
        source_id: citation.source_id,
        title: citation.title,
        snippet: citation.snippet,
        score: citation.score === null ? null : Number(citation.score)
      })),
      writeback: writeback ? await this.mapWriteback(writeback.id) : null,
      archive: archive
        ? {
            status: archive.status as CollabArchiveStatus,
            attempts: archive.attempts,
            external_id: archive.external_id,
            delivered_at: archive.delivered_at ? archive.delivered_at.toISOString() : null
          }
        : null
    };
  }

  /**
   * 人工重试归档（F2 §5.6 / §4.1 POST archive-retry）。
   * 只重置同一行 outbox 并重新入队，不新增记录、不触碰任务与写回单。
   * 已投递则幂等返回当前状态。
   */
  async retryArchive(
    authorId: string,
    workId: string,
    taskId: string
  ): Promise<{ status: CollabArchiveStatus; attempts: number; external_id: string | null; delivered_at: string | null }> {
    await this.collab.getCollabSettings(authorId, workId).catch(() => {
      throw new NotFoundException('作品不存在');
    });

    const task = await this.dataSource.getRepository(AiTaskEntity).findOneBy({
      id: taskId,
      work_id: workId,
      scope: 'role_profile'
    });
    if (!task) throw new NotFoundException('协同任务不存在');

    const repo = this.dataSource.getRepository(AgentArchiveOutboxEntity);
    const outbox = await repo.findOneBy({ task_id: taskId });
    if (!outbox) throw new NotFoundException('归档记录不存在');

    const snapshot = () => ({
      status: outbox.status as CollabArchiveStatus,
      attempts: outbox.attempts,
      external_id: outbox.external_id,
      delivered_at: outbox.delivered_at ? outbox.delivered_at.toISOString() : null
    });

    // 已投递：不重复投递，直接返回既有记录
    if (outbox.status === 'delivered') return snapshot();

    // failed → 重置为 pending（不新增行），再重新入队；pending 视为投递在途，重复入队由 jobId 幂等吸收
    if (outbox.status === 'failed') {
      outbox.status = 'pending';
      outbox.last_error = null;
      outbox.updated_at = new Date();
      await repo.save(outbox);
    }

    await this.archiveQueue.enqueue(taskId, `retry:${outbox.attempts}:${Date.now()}`);
    await this.audit.record(authorId, 'collab_archive_retry', 'agent_archive_outbox', outbox.id, {
      task_id: taskId,
      attempts: outbox.attempts
    }, workId);

    return snapshot();
  }

  private async mapWriteback(writebackId: string): Promise<CollabWriteback> {
    const writeback = await this.dataSource.getRepository(RoleProfileWritebackEntity).findOneBy({ id: writebackId });
    if (!writeback) throw new NotFoundException('写回单不存在');
    const fields = await this.dataSource.getRepository(RoleProfileWritebackFieldEntity).find({
      where: { writeback_id: writebackId },
      order: { field_key: 'ASC' }
    });
    return {
      id: writeback.id,
      task_id: writeback.task_id,
      work_id: writeback.work_id,
      character_id: writeback.character_id,
      channel: writeback.channel as CollabWriteback['channel'],
      status: writeback.status as CollabWriteback['status'],
      applied_version: writeback.applied_version,
      applied_at: writeback.applied_at.toISOString(),
      fields: fields.map((field): CollabWritebackField => ({
        field_key: field.field_key as CollabRoleField,
        before_value: field.before_value,
        after_value: field.after_value,
        status: field.status as CollabWritebackField['status'],
        reverted_at: field.reverted_at ? field.reverted_at.toISOString() : null,
        reverted_by: field.reverted_by
      }))
    };
  }

  /**
   * 按作品列写回历史（F2 §5.3 GET /works/:workId/role-profile/writebacks）。
   * 可选按 character_id 过滤；按 applied_at 倒序。
   */
  async listWritebacks(
    authorId: string,
    workId: string,
    characterId?: string
  ): Promise<CollabWritebackListResponse> {
    const work = await this.dataSource.getRepository(WorkEntity).findOneBy({ id: workId });
    if (!work || work.author_id !== authorId) {
      throw new NotFoundException({ code: 'WORK_NOT_FOUND', message: '作品不存在' });
    }
    const where = characterId
      ? { work_id: workId, character_id: characterId }
      : { work_id: workId };
    const rows = await this.dataSource.getRepository(RoleProfileWritebackEntity).find({
      where,
      order: { applied_at: 'DESC' }
    });
    const items = await Promise.all(rows.map((row) => this.mapWriteback(row.id)));
    return { items };
  }

  private async resolveChannel(
    manager: EntityManager,
    settings: CollabSettings,
    authorId: string,
    workId: string
  ): Promise<'flowise' | 'coze'> {
    const agent = await manager.getRepository(AgentEntity).findOneBy({
      id: settings.agent_id,
      author_id: authorId
    });
    if (!agent) throw new NotFoundException('协同 Agent 不存在');
    // 通道取 Agent 模型平台（F11 执行通道 flowise / coze）；mock/其它视为未配置
    if (agent.platform === 'coze') return 'coze';
    if (agent.platform === 'flowise') return 'flowise';
    throw new ConflictException({ code: 'COLLAB_CHANNEL_NOT_CONFIGURED', message: 'Agent 平台通道不支持' });
  }

  private async appendQueuedEvent(manager: EntityManager, task: AiTaskEntity): Promise<void> {
    const repository = manager.getRepository(AiTaskEventEntity);
    const event = repository.create({
      id: randomUUID(),
      task_id: task.id,
      event_seq: task.event_seq + 1,
      type: 'queued',
      payload: { tool: task.tool, scope: task.scope }
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
