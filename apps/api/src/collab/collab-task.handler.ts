import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CollabRoleField } from '@storyforge/contracts';
import { collabRoleFieldSchema } from '@storyforge/contracts';
import { AiTaskEntity } from '../database/ai-task.entity';
import { CollabSettingEntity } from '../database/collab-setting.entity';
import { CharacterEntity } from '../database/character.entity';
import { AgentEntity } from '../database/agent.entity';
import { AgentTaskCitationEntity } from '../database/agent-task-citation.entity';
import { FastGptClient } from './retrieval/fastgpt.client';
import { mapCitations } from './retrieval/citation.mapper';
import { AgentChannelRegistry } from './channel/agent-channel.registry';
import { CollabUpstreamError } from './channel/collab-upstream.error';
import { buildRoleContext } from './collab-context.builder';
import { validateGeneratedResult } from './collab-result.validator';
import { COLLAB_WRITEBACK_PORT, type CollabWritebackPort } from './collab-writeback.port';
import { CollabArchiveQueue } from './collab-archive.queue';

// F11 角色资料任务处理器：编排 检索 → 引用落库 → 通道生成 → 结果校验 → 写回（F2 §5.2-5.4）
// 处理器只依赖通道端口与写回端口，不出现厂商分支（F2 §5.1）
// 引用先落库再生成，生成失败也保留引用，便于排查（F2 §5.2 第4条）
// 任一校验失败不进入写回事务，角色原值不变（F2 §1.1 第6条）

export interface RoleProfileTaskContext {
  taskId: string;
  authorId: string;
  workId: string;
  tool: string;
  inputSummary: Record<string, unknown>;
}

// input_summary 结构校验（任务创建时写入）
const roleProfileInputSchema = z.object({
  character_id: z.string().uuid(),
  fields: z.array(collabRoleFieldSchema).min(2).max(3),
  instruction: z.string().trim().min(1).max(500)
});

interface LoadedRoleProfile {
  characterId: string;
  fields: CollabRoleField[];
  instruction: string;
  channel: 'flowise' | 'coze';
  chatflowId: string | undefined;
}

