import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { AgentVersionSnapshot } from '../database/agent.entity';
import { AgentEntity } from '../database/agent.entity';
import type { AgentChangeType, AgentVersionSummary } from '@storyforge/contracts';

/** 保留最近 N 个版本快照，超出的从头部丢弃 */
export const MAX_VERSIONS = 50;

/** 需要保留在快照中的字段（剔除 versions/updated_at 等冗余字段） */
const SNAPSHOT_FIELDS = [
  'id', 'author_id', 'name', 'platform', 'model_id', 'model_config',
  'status', 'is_default', 'created_at',
  'project_id', 'kind', 'description', 'role_id', 'tool_name',
  'step_order', 'scope', 'platform_config', 'source', 'tags',
  'manual_group_key', 'credential_source', 'archived_at'
] as const;

@Injectable()
export class AgentVersionService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  /**
   * 为 agent 生成一条版本快照，追加到 versions 数组并自增 version_no。
   * MAX_VERSIONS 硬截断头部（最旧）。
   * 注意：本方法不保存数据库，只修改传入的 entity。调用方需自行 save。
   */
  snapshot(agent: AgentEntity, changeType: AgentChangeType, note = ''): AgentEntity {
    // 拷贝字段到 snapshot（剔除 versions 数组本身避免循环引用）
    const snapshot: Record<string, unknown> = {};
    for (const field of SNAPSHOT_FIELDS) {
      const val = agent[field as keyof AgentEntity];
      if (val instanceof Date) snapshot[field] = val.toISOString();
      else snapshot[field] = val ?? null;
    }

    const entry: AgentVersionSnapshot = {
      version_no: agent.version_no ?? 1,
      change_type: changeType,
      note,
      created_at: new Date().toISOString(),
      snapshot
    };

    agent.versions = [...(agent.versions ?? []), entry].slice(-MAX_VERSIONS);
    agent.version_no = (agent.version_no ?? 1) + 1;
    return agent;
  }

  /**
   * 回滚到指定 version_no 的快照。
   * 流程：找到目标快照 → 合并 snapshot 到 agent → 追加一条 change_type='rollback' 的新快照 → version_no++
   * 不保存数据库，调用方需自行 save。
   */
  rollback(agent: AgentEntity, targetVersion: number): AgentEntity {
    const versions = agent.versions ?? [];
    const target = versions.find((v) => v.version_no === targetVersion);
    if (!target) {
      throw new Error(`Version ${targetVersion} not found for agent ${agent.id}`);
    }

    // 用快照字段覆盖当前 agent（反向映射 Date 类型）
    for (const [key, val] of Object.entries(target.snapshot)) {
      if (key === 'created_at' || key === 'archived_at') {
        // 只在非 null 时赋值 Date
        if (val != null) {
          (agent as unknown as Record<string, unknown>)[key] = new Date(val as string);
        } else {
          (agent as unknown as Record<string, unknown>)[key] = null;
        }
      } else {
        (agent as unknown as Record<string, unknown>)[key] = val;
      }
    }

    // 生成 rollback 快照
    const rollbackNote = `回滚至 v${targetVersion}`;
    this.snapshot(agent, 'rollback', rollbackNote);
    return agent;
  }

  /**
   * 从 versions 数组映射出不含 snapshot 内容的摘要列表，供版本历史展示。
   * 降序排列（最新在前）。
   */
  summarize(agent: AgentEntity): AgentVersionSummary[] {
    const versions = agent.versions ?? [];
    return [...versions]
      .sort((a, b) => b.version_no - a.version_no)
      .map((v) => ({
        version_no: v.version_no,
        change_type: v.change_type,
        note: v.note,
        created_at: v.created_at
      }));
  }
}
