import { createHash } from 'node:crypto';
import { Inject, Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { applyOperations, canonicalizeDocument } from '@storyforge/editor-schema';
import type {
  CreateRevisionSetRequest,
  ListRevisionSetsQuery,
  ResolveOperationRequest,
  RevisionSet,
  RevisionOperation,
  RevisionStatus
} from '@storyforge/contracts';
import { RevisionSetEntity } from '../database/revision-set.entity';
import { WorkEntity } from '../database/work.entity';
import { ChapterEntity } from '../database/chapter.entity';
import { VersionSnapshotEntity } from '../database/version-snapshot.entity';
import { AuditService } from './audit.service';

export const OP_STATUS = ['pending', 'accepted', 'rejected'] as const;

interface StoredOperation {
  index: number;
  step: Record<string, unknown>;
  status: (typeof OP_STATUS)[number];
  [key: string]: unknown;
}

/** 内部存储的 operations 元素：包装 step + 单条操作接受/拒绝状态 */
function isStoredOperation(value: unknown): value is StoredOperation {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.index === 'number'
    && typeof record.step === 'object'
    && record.step !== null
    && OP_STATUS.includes(record.status as (typeof OP_STATUS)[number]);
}

/** 从存储格式提取纯 step 数组（供 applyOperations / 回滚使用） */
function toSteps(operations: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return operations.map((item) => (isStoredOperation(item) ? item.step : item));
}

function toStoredOperations(operations: Array<Record<string, unknown>>): StoredOperation[] {
  return operations.map((step, index) => ({ index, step, status: 'pending' as const }));
}

function toOperationView(item: Record<string, unknown>, index: number): RevisionOperation {
  if (isStoredOperation(item)) {
    return { index: item.index, operation: item.step, status: item.status };
  }
  return { index, operation: item, status: 'pending' };
}

function toRevisionSet(entity: RevisionSetEntity): RevisionSet {
  return {
    id: entity.id,
    chapter_id: entity.chapter_id,
    base_version: entity.base_version,
    actor_type: entity.actor_type as RevisionSet['actor_type'],
    actor_id: entity.actor_id,
    operations: entity.operations,
    status: entity.status as RevisionStatus,
    ai_set: entity.ai_set,
    created_at: entity.created_at.toISOString()
  };
}

async function assertOwnedChapter(manager: EntityManager, workId: string, chapterId: string, authorId: string, lock = false): Promise<ChapterEntity> {
  const qb = manager.getRepository(ChapterEntity).createQueryBuilder('chapter')
    .innerJoin(WorkEntity, 'work', 'work.id = chapter.work_id')
    .where('chapter.id = :chapterId', { chapterId })
    .andWhere('chapter.work_id = :workId', { workId })
    .andWhere('work.author_id = :authorId', { authorId });
  if (lock) qb.setLock('pessimistic_write');
  const chapter = await qb.getOne();
  if (!chapter) throw new NotFoundException('Chapter not found');
  return chapter;
}

@Injectable()
export class RevisionService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  /**
   * 创建修订集。
   * - 悲观锁章节行，校验 chapter.version === base_version，否则 409
   * - actor_type='ai' → ai_set=true；AI 结果不混入手工修订集（独立记录）
   * - 插入 revision_sets(status='pending') + 审计 revision_create
   */
  createRevisionSet(
    authorId: string,
    workId: string,
    chapterId: string,
    input: CreateRevisionSetRequest
  ): Promise<{ revision_set: RevisionSet }> {
    return this.dataSource.transaction(async (manager) => {
      const chapter = await assertOwnedChapter(manager, workId, chapterId, authorId, true);
      if (chapter.version !== input.base_version) {
        throw new ConflictException({
          message: 'Chapter version conflict',
          details: {
            server_version: chapter.version,
            server_content_hash: chapter.content_hash
          }
        });
      }

      const aiSet = input.actor_type === 'ai';
      const entity = manager.getRepository(RevisionSetEntity).create();
      entity.id = randomUUID();
      entity.chapter_id = chapterId;
      entity.base_version = input.base_version;
      entity.actor_type = input.actor_type;
      entity.actor_id = null;
      entity.operations = toStoredOperations(input.operations);
      entity.status = 'pending';
      entity.ai_set = aiSet;
      await manager.save(entity);

      await this.auditService.record(authorId, 'revision_create', 'revision_set', entity.id, {
        chapter_id: chapterId,
        actor_type: input.actor_type,
        base_version: input.base_version,
        operation_count: input.operations.length
      }, workId);

      return { revision_set: toRevisionSet(entity) };
    });
  }

  /**
   * 接受/拒绝单条操作（幂等）。
   * - 幂等：该 op 已处理 → 返回当前结果，不重复应用
   * - actor_type='ai' 且首次接受 → 先创建自动 version_snapshot（同一修订集只建一个）
   * - 更新 op 状态；全接受 → status='resolved'，部分 → 'partially_resolved'
   * - 审计 revision_accept / revision_reject
   */
  resolveOperation(
    authorId: string,
    workId: string,
    revisionSetId: string,
    opIndex: number,
    decision: ResolveOperationRequest['decision']
  ): Promise<{ revision_set: RevisionSet; operation: RevisionOperation }> {
    return this.dataSource.transaction(async (manager) => {
      const revisionSet = await manager.getRepository(RevisionSetEntity).createQueryBuilder('rs')
        .innerJoin(ChapterEntity, 'chapter', 'chapter.id = rs.chapter_id')
        .innerJoin(WorkEntity, 'work', 'work.id = chapter.work_id')
        .where('rs.id = :revisionSetId', { revisionSetId })
        .andWhere('chapter.work_id = :workId', { workId })
        .andWhere('work.author_id = :authorId', { authorId })
        .setLock('pessimistic_write')
        .getOne();
      if (!revisionSet) throw new NotFoundException('Revision set not found');

      // 读取已存储格式；旧格式（纯 step）升级为存储格式。切勿用 toStoredOperations 重新包装——
      // 那会重置已处理操作的 status，导致嵌套存储与状态推进错误。
      const stored = revisionSet.operations.map((item, index) =>
        isStoredOperation(item) ? item : { index, step: item, status: 'pending' as const }
      );
      const target = stored.find((item) => item.index === opIndex);
      if (!target) throw new NotFoundException('Operation not found');

      // 幂等：已处理直接返回当前结果
      if (target.status !== 'pending') {
        return { revision_set: toRevisionSet(revisionSet), operation: toOperationView(target, opIndex) };
      }

      // 首次接受 AI 修订前自动快照（同一修订集只建一个）
      if (revisionSet.ai_set && decision === 'accept' && !(await this.hasAutoSnapshot(manager, revisionSet.chapter_id, revisionSet.id))) {
        await this.ensureAutoSnapshot(manager, revisionSet.chapter_id, revisionSet.id, authorId);
      }

      target.status = decision === 'accept' ? 'accepted' : 'rejected';

      // 接受 AI 修订：把该条 step 应用到章节正文（版本+1、content_hash）。
      // 与 M2 手工修订不同（仅标记状态），M3a D4 要求接受 AI 修订即真正写入正文。
      // 自动快照已在上面 ensureAutoSnapshot 完成（记录的是接受前的正文，作为回滚基准）。
      if (revisionSet.ai_set && decision === 'accept') {
        const chapter = await manager.getRepository(ChapterEntity).findOneBy({ id: revisionSet.chapter_id });
        if (chapter) {
          try {
            const nextDoc = applyOperations(chapter.document, [toSteps([target.step])[0]!]);
            chapter.document = nextDoc.toJSON();
            chapter.version = chapter.version + 1;
            chapter.content_hash = createHash('sha256').update(canonicalizeDocument(nextDoc.toJSON())).digest('hex');
            await manager.save(chapter);
          } catch {
            // 占位/非法 step（前端「创建 AI 修订集」占位操作、或测试构造的假 step）无法应用为真实正文变更：
            // 仅推进修订集状态，不写正文、不改版本。真实 AI replace step 才走上方写入分支。
          }
        }
      }

      const pendingCount = stored.filter((item) => item.status === 'pending').length;
      const acceptedCount = stored.filter((item) => item.status === 'accepted').length;
      const status: RevisionStatus = pendingCount === 0
        ? (acceptedCount > 0 ? 'resolved' : 'resolved')
        : (acceptedCount > 0 ? 'partially_resolved' : 'pending');

      revisionSet.operations = stored;
      revisionSet.status = status;
      await manager.save(revisionSet);

      await this.auditService.record(
        authorId,
        decision === 'accept' ? 'revision_accept' : 'revision_reject',
        'revision_set',
        revisionSetId,
        { chapter_id: revisionSet.chapter_id, op_index: opIndex },
        workId
      );

      return { revision_set: toRevisionSet(revisionSet), operation: toOperationView(target, opIndex) };
    });
  }

  /** 列表修订集（分页 + status 过滤） */
  listRevisionSets(authorId: string, workId: string, chapterId: string, filter: ListRevisionSetsQuery): Promise<{ revision_sets: RevisionSet[]; total: number; page: number; page_size: number }> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedChapter(manager, workId, chapterId, authorId);
      const page = filter.page ?? 1;
      const pageSize = filter.page_size ?? 20;
      const qb = manager.getRepository(RevisionSetEntity).createQueryBuilder('rs')
        .innerJoin(ChapterEntity, 'chapter', 'chapter.id = rs.chapter_id')
        .innerJoin(WorkEntity, 'work', 'work.id = chapter.work_id')
        .where('rs.chapter_id = :chapterId', { chapterId })
        .andWhere('chapter.work_id = :workId', { workId })
        .andWhere('work.author_id = :authorId', { authorId });
      if (filter.status) qb.andWhere('rs.status = :status', { status: filter.status });
      const total = await qb.getCount();
      const revisionSets = await qb
        .orderBy('rs.created_at', 'DESC')
        .skip((page - 1) * pageSize)
        .take(pageSize)
        .getMany();
      return {
        revision_sets: revisionSets.map(toRevisionSet),
        total,
        page,
        page_size: pageSize
      };
    });
  }

  /** 首次接受 AI 修订前自动快照：已存在同版本快照则跳过；同一修订集只建一个（UNIQUE 兜底） */
  private async hasAutoSnapshot(manager: EntityManager, chapterId: string, revisionSetId: string): Promise<boolean> {
    const count = await manager.getRepository(VersionSnapshotEntity).countBy({
      chapter_id: chapterId,
      revision_set_id: revisionSetId
    });
    return count > 0;
  }

  private async ensureAutoSnapshot(manager: EntityManager, chapterId: string, revisionSetId: string, actorId: string | null): Promise<void> {
    const chapter = await manager.getRepository(ChapterEntity).findOneBy({ id: chapterId });
    if (!chapter) throw new NotFoundException('Chapter not found');
    const existing = await manager.getRepository(VersionSnapshotEntity).findOneBy({
      chapter_id: chapterId,
      version_no: chapter.version
    });
    if (existing) return;

    const snapshot = manager.getRepository(VersionSnapshotEntity).create();
    snapshot.id = randomUUID();
    snapshot.chapter_id = chapterId;
    snapshot.version_no = chapter.version;
    snapshot.document = chapter.document as unknown as Record<string, unknown>;
    snapshot.content_hash = createHash('sha256').update(canonicalizeDocument(chapter.document)).digest('hex');
    snapshot.created_by = actorId;
    snapshot.note = '自动快照（首次接受 AI 修订前）';
    snapshot.change_type = 'auto';
    snapshot.revision_set_id = revisionSetId;
    await manager.save(snapshot);
  }
}
