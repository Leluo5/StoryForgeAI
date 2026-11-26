import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { InjectRepository } from '@nestjs/typeorm';
import { AgentVersionEntity } from './agent-version.entity';
import { AgentEntity } from '../database/agent.entity';
import type { AgentChangeType, AgentVersionSummary } from '@storyforge/contracts';

/** agent 内保留最近 N 个版本行，超出的删除（最旧） */
export const MAX_VERSIONS = 50;

/** 需要保留在快照中的字段（剔除 versions/updated_at 等冗余字段） */
const SNAPSHOT_FIELDS = [
  'id', 'author_id', 'name', 'platform', 'model_id', 'model_config',
  'status', 'is_default', 'created_at',
  'project_id', 'kind', 'description', 'role_id', 'tool_name',
  'step_order', 'scope', 'platform_config', 'source', 'tags',
  'manual_group_key', 'credential_source', 'archived_at'
] as const;

/**
 * Agent 版本历史服务（M4-T5：独立 agent_version 表）。
 * 每版本一行，snapshot 不可变。agent.version_no 指向最新行。
 * 版本上限 MAX_VERSIONS（appendVersion 后清理最旧）。
 */
@Injectable()
export class AgentVersionService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @InjectRepository(AgentVersionEntity)
    private readonly repo: Repository<AgentVersionEntity>
  ) {}

  /** 构造 agent 快照字段（纯函数，不落库）。剔除了版本/时间冗余字段。 */
  buildSnapshot(agent: AgentEntity): Record<string, unknown> {
    const snapshot: Record<string, unknown> = {};
    for (const field of SNAPSHOT_FIELDS) {
      const val = agent[field as keyof AgentEntity];
      if (val instanceof Date) snapshot[field] = val.toISOString();
      else snapshot[field] = val ?? null;
    }
    return snapshot;
  }

  /**
   * 追加一个版本行（agent 已先更新 version_no 并 save）。
   * 与清理超限同事务（评审修正 R4：清理与写入同事务）。
   * 失败回滚，保证版本历史与 agent.version_no 一致。
   * @param manager 可选：调用方已在外层事务中时传入该事务的 EntityManager，
   *   复用同一事务（避免独立新事务读不到外层未提交的 ai_agents 行 → FK violation）。
   */
  async appendVersion(
    agentId: string,
    versionNo: number,
    changeType: AgentChangeType,
    note: string,
    snapshot: Record<string, unknown>,
    manager?: EntityManager
  ): Promise<void> {
    const run = async (em: EntityManager): Promise<void> => {
      const repo = em.getRepository(AgentVersionEntity);
      const row = repo.create({
        agent_id: agentId,
        version_no: versionNo,
        action: changeType,
        note,
        snapshot
      });
      await repo.save(row);
      // 保留最近 MAX_VERSIONS：删除 version_no <= (当前最大 - MAX_VERSIONS)
      await em
        .createQueryBuilder()
        .delete()
        .from(AgentVersionEntity)
        .where('agent_id = :agentId AND version_no <= :cutoff', {
          agentId,
          cutoff: versionNo - MAX_VERSIONS
        })
        .execute();
    };
    if (manager) await run(manager);
    else await this.dataSource.transaction(run);
  }

  /** 版本摘要列表（不含 snapshot），降序（最新在前）。 */
  async listVersions(agentId: string): Promise<AgentVersionSummary[]> {
    const rows = await this.repo.find({
      where: { agent_id: agentId },
      order: { version_no: 'DESC' }
    });
    return rows.map((r) => ({
      version_no: r.version_no,
      change_type: r.action as AgentChangeType,
      note: r.note,
      created_at: r.created_at.toISOString()
    }));
  }

  /** 读取指定版本快照（回滚用），不存在返回 null。@param manager 可选：复用外层事务。 */
  async getSnapshot(
    agentId: string,
    versionNo: number,
    manager?: EntityManager
  ): Promise<Record<string, unknown> | null> {
    const repo = manager ? manager.getRepository(AgentVersionEntity) : this.repo;
    const row = await repo.findOne({ where: { agent_id: agentId, version_no: versionNo } });
    return row ? row.snapshot : null;
  }
}
