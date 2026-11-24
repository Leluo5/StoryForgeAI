import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type {
  CreateWorkflowInput,
  UpdateWorkflowInput,
  Workflow,
  WorkflowListItem,
  WorkflowVersionSummary,
  WorkflowChangeType
} from '@storyforge/contracts';
import { MAX_WORKFLOW_VERSIONS } from '@storyforge/contracts';
import { WorkflowEntity } from '../database/workflow.entity';

/** 需要保留在版本快照中的字段（剔除 versions/updated_at 等冗余字段） */
const SNAPSHOT_FIELDS = [
  'id', 'author_id', 'name', 'description', 'status', 'platform',
  'platform_config', 'llm_config', 'source', 'archived_at', 'created_at'
] as const;

// ───────────────────────────── 实体 ↔ 契约映射 ─────────────────────────────

function toWorkflow(entity: WorkflowEntity): Workflow {
  return {
    id: entity.id,
    author_id: entity.author_id,
    name: entity.name,
    description: entity.description ?? '',
    status: entity.status as Workflow['status'],
    platform: entity.platform as Workflow['platform'],
    platform_config: entity.platform_config ?? {},
    // 契约 llm_config 为 { model: string }；写入口保证合法，读路径安全断言
    llm_config: (entity.llm_config ?? { model: '' }) as Workflow['llm_config'],
    source: entity.source as Workflow['source'],
    version_no: entity.version_no,
    versions: entity.versions ?? [],
    created_at: entity.created_at.toISOString(),
    updated_at: entity.updated_at.toISOString(),
    archived_at: entity.archived_at ? entity.archived_at.toISOString() : null
  };
}

function toWorkflowListItem(entity: WorkflowEntity): WorkflowListItem {
  const { versions, ...rest } = toWorkflow(entity);
  void versions;
  return rest;
}

