import { Inject, Injectable, Logger } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InjectRepository } from '@nestjs/typeorm';
import { AgentEntity } from '../database/agent.entity';
import { AiToolEntity } from '../database/ai-tool.entity';
import { RoleAgentBindingEntity } from '../database/role-agent-binding.entity';
import { AgentVersionService } from './agent-version.service';
import type { ToolAgentSummary } from '@storyforge/contracts';
import type { AgentSummary } from '@storyforge/contracts';

const logger = new Logger('AgentProvisionService');

/**
 * 判断是否为唯一约束冲突（PG 23505）。
 * TypeORM 会把驱动错误包在 QueryFailedError 里：err.code 是其自身类型标识（如 ERR_QUERY_FAILED），
 * 真正的 PG 错误码在 err.databaseError.code，需两者都查。
 */
function isUniqueViolation(err: unknown): boolean {
  const maybe = err as { code?: string; databaseError?: { code?: string } } | null;
  return maybe?.code === '23505' || maybe?.databaseError?.code === '23505';
}

// 懒加载配置文件（避免 import resolve 问题）。
// 不依赖 process.cwd()（dev/e2e 两种 cwd 不同），以本文件位置向上定位仓库根 config/。
function loadDefaultFlowConfig(): { version: number; steps: Array<{ step_order: number; name: string; desc: string; platform: string; platform_config: Record<string, unknown>; model_config: Record<string, unknown> }> } {
  const candidates = [
    join(__dirname, '..', '..', '..', '..', 'config', 'default_flow_agents.json'), // src/agent → 仓库根
    join(process.cwd(), '..', '..', '..', 'config', 'default_flow_agents.json'),
    join(process.cwd(), 'config', 'default_flow_agents.json')
  ];
  for (const configPath of candidates) {
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // 尝试下一个候选路径
    }
  }
  throw new Error(`default_flow_agents.json not found, tried: ${candidates.join(', ')}`);
}

