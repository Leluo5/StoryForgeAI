import { Injectable, NotFoundException, ConflictException, BadRequestException, Inject } from '@nestjs/common';
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
  ListToolsResponse,
  GetAgentDetailResponse,
  CreateAgentV2Input,
  UpdateAgentV2Input,
  ListAgentsV2Query,
  AgentVersionSummary,
  AgentStatusV2
} from '@storyforge/contracts';
import { validateAgentIdentity } from '@storyforge/contracts';
import { AgentEntity } from '../database/agent.entity';
import { AiToolEntity } from '../database/ai-tool.entity';
import { AuditService } from '../revision/audit.service';
import { AgentVersionService } from './agent-version.service';
import { AgentProvisionService } from './agent-provision.service';
import { AgentGroupService } from './agent-group.service';
import { FlowProgressService } from './flow-progress.service';

// ───────────────────────────── 实体 ↔ 契约映射 ─────────────────────────────

function toAgent(entity: AgentEntity): Agent {
  return {
    id: entity.id,
    author_id: entity.author_id,
    name: entity.name,
    platform: entity.platform as Agent['platform'],
    platform_config: entity.platform_config ?? {},
    model_id: entity.model_id,
    model_config: entity.model_config,
    status: entity.status as Agent['status'],
    is_default: entity.is_default,
    // 功能描述（V2 实体已有字段；V1 契约映射补齐）
    description: entity.description ?? '',
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
    @Inject(AuditService) private readonly auditService: AuditService,
    private readonly versionService: AgentVersionService,
    private readonly provisionService: AgentProvisionService,
    private readonly groupService: AgentGroupService,
    private readonly flowProgressService: FlowProgressService
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

  /** 获取单个 Agent 详情（含已绑定工具列表） */
  async getAgentDetail(authorId: string, agentId: string): Promise<GetAgentDetailResponse> {
    const repo = this.dataSource.getRepository(AgentEntity);
    const agent = await repo.findOneBy({ id: agentId, author_id: authorId });
    if (!agent) throw new NotFoundException('Agent not found');

    const tools = await this.dataSource.getRepository(AiToolEntity).find();
    const boundTools = tools.filter((t) => t.agent_id === agent.id);
    const boundToolItems: AiToolListItem[] = boundTools.map((t) =>
      toToolListItem(t, agent)
    );
    return {
      agent: { ...toAgent(agent), bound_tool_count: boundTools.length },
      tools: boundToolItems
    };
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
      agent.platform_config = input.platform_config ?? {};
      agent.model_id = input.model_id;
      agent.model_config = input.model_config ?? {};
      agent.status = 'active';
      agent.is_default = input.is_default ?? false;
      // F1 扩展：Coze 导入可携带 description/kind/source/scope/project_id（均可选，普通创建不受影响）
      if (input.description !== undefined) agent.description = input.description;
      if (input.kind !== undefined) agent.kind = input.kind;
      if (input.source !== undefined) agent.source = input.source;
      if (input.scope !== undefined) agent.scope = input.scope;
      if (input.project_id !== undefined) agent.project_id = input.project_id;
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
      if (input.platform !== undefined) agent.platform = input.platform;
      if (input.platform_config !== undefined) agent.platform_config = input.platform_config;
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

  // ═══════════════════════════════════════════════════════════════════
  // V2 方法：作品级 Agent 管理（版本快照 / 分组 / 流程进度）
  // 所有 V2 方法开头先校验 authorId 归属
  // ═══════════════════════════════════════════════════════════════════

  /**
   * V2 创建 Agent（作品级）：kind 互斥校验 + 版本快照 version_no=1。
   */
  async createAgentV2(authorId: string, input: CreateAgentV2Input): Promise<AgentEntity> {
    try {
      validateAgentIdentity({
        kind: input.kind ?? 'legacy',
        role_id: input.role_id ?? null,
        tool_name: input.tool_name ?? null,
        step_order: input.step_order ?? null
      });
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }

    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AgentEntity);
      const agent = repo.create();
      agent.id = randomUUID();
      agent.author_id = authorId;
      agent.project_id = input.project_id ?? null;
      agent.kind = input.kind ?? 'legacy';
      agent.name = input.name;
      agent.description = input.description ?? '';
      agent.platform = input.platform ?? 'mock';
      agent.platform_config = input.platform_config ?? {};
      agent.model_id = input.model_id ?? 'default';
      agent.model_config = input.model_config ?? {};
      agent.role_id = input.role_id ?? null;
      agent.tool_name = input.tool_name ?? null;
      agent.step_order = input.step_order ?? null;
      agent.scope = input.scope ?? 'project';
      agent.source = input.source ?? 'manual';
      agent.tags = input.tags ?? [];
      agent.status = 'active';
      agent.is_default = input.is_default ?? false;
      agent.version_no = 1;
      agent.versions = [];
      agent.archived_at = null;

      if (agent.is_default && agent.project_id) {
        await this.clearOtherDefaultsV2(manager, authorId, agent.project_id, agent.kind);
      }

      // 初始版本快照
      this.versionService.snapshot(agent, 'create', '创建 Agent');

      await manager.save(agent);
      await this.auditService.record(authorId, 'agent_create_v2', 'ai_agent', agent.id, {
        kind: agent.kind,
        project_id: agent.project_id,
        name: agent.name
      });

      return agent;
    });
  }

  /**
   * V2 列出 Agent：支持多维度过滤 + 分页。
   */
  async listAgentsV2(
    authorId: string,
    query: ListAgentsV2Query
  ): Promise<{ items: AgentEntity[]; total: number; page: number; page_size: number }> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;

    const qb = this.dataSource.getRepository(AgentEntity)
      .createQueryBuilder('agent')
      .where('agent.author_id = :authorId', { authorId });

    if (query.project_id) {
      qb.andWhere('agent.project_id = :projectId', { projectId: query.project_id });
    }
    if (query.kind) {
      qb.andWhere('agent.kind = :kind', { kind: query.kind });
    }
    if (query.status) {
      qb.andWhere('agent.status = :status', { status: query.status });
    }
    if (query.role_id) {
      qb.andWhere('agent.role_id = :roleId', { roleId: query.role_id });
    }
    if (query.tool_name) {
      qb.andWhere('agent.tool_name = :toolName', { toolName: query.tool_name });
    }
    if (query.keyword) {
      qb.andWhere('agent.name ILIKE :keyword', { keyword: `%${query.keyword}%` });
    }

    const [items, total] = await qb
      .orderBy('agent.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    return { items, total, page, page_size: pageSize };
  }

  /**
   * V2 获取 Agent 详情。includeVersions=false 时从返回中剥 versions 字段。
   */
  async getAgentV2(
    authorId: string,
    agentId: string,
    includeVersions = true
  ): Promise<AgentEntity> {
    const agent = await this.dataSource.getRepository(AgentEntity)
      .findOneBy({ id: agentId, author_id: authorId });
    if (!agent) throw new NotFoundException('Agent not found');

    if (!includeVersions) {
      // 返回前克隆并剥掉 versions 数组
      const { versions, ...rest } = agent as unknown as { versions: unknown[]; [k: string]: unknown };
      void versions; // 静默未使用
      return rest as unknown as AgentEntity;
    }
    return agent;
  }

  /**
   * V2 更新 Agent（白名单字段 + 版本快照 + 审计）。
   */
  async updateAgentV2(
    authorId: string,
    agentId: string,
    input: UpdateAgentV2Input
  ): Promise<AgentEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AgentEntity);
      const agent = await repo.findOneBy({ id: agentId, author_id: authorId });
      if (!agent) throw new NotFoundException('Agent not found');

      // 白名单：只更新 input 中存在的字段
      if (input.name !== undefined) agent.name = input.name;
      if (input.description !== undefined) agent.description = input.description;
      if (input.platform !== undefined) agent.platform = input.platform;
      if (input.platform_config !== undefined) agent.platform_config = input.platform_config;
      if (input.model_id !== undefined) agent.model_id = input.model_id;
      if (input.model_config !== undefined) agent.model_config = input.model_config;
      if (input.status !== undefined) {
        const status = input.status as AgentStatusV2;
        // 不允许禁用默认 Agent
        if (status === 'disabled' && agent.is_default) {
          throw new ConflictException('Cannot disable the default agent');
        }
        agent.status = status;
        if (status === 'archived') {
          agent.archived_at = new Date();
        } else {
          // 非 archived 状态清除归档时间
          agent.archived_at = null;
        }
      }
      if (input.is_default !== undefined) {
        if (input.is_default && agent.project_id) {
          await this.clearOtherDefaultsV2(manager, authorId, agent.project_id, agent.kind);
        }
        agent.is_default = input.is_default;
      }
      if (input.tags !== undefined) agent.tags = input.tags;
      if (input.manual_group_key !== undefined) {
        agent.manual_group_key = input.manual_group_key;
      }

      // 版本快照 + 审计
      this.versionService.snapshot(agent, 'update', `更新字段: ${Object.keys(input).join(',')}`);
      await manager.save(agent);
      await this.auditService.record(authorId, 'agent_update_v2', 'ai_agent', agent.id, {
        fields: Object.keys(input)
      });

      return agent;
    });
  }

  /**
   * 归档 Agent：status=archived + archived_at=now + 版本快照 + 审计。
   * 仅对非已归档 Agent 生效。
   */
  async archiveAgent(authorId: string, agentId: string): Promise<AgentEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AgentEntity);
      const agent = await repo.findOneBy({ id: agentId, author_id: authorId });
      if (!agent) throw new NotFoundException('Agent not found');
      if (agent.status === 'archived') {
        throw new ConflictException('Agent is already archived');
      }

      agent.status = 'archived';
      agent.archived_at = new Date();
      this.versionService.snapshot(agent, 'archive', '归档 Agent');
      await manager.save(agent);
      await this.auditService.record(authorId, 'agent_archive', 'ai_agent', agent.id, {
        name: agent.name
      });

      return agent;
    });
  }

  /**
   * 恢复 Agent：status=active + archived_at=null + 版本快照 + 审计。
   * 仅对已归档 Agent 生效。
   */
  async restoreAgent(authorId: string, agentId: string): Promise<AgentEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AgentEntity);
      const agent = await repo.findOneBy({ id: agentId, author_id: authorId });
      if (!agent) throw new NotFoundException('Agent not found');
      if (agent.status !== 'archived') {
        throw new ConflictException('Agent is not archived');
      }

      agent.status = 'active';
      agent.archived_at = null;
      this.versionService.snapshot(agent, 'restore', '恢复 Agent');
      await manager.save(agent);
      await this.auditService.record(authorId, 'agent_restore', 'ai_agent', agent.id, {
        name: agent.name
      });

      return agent;
    });
  }

  /**
   * 强制删除 Agent（硬删）。
   * 规则：未归档且 !force → 抛 409；已归档 → 硬删；同时解除 role_agent_bindings。
   */
  async forceDeleteAgent(authorId: string, agentId: string, force = false): Promise<{ ok: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const agentRepo = manager.getRepository(AgentEntity);
      const bindingRepo = manager.getRepository('role_agent_bindings' as any);

      const agent = await agentRepo.findOneBy({ id: agentId, author_id: authorId });
      if (!agent) throw new NotFoundException('Agent not found');

      if (agent.status !== 'archived' && !force) {
        throw new ConflictException({
          message: 'Agent is not archived. Set force=true to hard-delete an active/disabled agent.',
          current_status: agent.status
        });
      }

      // 解除 role_agent_bindings
      await bindingRepo
        .createQueryBuilder()
        .delete()
        .where('agent_id = :agentId', { agentId })
        .execute();

      // 解除 ai_tools 绑定
      await manager.getRepository(AiToolEntity)
        .createQueryBuilder()
        .update()
        .set({ agent_id: null })
        .where('agent_id = :agentId', { agentId })
        .execute();

      // 硬删
      await agentRepo.remove(agent);

      await this.auditService.record(authorId, 'agent_force_delete', 'ai_agent', agent.id, {
        name: agent.name,
        was_archived: agent.status === 'archived'
      });

      return { ok: true };
    });
  }

  /**
   * 获取 Agent 的版本历史摘要（不含 snapshot 内容）。
   */
  async listVersions(authorId: string, agentId: string): Promise<AgentVersionSummary[]> {
    const agent = await this.dataSource.getRepository(AgentEntity)
      .findOneBy({ id: agentId, author_id: authorId });
    if (!agent) throw new NotFoundException('Agent not found');

    return this.versionService.summarize(agent);
  }

  /**
   * 回滚 Agent 到指定版本（事务 + 版本服务 + 审计）。
   */
  async rollbackVersion(authorId: string, agentId: string, versionNo: number): Promise<AgentEntity> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AgentEntity);
      const agent = await repo.findOneBy({ id: agentId, author_id: authorId });
      if (!agent) throw new NotFoundException('Agent not found');

      // 版本回滚
      this.versionService.rollback(agent, versionNo);
      await manager.save(agent);

      await this.auditService.record(authorId, 'agent_rollback', 'ai_agent', agent.id, {
        target_version: versionNo,
        new_version: agent.version_no
      });

      return agent;
    });
  }

  // ───────────────────────────── V2 内部辅助 ─────────────────────────────

  /** V2 的默认互斥清理：按 (project_id, kind) 维度清掉其他默认 */
  private async clearOtherDefaultsV2(
    manager: EntityManager,
    authorId: string,
    projectId: string,
    kind: string
  ): Promise<void> {
    await manager.getRepository(AgentEntity)
      .createQueryBuilder()
      .update()
      .set({ is_default: false })
      .where('author_id = :authorId', { authorId })
      .andWhere('project_id = :projectId', { projectId })
      .andWhere('kind = :kind', { kind })
      .andWhere('is_default = true')
      .execute();
  }
}
