import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { InjectRepository } from '@nestjs/typeorm';
import { AgentGroupOverrideEntity, GroupOverride, ManualGroup } from '../database/agent-group-override.entity';
import { AgentEntity } from '../database/agent.entity';
import type { GroupTreeNode } from '@storyforge/contracts';

const DEFAULT_OVERRIDES: GroupOverride[] = [];
const DEFAULT_MANUAL_GROUPS: ManualGroup[] = [];

/** 自动分组 key 前缀常量 */
export const GROUP_KEY_FLOW_PREFIX = 'flow:';
export const GROUP_KEY_TOOL_PREFIX = 'tool:';
export const GROUP_KEY_ROLE_PREFIX = 'role:';
export const GROUP_KEY_ROOT = 'project:';

@Injectable()
export class AgentGroupService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @InjectRepository(AgentGroupOverrideEntity)
    private readonly overrideRepo: Repository<AgentGroupOverrideEntity>
  ) {}

  /**
   * 加载作品的分组覆盖配置。不存在则返回默认空结构。
   */
  async loadOverrides(projectId: string): Promise<AgentGroupOverrideEntity> {
    const existing = await this.overrideRepo.findOneBy({ project_id: projectId });
    if (existing) return existing;

    // 返回内存中的默认对象，不入库（按需创建）
    const defaults = new AgentGroupOverrideEntity();
    defaults.project_id = projectId;
    defaults.overrides = [...DEFAULT_OVERRIDES];
    defaults.manual_groups = [...DEFAULT_MANUAL_GROUPS];
    defaults.created_at = new Date();
    defaults.updated_at = new Date();
    return defaults;
  }

  /**
   * 合并式更新单个 override 项。找不到 key 则追加新项。
   */
  async upsertOverride(
    projectId: string,
    key: string,
    fields: { name?: string; sort_order?: number; hidden?: boolean }
  ): Promise<GroupOverride> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AgentGroupOverrideEntity);
      let entity = await repo.findOneBy({ project_id: projectId });
      if (!entity) {
        entity = repo.create();
        entity.project_id = projectId;
        entity.overrides = [];
        entity.manual_groups = [];
      }

      let existing = entity.overrides.find((o) => o.key === key);
      if (!existing) {
        existing = { key, sort_order: 0, hidden: false };
        entity.overrides.push(existing);
      }

      if (fields.name !== undefined) existing.name = fields.name;
      if (fields.sort_order !== undefined) existing.sort_order = fields.sort_order;
      if (fields.hidden !== undefined) existing.hidden = fields.hidden;

      entity.updated_at = new Date();
      await repo.save(entity);
      return existing;
    });
  }

  /**
   * 删除匹配 key 的 override 项。返回是否删除成功。
   */
  async deleteOverride(projectId: string, key: string): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AgentGroupOverrideEntity);
      const entity = await repo.findOneBy({ project_id: projectId });
      if (!entity) return false;

      const before = entity.overrides.length;
      entity.overrides = entity.overrides.filter((o) => o.key !== key);

      if (entity.overrides.length === before) return false;

      entity.updated_at = new Date();
      await repo.save(entity);
      return true;
    });
  }

  /**
   * 创建手工分组。id 格式为 "manual:<uuid>"。
   */
  async createManualGroup(
    projectId: string,
    parentKey: string,
    name: string,
    sortOrder = 0
  ): Promise<ManualGroup> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(AgentGroupOverrideEntity);
      let entity = await repo.findOneBy({ project_id: projectId });
      if (!entity) {
        entity = repo.create();
        entity.project_id = projectId;
        entity.overrides = [];
        entity.manual_groups = [];
      }

      const newGroup: ManualGroup = {
        id: `manual:${randomUUID()}`,
        parent_key: parentKey,
        name,
        sort_order: sortOrder
      };
      entity.manual_groups.push(newGroup);
      entity.updated_at = new Date();
      await repo.save(entity);
      return newGroup;
    });
  }

  /**
   * 删除手工分组。同时把属于该组的 Agent 的 manual_group_key 置 null（回落到自动分组）。
   */
  async deleteManualGroup(projectId: string, groupId: string): Promise<boolean> {
    return this.dataSource.transaction(async (manager) => {
      const overrideRepo = manager.getRepository(AgentGroupOverrideEntity);
      const entity = await overrideRepo.findOneBy({ project_id: projectId });
      if (!entity) return false;

      const before = entity.manual_groups.length;
      entity.manual_groups = entity.manual_groups.filter((g) => g.id !== groupId);

      if (entity.manual_groups.length === before) return false;

      entity.updated_at = new Date();
      await overrideRepo.save(entity);

      // 把该组的 Agent 的 manual_group_key 置 null
      await manager.getRepository(AgentEntity)
        .createQueryBuilder()
        .update()
        .set({ manual_group_key: null })
        .where('manual_group_key = :groupId', { groupId })
        .execute();

      return true;
    });
  }

  /**
   * 构建 Agent 分组树（自动分组 + overrides 覆盖 + manual_groups 插入）。
   * 纯函数：输入 agents 数组 + override 配置，输出树形节点。
   */
  buildTree(
    projectId: string,
    agents: AgentEntity[],
    overridesEntity?: AgentGroupOverrideEntity
  ): GroupTreeNode[] {
    const overrides = overridesEntity?.overrides ?? [];
    const manualGroups = overridesEntity?.manual_groups ?? [];
    const overrideMap = new Map(overrides.map((o) => [o.key, o]));

    // Step 1: 按自动分组规则把 agent 归类到 key
    const autoBuckets = new Map<string, AgentEntity[]>();
    const manualBuckets = new Map<string, AgentEntity[]>();

    for (const agent of agents) {
      // 有手工分组 → 进手工分组桶
      if (agent.manual_group_key) {
        const bucket = manualBuckets.get(agent.manual_group_key) ?? [];
        bucket.push(agent);
        manualBuckets.set(agent.manual_group_key, bucket);
        continue;
      }

      // 自动分组
      const key = this.computeAutoGroupKey(agent);
      if (!key) continue; // legacy 或无归属字段的跳过
      const bucket = autoBuckets.get(key) ?? [];
      bucket.push(agent);
      autoBuckets.set(key, bucket);
    }

    // Step 2: 构建节点（自动分组 + overrides）
    const autoNodes: GroupTreeNode[] = [];
    for (const [key, bucketAgents] of autoBuckets) {
      const override = overrideMap.get(key);
      const node: GroupTreeNode = {
        key,
        name: override?.name ?? this.defaultNameForKey(key),
        sort_order: override?.sort_order ?? this.defaultSortForKey(key),
        hidden: override?.hidden ?? false,
        is_manual: false,
        children: [],
        agent_ids: bucketAgents.map((a) => a.id)
      };
      autoNodes.push(node);
    }

    // Step 3: 构建手工分组节点并按 parent_key 挂到对应位置
    const manualNodeMap = new Map<string, GroupTreeNode>();
    for (const mg of manualGroups) {
      const children = manualBuckets.get(mg.id) ?? [];
      const node: GroupTreeNode = {
        key: mg.id,
        name: mg.name,
        sort_order: mg.sort_order ?? 0,
        hidden: false,
        is_manual: true,
        children: [],
        agent_ids: children.map((a) => a.id)
      };
      manualNodeMap.set(mg.id, node);
    }

    // Step 4: 合并到根节点列表
    const rootNodes: GroupTreeNode[] = [...autoNodes];

    // 手工分组按 parent_key 挂载
    for (const mg of manualGroups) {
      const node = manualNodeMap.get(mg.id)!;
      if (mg.parent_key === GROUP_KEY_ROOT || !mg.parent_key) {
        rootNodes.push(node);
      } else {
        // 尝试挂到对应的自动分组节点下
        const parent = rootNodes.find((n) => n.key === mg.parent_key);
        if (parent) {
          parent.children.push(node);
        } else {
          // 父分组不存在 → 放到根层
          rootNodes.push(node);
        }
      }
    }

    // Step 5: 排序（递归）
    return rootNodes.sort((a, b) => a.sort_order - b.sort_order);
  }

  // ───────────────────────────── 内部辅助 ─────────────────────────────

  /** 根据 agent.kind 计算自动分组 key */
  private computeAutoGroupKey(agent: AgentEntity): string | null {
    switch (agent.kind) {
      case 'flow_step_agent':
        return agent.step_order != null ? `${GROUP_KEY_FLOW_PREFIX}${agent.step_order}` : null;
      case 'tool_agent':
        return agent.tool_name ? `${GROUP_KEY_TOOL_PREFIX}${agent.tool_name}` : null;
      case 'role_agent':
        return agent.role_id ? `${GROUP_KEY_ROLE_PREFIX}${agent.role_id}` : null;
      default:
        return null; // legacy 不参与自动分组
    }
  }

  /** 自动分组节点的默认展示名 */
  private defaultNameForKey(key: string): string {
    if (key.startsWith(GROUP_KEY_FLOW_PREFIX)) {
      const step = key.slice(GROUP_KEY_FLOW_PREFIX.length);
      return `步骤 ${step}`;
    }
    if (key.startsWith(GROUP_KEY_TOOL_PREFIX)) {
      return key.slice(GROUP_KEY_TOOL_PREFIX.length);
    }
    if (key.startsWith(GROUP_KEY_ROLE_PREFIX)) {
      return `角色 ${key.slice(GROUP_KEY_ROLE_PREFIX.length).slice(0, 8)}...`;
    }
    return key;
  }

  /** 自动分组节点的默认 sort_order */
  private defaultSortForKey(key: string): number {
    if (key.startsWith(GROUP_KEY_FLOW_PREFIX)) {
      return Number(key.slice(GROUP_KEY_FLOW_PREFIX.length)) * 10;
    }
    if (key.startsWith(GROUP_KEY_TOOL_PREFIX)) return 200;
    if (key.startsWith(GROUP_KEY_ROLE_PREFIX)) return 300;
    return 500;
  }
}