@Injectable()
export class WorkflowService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  // ═══════════════════════════════════════════════════════════════════
  // 版本快照（内联，保持契约精简）
  // ═══════════════════════════════════════════════════════════════════

  private snapshot(entity: WorkflowEntity, changeType: WorkflowChangeType, note = ''): void {
    const snapshot: Record<string, unknown> = {};
    for (const field of SNAPSHOT_FIELDS) {
      const val = entity[field as keyof WorkflowEntity];
      // created_at 在首次快照时可能尚未被 TypeORM 填充，兜底为当前时间，避免回滚后置空
      if (field === 'created_at' && (val == null || Number.isNaN((val as Date).getTime?.()))) {
        snapshot[field] = new Date().toISOString();
      } else if (val instanceof Date) {
        snapshot[field] = val.toISOString();
      } else {
        snapshot[field] = val ?? null;
      }
    }
    const entry = {
      version_no: entity.version_no ?? 1,
      change_type: changeType,
      note,
      created_at: new Date().toISOString(),
      snapshot
    };
    entity.versions = [...(entity.versions ?? []), entry].slice(-MAX_WORKFLOW_VERSIONS);
    entity.version_no = (entity.version_no ?? 1) + 1;
  }

  private rollbackSnapshot(entity: WorkflowEntity, targetVersion: number): void {
    const versions = entity.versions ?? [];
    const target = versions.find((v) => v.version_no === targetVersion);
    if (!target) {
      throw new ConflictException(`版本 v${targetVersion} 不存在`);
    }
    for (const [key, val] of Object.entries(target.snapshot)) {
      if (key === 'created_at' || key === 'archived_at') {
        (entity as unknown as Record<string, unknown>)[key] = val != null ? new Date(val as string) : null;
      } else {
        (entity as unknown as Record<string, unknown>)[key] = val;
      }
    }
    this.snapshot(entity, 'rollback', `回滚至 v${targetVersion}`);
  }

  private summarize(entity: WorkflowEntity): WorkflowVersionSummary[] {
    const versions = entity.versions ?? [];
    return [...versions]
      .sort((a, b) => b.version_no - a.version_no)
      .map((v) => ({
        version_no: v.version_no,
        change_type: v.change_type,
        note: v.note,
        created_at: v.created_at
      }));
  }

  // ═══════════════════════════════════════════════════════════════════
  // 列表 / 详情
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 列出作者的全部工作流：keyword（name ILIKE）+ status 过滤 + 分页。
   * 列表项剥离 versions 大字段，保持轻量。
   */
  async listWorkflows(
    authorId: string,
    query: { keyword?: string; status?: string; page?: number; page_size?: number }
  ): Promise<{ workflows: WorkflowListItem[]; total: number; page: number; page_size: number }> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;

    const qb = this.dataSource
      .getRepository(WorkflowEntity)
      .createQueryBuilder('wf')
      .where('wf.author_id = :authorId', { authorId });

    if (query.status) {
      qb.andWhere('wf.status = :status', { status: query.status });
    }
    if (query.keyword) {
      qb.andWhere('wf.name ILIKE :keyword', { keyword: `%${query.keyword}%` });
    }

    const [entities, total] = await qb
      .orderBy('wf.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    return { workflows: entities.map(toWorkflowListItem), total, page, page_size: pageSize };
  }

  /**
   * 获取单个工作流详情。includeVersions=false 时从返回中剥 versions 字段。
   */
  async getWorkflow(authorId: string, workflowId: string, includeVersions = true): Promise<Workflow> {
    const entity = await this.dataSource.getRepository(WorkflowEntity).findOneBy({
      id: workflowId,
      author_id: authorId
    });
    if (!entity) throw new NotFoundException('工作流不存在');

    if (!includeVersions) {
      const { versions, ...rest } = toWorkflow(entity);
      void versions;
      return rest as Workflow;
    }
    return toWorkflow(entity);
  }

  /**
   * 获取工作流版本历史摘要（不含 snapshot 内容）。
   */
  async listVersions(authorId: string, workflowId: string): Promise<WorkflowVersionSummary[]> {
    const entity = await this.dataSource.getRepository(WorkflowEntity).findOneBy({
      id: workflowId,
      author_id: authorId
    });
    if (!entity) throw new NotFoundException('工作流不存在');
    return this.summarize(entity);
  }

  // ═══════════════════════════════════════════════════════════════════
  // 创建 / 更新 / 删除
  // ═══════════════════════════════════════════════════════════════════

  /**
   * 创建工作流：初始版本快照 version_no=1（写入后 version_no 变为 2，快照 version_no=1 为初始态）。
   */
  async createWorkflow(authorId: string, input: CreateWorkflowInput): Promise<Workflow> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(WorkflowEntity);
      // 同作者名称唯一：预检查，避免撞唯一约束抛裸 QueryFailedError
      const dup = await repo.findOneBy({ author_id: authorId, name: input.name });
      if (dup) throw new ConflictException({ message: '同名工作流已存在' });

      const entity = repo.create();
      entity.id = randomUUID();
      entity.author_id = authorId;
      entity.name = input.name;
      entity.description = input.description ?? '';
      entity.platform = input.platform ?? 'coze';
      entity.platform_config = input.platform_config ?? {};
      entity.llm_config = input.llm_config ?? {};
      entity.source = input.source ?? 'manual';
      entity.status = 'active';
      entity.version_no = 1;
      entity.versions = [];
      entity.archived_at = null;

      this.snapshot(entity, 'create', '创建工作流');
      await manager.save(entity);
      return toWorkflow(entity);
    });
  }

  /**
   * 更新工作流：白名单字段 + 版本快照 + version_no 自增。
   * 普通更新不允许直接设置 status=archived（须走 archive 接口）。
   */
  async updateWorkflow(authorId: string, workflowId: string, input: UpdateWorkflowInput): Promise<Workflow> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(WorkflowEntity);
      const entity = await repo.findOneBy({ id: workflowId, author_id: authorId });
      if (!entity) throw new NotFoundException('工作流不存在');

      if (input.name !== undefined) {
        if (input.name !== entity.name) {
          const dup = await repo.findOneBy({ author_id: authorId, name: input.name });
          if (dup && dup.id !== workflowId) {
            throw new ConflictException({ message: '同名工作流已存在' });
          }
        }
        entity.name = input.name;
      }
      if (input.description !== undefined) entity.description = input.description;
      if (input.platform_config !== undefined) entity.platform_config = input.platform_config ?? {};
      if (input.llm_config !== undefined) entity.llm_config = input.llm_config ?? {};
      if (input.status !== undefined) {
        if (input.status === 'archived') {
          throw new ConflictException('不能通过普通更新设置 archived 状态，请使用归档接口');
        }
        entity.status = input.status;
        if (input.status === 'active') entity.archived_at = null;
      }

      this.snapshot(entity, 'update', `更新字段: ${Object.keys(input).join(',')}`);
      await manager.save(entity);
      return toWorkflow(entity);
    });
  }

  /**
   * 归档工作流：status=archived + archived_at=now + 版本快照。
   * 仅对非已归档工作流生效。
   */
  async archiveWorkflow(authorId: string, workflowId: string, note = ''): Promise<Workflow> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(WorkflowEntity);
      const entity = await repo.findOneBy({ id: workflowId, author_id: authorId });
      if (!entity) throw new NotFoundException('工作流不存在');
      if (entity.status === 'archived') {
        throw new ConflictException('工作流已归档');
      }

      entity.status = 'archived';
      entity.archived_at = new Date();
      this.snapshot(entity, 'archive', note || '归档工作流');
      await manager.save(entity);
      return toWorkflow(entity);
    });
  }

  /**
   * 恢复工作流：status=active + archived_at=null + 版本快照。
   * 仅对已归档工作流生效。
   */
  async restoreWorkflow(authorId: string, workflowId: string): Promise<Workflow> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(WorkflowEntity);
      const entity = await repo.findOneBy({ id: workflowId, author_id: authorId });
      if (!entity) throw new NotFoundException('工作流不存在');
      if (entity.status !== 'archived') {
        throw new ConflictException('工作流未归档');
      }

      entity.status = 'active';
      entity.archived_at = null;
      this.snapshot(entity, 'restore', '恢复工作流');
      await manager.save(entity);
      return toWorkflow(entity);
    });
  }

  /**
   * 删除工作流：已归档可硬删；未归档需 force=true（防止误删）。
   */
  async deleteWorkflow(authorId: string, workflowId: string, force = false): Promise<{ deleted: true; id: string }> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(WorkflowEntity);
      const entity = await repo.findOneBy({ id: workflowId, author_id: authorId });
      if (!entity) throw new NotFoundException('工作流不存在');

      if (entity.status !== 'archived' && !force) {
        throw new ConflictException({
          message: '工作流未归档，请先归档后再删除',
          current_status: entity.status
        });
      }

      await repo.remove(entity);
      return { deleted: true, id: workflowId };
    });
  }

  /**
   * 回滚工作流到指定版本：合并快照 + 生成 rollback 快照 + version_no 自增。
   */
  async rollbackWorkflow(authorId: string, workflowId: string, versionNo: number): Promise<Workflow> {
    return this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(WorkflowEntity);
      const entity = await repo.findOneBy({ id: workflowId, author_id: authorId });
      if (!entity) throw new NotFoundException('工作流不存在');

      this.rollbackSnapshot(entity, versionNo);
      await manager.save(entity);
      return toWorkflow(entity);
    });
  }
}