@Injectable()
export class CollabTaskHandler {
  private readonly logger = new Logger(CollabTaskHandler.name);

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(FastGptClient) private readonly fastGpt: FastGptClient,
    @Inject(AgentChannelRegistry) private readonly channelRegistry: AgentChannelRegistry,
    @Inject(COLLAB_WRITEBACK_PORT) private readonly writeback: CollabWritebackPort,
    @Inject(CollabArchiveQueue) private readonly archiveQueue: CollabArchiveQueue
  ) {}

  /** 完整编排：返回写回摘要（处理器写入 succeeded 事件与审计） */
  async handle(ctx: RoleProfileTaskContext): Promise<Record<string, unknown>> {
    const loaded = await this.loadRoleProfile(ctx);

    // 1) 构建最小上下文（仅白名单字段 + 指令 + 角色名 + 引用摘录）
    const roleContext = buildRoleContext({
      instruction: loaded.instruction,
      character: {
        name: loaded.characterName,
        fields: loaded.characterFields
      },
      outputFields: loaded.fields,
      citations: [] // 检索后填充
    });

    // 2) FastGPT 检索（演示库）→ 引用映射
    const search = await this.fastGpt.search(roleContext.instruction);
    const citations = mapCitations(search.hits, search.datasetId);

    // 3) 引用先落库（独立提交；生成失败也保留引用）
    await this.saveCitations(ctx.taskId, search.datasetId, citations);

    // 4) 通道生成（channel 来自任务列，执行期间只读）；chatflowId 仅 Flowise 需要
    const channel = this.channelRegistry.get(loaded.channel);
    const result = await channel.invoke({
      taskId: ctx.taskId,
      workId: ctx.workId,
      channel: loaded.channel,
      ...(loaded.chatflowId ? { chatflowId: loaded.chatflowId } : {}),
      instruction: loaded.instruction,
      roleContext: roleContext.character.fields,
      citations,
      outputFields: loaded.fields
    });

    // 5) 结果结构校验（键集合 = 请求字段，值字符串/长度；写回目标来自 DB 白名单）
    const validated = validateGeneratedResult({
      rawText: result.rawText,
      expectedFields: loaded.fields
    });

    // 6) 写回（端口，T14 落地；单事务，任一校验失败不产生部分写回）
    const writeback = await this.dataSource.transaction((manager) =>
      this.writeback.applyWriteback(manager, {
        taskId: ctx.taskId,
        workId: ctx.workId,
        characterId: loaded.characterId,
        channel: loaded.channel,
        appliedBy: ctx.authorId,
        fields: validated.fields,
        citations,
        resultText: result.rawText
      })
    );

    // 事务提交后才投递归档任务：投递失败只影响 outbox 状态，不影响已提交的写回与任务成功（F2 §5.4）
    // 入队失败不阻断（outbox 已落库为 pending，可经人工重试补齐）
    await this.archiveQueue.enqueue(ctx.taskId).catch((error: unknown) => {
      this.logger.warn(`归档入队失败 task=${ctx.taskId}: ${error instanceof Error ? error.message : '未知错误'}`);
    });

    return {
      scope: 'role_profile',
      character_id: loaded.characterId,
      channel: loaded.channel,
      citation_count: citations.length,
      writeback_id: writeback.writebackId,
      applied_version: writeback.appliedVersion
    };
  }

  /** 装载并校验：配置开关、测试角色、白名单、通道就绪 */
  private async loadRoleProfile(ctx: RoleProfileTaskContext): Promise<LoadedRoleProfile & { characterName: string; characterFields: Record<string, unknown> }> {
    const parsed = roleProfileInputSchema.parse(ctx.inputSummary);

    return this.dataSource.transaction(async (manager) => {
      // 读协同配置（作品级）
      const setting = await manager.getRepository(CollabSettingEntity).findOneBy({ work_id: ctx.workId });
      if (!setting || !setting.enabled) {
        throw new CollabUpstreamError('协同未启用', false, 'COLLAB_DISABLED');
      }

      // 目标角色必须是配置的测试角色
      if (setting.test_character_id !== parsed.character_id) {
        throw new CollabUpstreamError('角色不是配置的测试角色', false, 'COLLAB_TEST_ROLE_MISMATCH');
      }

      // 请求字段必须都在白名单
      const whitelist = new Set(setting.whitelist_fields);
      for (const field of parsed.fields) {
        if (!whitelist.has(field)) {
          throw new CollabUpstreamError(`字段不在白名单: ${field}`, false, 'COLLAB_FIELD_NOT_ALLOWED');
        }
      }

      // 角色行 + 当前字段值（用于上下文裁剪）
      const character = await manager.getRepository(CharacterEntity).findOneBy({ id: parsed.character_id, work_id: ctx.workId });
      if (!character) {
        throw new CollabUpstreamError('角色不存在', false, 'COLLAB_TEST_ROLE_MISMATCH');
      }
      const characterFields: Record<string, unknown> = {
        identity: character.identity,
        personality: character.personality,
        experience: character.experience
      };

      // 执行 Agent（通道取其 platform + chatflow id）
      const agent = await manager.getRepository(AgentEntity).findOneBy({ id: setting.agent_id });
      if (!agent) {
        throw new CollabUpstreamError('执行 Agent 不存在', false, 'COLLAB_CHANNEL_NOT_CONFIGURED');
      }
      if (agent.platform !== 'flowise' && agent.platform !== 'coze') {
        throw new CollabUpstreamError('执行 Agent 通道必须是 flowise 或 coze', false, 'COLLAB_CHANNEL_NOT_CONFIGURED');
      }
      const chatflowId = typeof agent.platform_config?.flowise_chatflow_id === 'string'
        ? agent.platform_config.flowise_chatflow_id
        : undefined;
      if (agent.platform === 'flowise' && !chatflowId) {
        throw new CollabUpstreamError('Flowise Chatflow 标识缺失', false, 'COLLAB_CHANNEL_NOT_CONFIGURED');
      }

      return {
        characterId: parsed.character_id,
        fields: parsed.fields,
        instruction: parsed.instruction,
        channel: agent.platform as 'flowise' | 'coze',
        chatflowId,
        characterName: character.name,
        characterFields
      };
    });
  }

  /** 引用快照落库（独立事务，失败不阻断生成，仅记录日志） */
  private async saveCitations(
    taskId: string,
    datasetId: string,
    citations: Array<{ source_id: string; title: string; snippet: string; score: number | null }>
  ): Promise<void> {
    try {
      await this.dataSource.transaction(async (manager) => {
        const repo = manager.getRepository(AgentTaskCitationEntity);
        for (const c of citations) {
          const entity = repo.create({
            id: randomUUID(),
            task_id: taskId,
            dataset_id: datasetId,
            source_id: c.source_id,
            title: c.title,
            snippet: c.snippet,
            score: c.score === null ? null : String(c.score)
          });
          await repo.save(entity);
        }
      });
    } catch (err) {
      // 引用落库失败不阻断生成流程，仅记录（F2 §5.2 第4条语义：引用先入库，但落库失败不阻塞主链路）
      this.logger.warn(`引用快照落库失败 task=${taskId}: ${(err as Error).message}`);
    }
  }
}
