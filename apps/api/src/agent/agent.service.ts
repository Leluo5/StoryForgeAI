import { Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type {
  Agent,
  AgentListItem,
  AiToolListItem,
  AgentSummary,
  CreateAgentInput,
  UpdateAgentInput,
  UpdateToolInput,
  ListAgentsResponse,
  ListToolsResponse
} from '@storyforge/contracts';
import { AgentEntity } from '../database/agent.entity';
import { AiToolEntity } from '../database/ai-tool.entity';
import { AuditService } from '../revision/audit.service';

// ───────────────────────────── 实体 ↔ 契约映射 ─────────────────────────────

function toAgent(entity: AgentEntity): Agent {
  return {
    id: entity.id,
    author_id: entity.author_id,
    name: entity.name,
    platform: entity.platform as Agent['platform'],
    model_id: entity.model_id,
    model_config: entity.model_config,
    status: entity.status as Agent['status'],
    is_default: entity.is_default,
    created_at: entity.created_at.toISOString(),
    updated_at: entity.updated_at.toISOString()
  };
}

function toAgentSummary(entity: AgentEntity): AgentSummary {
  return {
    id: entity.id,
    name: entity.name,
    platform: entity.platform as AgentSummary['platform'],
    model_id: entity.model_id,
    status: entity.status as AgentSummary['status']
  };
}

function toToolListItem(entity: AiToolEntity, boundAgent: AgentEntity | null): AiToolListItem {
  return {
    id: entity.id,
    tool_id: entity.tool_id,
    name: entity.name,
    description: entity.description,
    agent_id: entity.agent_id,
    enabled: entity.enabled,
    created_at: entity.created_at.toISOString(),
    updated_at: entity.updated_at.toISOString(),
    bound_agent: boundAgent ? toAgentSummary(boundAgent) : null
  };
}

@Injectable()
export class AgentService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  /**
   * 确保作者有默认 Agent：无任何 Agent 时懒创建默认 Mock Agent 并绑定全部启用工具。
   * 并发安全：唯一部分索引 uq_ai_agents_author_default 兜底（同作者同刻仅一个默认）。
   * 返回该作者的默认 Agent（不存在时新建）。
   */
  async ensureDefaultAgent(authorId: string): Promise<AgentEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AgentEntity);
      const existing = await repo
        .createQueryBuilder('agent')
        .where('agent.author_id = :authorId', { authorId })
        .andWhere('agent.is_default = true')
        .getOne();
      if (existing) return existing;

      // 作者无默认 Agent → 创建默认 Mock Agent
      const anyAgent = await repo.findOneBy({ author_id: authorId });
      if (anyAgent) {
        // 已有 Agent 但无默认 → 提升第一个为默认（避免重复创建）
        anyAgent.is_default = true;
        await manager.save(anyAgent);
        return anyAgent;
      }

      const agent = repo.create();
      agent.id = randomUUID();
      agent.author_id = authorId;
      agent.name = '默认创作 Agent';
      agent.platform = 'mock';
      agent.model_id = 'mock-default';
      agent.model_config = { temperature: 0.7, max_tokens: 2048 };
      agent.status = 'active';
      agent.is_default = true;
      await manager.save(agent).catch((err: { code?: string }) => {
        // 并发撞唯一部分索引 → 已有默认，读回
        if (err?.code === '23505') return;
        throw err;
      });

      // 绑定全部启用工具到默认 Agent（保证缺配置不中断）
      const tools = await manager.getRepository(AiToolEntity).find({ where: { enabled: true } });
      for (const tool of tools) {
        if (!tool.agent_id) {
          tool.agent_id = agent.id;
          await manager.save(tool);
        }
      }
      return agent;
    });
  }

  /** 列出作者全部 Agent（含绑定工具数） */
  async listAgents(authorId: string): Promise<ListAgentsResponse> {
    const agents = await this.dataSource.getRepository(AgentEntity)
      .createQueryBuilder('agent')
      .where('agent.author_id = :authorId', { authorId })
      .orderBy('agent.created_at', 'ASC')
      .getMany();
    const tools = await this.dataSource.getRepository(AiToolEntity).find();
    const items: AgentListItem[] = agents.map((agent) => ({
      ...toAgent(agent),
      bound_tool_count: tools.filter((t) => t.agent_id === agent.id).length
    }));
    return { agents: items };
  }

  /** 创建 Agent（默认互斥：is_default=true 时清掉其他默认） */
  async createAgent(authorId: string, input: CreateAgentInput): Promise<{ agent: Agent }> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AgentEntity);
      const dup = await repo.findOneBy({ author_id: authorId, name: input.name });
      if (dup) throw new ConflictException({ message: 'Agent name already exists' });

      const agent = repo.create();
      agent.id = randomUUID();
      agent.author_id = authorId;
      agent.name = input.name;
      agent.platform = input.platform ?? 'mock';
      agent.model_id = input.model_id;
      agent.model_config = input.model_config ?? {};
      agent.status = 'active';
      agent.is_default = input.is_default ?? false;
      // 若设为默认或作者首个 Agent，清掉其他默认
      if (agent.is_default) await this.clearOtherDefaults(manager, authorId);
      await manager.save(agent);
      await this.auditService.record(authorId, 'agent_create', 'ai_agent', agent.id, {
        name: agent.name,
        platform: agent.platform
      });
      return { agent: toAgent(agent) };
    });
  }

  /** 更新 Agent（默认互斥 + 软删状态机） */
  async updateAgent(authorId: string, agentId: string, input: UpdateAgentInput): Promise<{ agent: Agent }> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AgentEntity);
      const agent = await repo.findOneBy({ id: agentId, author_id: authorId });
      if (!agent) throw new NotFoundException('Agent not found');

      if (input.name !== undefined && input.name !== agent.name) {
        const dup = await repo.findOneBy({ author_id: authorId, name: input.name });
        if (dup && dup.id !== agentId) throw new ConflictException({ message: 'Agent name already exists' });
        agent.name = input.name;
      }
      if (input.model_id !== undefined) agent.model_id = input.model_id;
      if (input.model_config !== undefined) agent.model_config = input.model_config;
      if (input.status !== undefined) {
        // 不允许禁用默认 Agent（至少保留一个可用执行者）
        if (input.status === 'disabled' && agent.is_default) {
          throw new ConflictException({ message: 'Cannot disable the default agent' });
        }
        agent.status = input.status;
      }
      if (input.is_default !== undefined) {
        if (input.is_default && !agent.is_default) await this.clearOtherDefaults(manager, authorId);
        agent.is_default = input.is_default;
      }
      await manager.save(agent);
      await this.auditService.record(authorId, 'agent_update', 'ai_agent', agent.id, {
        fields: Object.keys(input)
      });
      return { agent: toAgent(agent) };
    });
  }

  /** 删除 Agent（软删=disabled；若绑定工具则解绑，SET NULL） */
  async deleteAgent(authorId: string, agentId: string): Promise<{ ok: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AgentEntity);
      const agent = await repo.findOneBy({ id: agentId, author_id: authorId });
      if (!agent) throw new NotFoundException('Agent not found');
      if (agent.is_default) throw new ConflictException({ message: 'Cannot delete the default agent' });

      agent.status = 'disabled';
      await manager.save(agent);
      // 解绑绑定此 Agent 的工具
      await manager.getRepository(AiToolEntity)
        .createQueryBuilder()
        .update()
        .set({ agent_id: null })
        .where('agent_id = :agentId', { agentId })
        .execute();
      await this.auditService.record(authorId, 'agent_delete', 'ai_agent', agent.id, {
        name: agent.name
      });
      return { ok: true };
    });
  }

  /** 列出全部工具（含绑定 Agent 概要） */
  async listTools(authorId: string): Promise<ListToolsResponse> {
    const tools = await this.dataSource.getRepository(AiToolEntity)
      .createQueryBuilder('tool')
      .orderBy('tool.tool_id', 'ASC')
      .getMany();
    const agentIds = [...new Set(tools.map((t) => t.agent_id).filter(Boolean))] as string[];
    const agents = agentIds.length
      ? await this.dataSource.getRepository(AgentEntity).find({ where: agentIds.map((id) => ({ id })) })
      : [];
    const agentMap = new Map(agents.map((a) => [a.id, a]));
    const items = tools.map((t) => toToolListItem(t, t.agent_id ? agentMap.get(t.agent_id) ?? null : null));
    return { tools: items };
  }

  /** 更新工具（绑定 Agent / 启停 / 改名）；停用工具时若其绑定 Agent 为默认则不阻断，仅提示 */
  async updateTool(authorId: string, toolId: string, input: UpdateToolInput): Promise<{ tool: AiToolListItem; warning: string | null }> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AiToolEntity);
      const tool = await repo.findOneBy({ tool_id: toolId });
      if (!tool) throw new NotFoundException('AI tool not found');

      if (input.name !== undefined) tool.name = input.name;
      if (input.description !== undefined) tool.description = input.description;
      if (input.enabled !== undefined) tool.enabled = input.enabled;
      if (input.agent_id !== undefined) {
        if (input.agent_id !== null) {
          const agent = await manager.getRepository(AgentEntity).findOneBy({ id: input.agent_id, author_id: authorId });
          if (!agent) throw new NotFoundException('Agent not found');
        }
        tool.agent_id = input.agent_id;
      }
      await manager.save(tool);

      let warning: string | null = null;
      if (input.enabled === false && tool.agent_id) {
        warning = '工具已停用，进行中的 AI 任务不受影响，新任务将被拒绝';
      }
      const boundAgent = tool.agent_id
        ? await manager.getRepository(AgentEntity).findOneBy({ id: tool.agent_id })
        : null;
      await this.auditService.record(authorId, 'ai_tool_update', 'ai_tool', tool.id, {
        tool_id: tool.tool_id,
        fields: Object.keys(input)
      });
      return { tool: toToolListItem(tool, boundAgent), warning };
    });
  }

  /** 供 M3a 发起任务解析：校验工具存在且启用，返回工具（含绑定 Agent 判定） */
  async resolveToolForTask(toolId: string): Promise<{ tool: AiToolEntity; agentId: string | null }> {
    const tool = await this.dataSource.getRepository(AiToolEntity).findOneBy({ tool_id: toolId });
    if (!tool) throw new NotFoundException({ message: 'AI tool not found', details: { tool_id: toolId } });
    if (!tool.enabled) {
      throw new ConflictException({ message: 'AI tool is disabled', details: { tool_id: toolId } });
    }
    return { tool, agentId: tool.agent_id };
  }

  private async clearOtherDefaults(manager: EntityManager, authorId: string): Promise<void> {
    await manager.getRepository(AgentEntity)
      .createQueryBuilder()
      .update()
      .set({ is_default: false })
      .where('author_id = :authorId', { authorId })
      .andWhere('is_default = true')
      .execute();
  }
}