@Injectable()
export class AgentProvisionService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @InjectRepository(AgentEntity) private readonly agentRepo: Repository<AgentEntity>,
    @InjectRepository(RoleAgentBindingEntity) private readonly bindingRepo: Repository<RoleAgentBindingEntity>,
    @Inject(AgentVersionService) private readonly versionService: AgentVersionService
  ) {}

  /**
   * 幂等开通作品的默认 Agent：
   * - 11 个 flow_step_agent（基于 default_flow_agents.json）
   * - ai_tools 表每个启用的 tool 创建一个 tool_agent
   * 已存在的跳过（step_order 或 tool_name 唯一约束兜底）。
   */
  async provisionProjectDefaults(authorId: string, projectId: string): Promise<{ flowAgents: number; toolAgents: number }> {
    return this.dataSource.transaction(async (manager) => {
      const agentRepo = manager.getRepository(AgentEntity);
      const toolRepo = manager.getRepository(AiToolEntity);

      // ─── flow_step_agent ───
      const config = loadDefaultFlowConfig();
      let flowCount = 0;

      for (const stepCfg of config.steps) {
        const exists = await agentRepo.findOneBy({
          author_id: authorId,
          project_id: projectId,
          kind: 'flow_step_agent',
          step_order: stepCfg.step_order
        });
        if (exists) continue;

        const agent = agentRepo.create();
        agent.id = randomUUID();
        agent.author_id = authorId;
        agent.project_id = projectId;
        agent.kind = 'flow_step_agent';
        agent.name = stepCfg.name;
        agent.description = stepCfg.desc;
        agent.platform = stepCfg.platform;
        agent.platform_config = stepCfg.platform_config;
        agent.model_id = 'default';
        agent.model_config = stepCfg.model_config;
        agent.step_order = stepCfg.step_order;
        agent.scope = 'project';
        agent.source = 'auto';
        agent.status = 'active';
        // is_default 为「作者级唯一默认」语义（uq_ai_agents_author_default ON (author_id) WHERE is_default），
        // 作品级 flow_step_agent 每作品 11 个，不能作为作者默认，须置 false。
        agent.is_default = false;
        agent.version_no = 1;
        agent.versions = [];
        await agentRepo.save(agent).catch((err) => {
          // 并发撞唯一约束 → 跳过
          if (isUniqueViolation(err)) return;
          throw err;
        });
        flowCount++;
      }

      // ─── tool_agent：查 ai_tools 表每个启用工具创建默认 tool_agent ───
      const tools = await toolRepo.find({ where: { enabled: true } });
      let toolCount = 0;

      for (const tool of tools) {
        const exists = await agentRepo.findOneBy({
          author_id: authorId,
          project_id: projectId,
          kind: 'tool_agent',
          tool_name: tool.tool_id
        });
        if (exists) continue;

        const agent = agentRepo.create();
        agent.id = randomUUID();
        agent.author_id = authorId;
        agent.project_id = projectId;
        agent.kind = 'tool_agent';
        agent.name = `${tool.name} 执行器`;
        agent.platform = 'mock';
        agent.model_id = 'default';
        agent.model_config = {};
        agent.tool_name = tool.tool_id;
        agent.scope = 'project';
        agent.source = 'auto';
        agent.status = 'active';
        // 同 flow_step_agent：is_default 为作者级唯一语义，作品级默认工具 Agent 不占用它
        agent.is_default = false;
        agent.version_no = 1;
        agent.versions = [];
        await agentRepo.save(agent).catch((err) => {
          if (isUniqueViolation(err)) return;
          throw err;
        });
        toolCount++;
      }

      logger.log(`Provisioned ${flowCount} flow_step_agents + ${toolCount} tool_agents for project ${projectId}`);
      return { flowAgents: flowCount, toolAgents: toolCount };
    });
  }

  /**
   * 查作品下全部角色（从 role_agent_bindings 表 DISTINCT role_id），
   * 为每个角色绑定 11 步默认 flow_step_agent（role_agent）。
   * 幂等：已存在的绑定跳过。
   */
  async bindRoles(authorId: string, projectId: string): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const agentRepo = manager.getRepository(AgentEntity);
      const bindingRepo = manager.getRepository(RoleAgentBindingEntity);

      // 查作品下所有已出现过的角色（去重）
      const roles = await bindingRepo
        .createQueryBuilder('b')
        .select('DISTINCT b.role_id', 'role_id')
        .where('b.project_id = :projectId', { projectId })
        .getRawMany<{ role_id: string }>();

      const roleIds = roles.map((r) => r.role_id);
      if (roleIds.length === 0) return 0;

      // 查作品的 11 个默认 flow_step_agent
      const flowAgents = await agentRepo.find({
        where: {
          author_id: authorId,
          project_id: projectId,
          kind: 'flow_step_agent',
          status: 'active'
        }
      });

      let boundCount = 0;
      for (const roleId of roleIds) {
        for (const flowAgent of flowAgents) {
          // 检查 role_agent 是否已存在
          const existing = await agentRepo.findOneBy({
            author_id: authorId,
            project_id: projectId,
            kind: 'role_agent',
            role_id: roleId,
            step_order: flowAgent.step_order as number
          });
          if (existing) continue;

          // 创建 role_agent（克隆 flow_step_agent 配置）
          const roleAgent = agentRepo.create();
          roleAgent.id = randomUUID();
          roleAgent.author_id = authorId;
          roleAgent.project_id = projectId;
          roleAgent.kind = 'role_agent';
          roleAgent.name = flowAgent.name;
          roleAgent.description = flowAgent.description;
          roleAgent.platform = flowAgent.platform;
          roleAgent.platform_config = flowAgent.platform_config;
          roleAgent.model_id = flowAgent.model_id;
          roleAgent.model_config = flowAgent.model_config;
          roleAgent.role_id = roleId;
          roleAgent.step_order = (flowAgent.step_order ?? null);
          roleAgent.scope = 'role';
          roleAgent.source = 'auto';
          roleAgent.status = 'active';
          roleAgent.is_default = false;
          roleAgent.version_no = 1;
          roleAgent.versions = [];
          await agentRepo.save(roleAgent).catch((err: { code?: string }) => {
            if (err?.code === '23505') return;
            throw err;
          });
          boundCount++;
        }
      }

      logger.log(`Bound ${boundCount} role_agents for ${roleIds.length} roles in project ${projectId}`);
      return boundCount;
    });
  }

  /**
   * 重置角色的默认 11 步 role_agent 流程。
   * - fill（默认）：只补缺——不存在的 step_order 才创建
   * - replace：先删除该角色所有 role_agent（status='active'），再重建
   */
  async resetRoleDefaultFlow(
    authorId: string,
    roleId: string,
    mode: 'fill' | 'replace' = 'fill'
  ): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const agentRepo = manager.getRepository(AgentEntity);

      // 查出该角色所属的 project_id（从任意一个 role_agent 记录，或关联表）
      const existingForRole = await agentRepo.findOneBy({
        author_id: authorId,
        kind: 'role_agent',
        role_id: roleId
      });
      const projectId = existingForRole?.project_id;
      if (!projectId) {
        // 无任何 role_agent 记录，无法确定 project_id
        logger.warn(`No existing role_agent found for role ${roleId}, cannot reset`);
        return 0;
      }

      if (mode === 'replace') {
        // 先删除所有 role_agent
        await agentRepo
          .createQueryBuilder()
          .delete()
          .where('author_id = :authorId', { authorId })
          .andWhere('kind = :kind', { kind: 'role_agent' })
          .andWhere('role_id = :roleId', { roleId })
          .andWhere('status != :status', { status: 'archived' })
          .execute();
      }

      // 查作品的 11 个默认 flow_step_agent
      const flowAgents = await agentRepo.find({
        where: {
          author_id: authorId,
          project_id: projectId,
          kind: 'flow_step_agent',
          status: 'active'
        }
      });

      let created = 0;
      for (const flowAgent of flowAgents) {
        const existing = await agentRepo.findOneBy({
          author_id: authorId,
          project_id: projectId,
          kind: 'role_agent',
          role_id: roleId,
          step_order: flowAgent.step_order as number
        });
        if (existing && mode === 'fill') continue;

        const roleAgent = agentRepo.create();
        roleAgent.id = randomUUID();
        roleAgent.author_id = authorId;
        roleAgent.project_id = projectId;
        roleAgent.kind = 'role_agent';
        roleAgent.name = flowAgent.name;
        roleAgent.description = flowAgent.description;
        roleAgent.platform = flowAgent.platform;
        roleAgent.platform_config = flowAgent.platform_config;
        roleAgent.model_id = flowAgent.model_id;
        roleAgent.model_config = flowAgent.model_config;
        roleAgent.role_id = roleId;
        roleAgent.step_order = (flowAgent.step_order ?? null);
        roleAgent.scope = 'role';
        roleAgent.source = 'auto';
        roleAgent.status = 'active';
        roleAgent.is_default = false;
        roleAgent.version_no = 1;
        roleAgent.versions = [];
        await agentRepo.save(roleAgent);
        created++;
      }

      logger.log(`Reset ${created} role_agents (mode=${mode}) for role ${roleId}`);
      return created;
    });
  }

  /**
   * 切换 tool_name 的默认 tool_agent（事务原子操作）。
   * - 旧默认 → is_default = false
   * - 新默认 → is_default = true
   */
  async switchToolDefault(authorId: string, projectId: string, toolName: string, agentId: string): Promise<{ ok: boolean }> {
    return this.dataSource.transaction(async (manager) => {
      const agentRepo = manager.getRepository(AgentEntity);

      const newDefault = await agentRepo.findOneBy({
        id: agentId,
        author_id: authorId,
        project_id: projectId,
        kind: 'tool_agent',
        tool_name: toolName
      });
      if (!newDefault) {
        throw new Error(`Target agent ${agentId} not found or not a valid tool_agent for ${toolName}`);
      }

      // 清掉同 tool_name 下其他 tool_agent 的 is_default
      await agentRepo
        .createQueryBuilder()
        .update()
        .set({ is_default: false })
        .where('author_id = :authorId', { authorId })
        .andWhere('project_id = :projectId', { projectId })
        .andWhere('kind = :kind', { kind: 'tool_agent' })
        .andWhere('tool_name = :toolName', { toolName })
        .andWhere('id != :newDefaultId', { newDefaultId: agentId })
        .execute();

      // 把新目标设为默认
      newDefault.is_default = true;
      newDefault.updated_at = new Date();
      await agentRepo.save(newDefault);

      return { ok: true };
    });
  }

  /**
   * 列出作品全部 tool_agent，按 tool_name 分组，包含默认 Agent 信息。
   */
  async listToolAgents(projectId: string): Promise<ToolAgentSummary[]> {
    const realAgents = await this.agentRepo
      .createQueryBuilder('agent')
      .where('agent.project_id = :projectId', { projectId })
      .andWhere('agent.kind = :kind', { kind: 'tool_agent' })
      .orderBy('agent.tool_name', 'ASC')
      .getMany();

    // 按 tool_name 分组
    const groups = new Map<string, AgentEntity[]>();
    for (const agent of realAgents) {
      if (!agent.tool_name) continue;
      const bucket = groups.get(agent.tool_name) ?? [];
      bucket.push(agent);
      groups.set(agent.tool_name, bucket);
    }

    const summaries: ToolAgentSummary[] = [];
    for (const [toolName, agents] of groups) {
      const defaultAgent = agents.find((a) => a.is_default === true);
      const agentSummaries: AgentSummary[] = agents
        .filter((a) => a.status !== 'archived')
        .map((a) => ({
          id: a.id,
          name: a.name,
          platform: a.platform as AgentSummary['platform'],
          model_id: a.model_id,
          status: a.status as AgentSummary['status']
        }));

      summaries.push({
        tool_name: toolName,
        agents: agentSummaries,
        default_agent_id: defaultAgent?.id ?? null
      });
    }

    return summaries;
  }
}
