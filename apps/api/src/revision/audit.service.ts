import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import type { ListAuditLogsQuery, ListAuditLogsResponse } from '@storyforge/contracts';
import { AuditLogEntity } from '../database/audit-log.entity';

export interface AuditDetail {
  [key: string]: unknown;
}

function toAuditLog(entity: AuditLogEntity): ListAuditLogsResponse['audit_logs'][number] {
  return {
    id: entity.id,
    actor_id: entity.actor_id,
    action: entity.action,
    target_type: entity.target_type,
    target_id: entity.target_id,
    detail: entity.detail,
    created_at: entity.created_at.toISOString()
  };
}

@Injectable()
export class AuditService {
  constructor(@Inject(DataSource) private readonly dataSource: DataSource) {}

  /**
   * 写审计日志，仅追加不更新。
   * 敏感操作：revision_accept / revision_reject / version_rollback /
   * todo_status / comment_resolve / 迁移 / 权限。
   * @param workId 所属作品（写入 detail.work_id，供作品内查询过滤；不新增列避免破坏迁移）
   */
  async record(
    actorId: string | null,
    action: string,
    targetType: string,
    targetId: string | null,
    detail: AuditDetail,
    workId?: string,
    manager?: EntityManager
  ): Promise<AuditLogEntity> {
    const repository = (manager ?? this.dataSource).getRepository(AuditLogEntity);
    const log = repository.create();
    log.id = randomUUID();
    log.actor_id = actorId;
    log.action = action;
    log.target_type = targetType;
    log.target_id = targetId;
    log.detail = workId ? { ...detail, work_id: workId } : detail;
    return repository.save(log);
  }

  /**
   * 作品内审计日志查询（§3.6）：actor/action/target_type/时间范围过滤 + 分页。
   * 只读——写审计由服务层内部调用 record()，不暴露业务写接口。
   * 作品过滤：detail->>'work_id'（jsonb 内嵌字段，兼容既有迁移）。
   */
  async query(workId: string, query: ListAuditLogsQuery): Promise<ListAuditLogsResponse> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const qb = this.dataSource.getRepository(AuditLogEntity).createQueryBuilder('audit')
      .where('audit.detail->>\'work_id\' = :workId', { workId });
    if (query.actor_id) qb.andWhere('audit.actor_id = :actorId', { actorId: query.actor_id });
    if (query.action) qb.andWhere('audit.action = :action', { action: query.action });
    if (query.target_type) qb.andWhere('audit.target_type = :targetType', { targetType: query.target_type });
    if (query.from) qb.andWhere('audit.created_at >= :from', { from: new Date(query.from) });
    if (query.to) qb.andWhere('audit.created_at <= :to', { to: new Date(query.to) });
    const [auditLogs, total] = await qb
      .orderBy('audit.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();
    return { audit_logs: auditLogs.map(toAuditLog), total, page, page_size: pageSize };
  }
}
