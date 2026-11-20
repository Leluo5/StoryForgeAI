import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { applyOperations, canonicalizeContent, replaceDocumentOperations } from '@storyforge/editor-schema';
import type {
  CompareVersionsRequest,
  CompareVersionsResponse,
  ConfirmRollbackResponse,
  CreateVersionRequest,
  CreateVersionResponse,
  GetVersionResponse,
  ListVersionsQuery,
  ListVersionsResponse,
  RevisionSet,
  RevisionStatus,
  VersionSnapshot,
  VersionSummary
} from '@storyforge/contracts';
import { ChapterEntity } from '../database/chapter.entity';
import { ChapterChangeEntity } from '../database/chapter-change.entity';
import { RevisionSetEntity } from '../database/revision-set.entity';
import { VersionSnapshotEntity } from '../database/version-snapshot.entity';
import { WorkEntity } from '../database/work.entity';
import { AuditService } from './audit.service';

function toVersionSummary(entity: VersionSnapshotEntity): VersionSummary {
  return {
    id: entity.id,
    chapter_id: entity.chapter_id,
    version_no: entity.version_no,
    content_hash: entity.content_hash,
    created_by: entity.created_by,
    note: entity.note,
    change_type: entity.change_type as VersionSummary['change_type'],
    revision_set_id: entity.revision_set_id,
    created_at: entity.created_at.toISOString()
  };
}

function toVersionSnapshot(entity: VersionSnapshotEntity): VersionSnapshot {
  return { ...toVersionSummary(entity), document: entity.document };
}

/** 从存储格式提取纯 step 数组（供 applyOperations / 回滚应用） */
function toSteps(operations: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return operations.map((item) => {
    if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).step === 'object') {
      return (item as Record<string, unknown>).step as Record<string, unknown>;
    }
    return item;
  });
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

/** 扁平化文档纯文本（递归收集 text 节点） */
function flattenText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (record.type === 'text' && typeof record.text === 'string') return record.text;
  if (Array.isArray(record.content)) return record.content.map(flattenText).join('');
  return '';
}

interface BlockInfo {
  path: string;
  type: string;
  text: string;
}

/** 收集顶层块节点信息（索引对齐近似对比） */
function collectBlocks(doc: unknown): BlockInfo[] {
  const record = doc as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  return content.map((node, index) => {
    const block = node as Record<string, unknown>;
    return { path: String(index), type: String(block.type ?? ''), text: flattenText(node) };
  });
}

function compareNodes(from: unknown, to: unknown): CompareVersionsResponse['node_changes'] {
  const before = collectBlocks(from);
  const after = collectBlocks(to);
  const changes: CompareVersionsResponse['node_changes'] = [];
  const max = Math.max(before.length, after.length);
  for (let i = 0; i < max; i++) {
    const path = String(i);
    const left = before[i];
    const right = after[i];
    if (left && !right) changes.push({ node_path: path, change: 'removed' });
    else if (!left && right) changes.push({ node_path: path, change: 'added' });
    else if (left && right && (left.type !== right.type || left.text !== right.text)) {
      changes.push({ node_path: path, change: 'modified' });
    }
  }
  return changes;
}

/** 行级 LCS diff，返回 insert/delete/equal 段；规模超限退化为整体替换 */
function lcsDiff(left: string[], right: string[]): CompareVersionsResponse['text_diff'] {
  const n = left.length;
  const m = right.length;
  if (n === 0 && m === 0) return [];
  const result: CompareVersionsResponse['text_diff'] = [];
  const push = (kind: 'insert' | 'delete' | 'equal', text: string): void => {
    if (!text) return;
    const last = result[result.length - 1];
    if (last && last.kind === kind) last.text += text;
    else result.push({ kind, text });
  };
  // 性能保护：行数乘积超限则退化为整段替换
  if (n * m > 2_000_000) {
    return [
      { kind: 'delete', text: left.join('\n') },
      { kind: 'insert', text: right.join('\n') }
    ];
  }
  // 扁平 DP：dp[i][j] = left[i..] 与 right[j..] 的 LCS 长度
  const width = m + 1;
  const dp = new Uint32Array((n + 1) * width);
  const at = (i: number, j: number): number => i * width + j;
  const leftAt = (i: number): string => left[i] as string;
  const rightAt = (j: number): string => right[j] as string;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[at(i, j)] = leftAt(i) === rightAt(j)
        ? (dp[at(i + 1, j + 1)] as number) + 1
        : Math.max(dp[at(i + 1, j)] as number, dp[at(i, j + 1)] as number);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && leftAt(i) === rightAt(j)) {
      push('equal', leftAt(i));
      i++;
      j++;
    } else if (j < m && (i === n || (dp[at(i, j + 1)] as number) >= (dp[at(i + 1, j)] as number))) {
      push('insert', rightAt(j));
      j++;
    } else {
      push('delete', leftAt(i));
      i++;
    }
  }
  return result;
}

function diffText(before: string, after: string): CompareVersionsResponse['text_diff'] {
  return lcsDiff(before.split('\n'), after.split('\n'));
}

@Injectable()
export class VersionService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  /** 自动快照：已存在 (chapter_id, version_no) 快照则跳过；同一修订集只建一个（UNIQUE 兜底） */
  private async ensureAutoSnapshot(
    manager: EntityManager,
    chapterId: string,
    revisionSetId: string | null,
    actorId: string | null,
    note: string
  ): Promise<VersionSnapshotEntity> {
    const chapter = await manager.getRepository(ChapterEntity).findOneBy({ id: chapterId });
    if (!chapter) throw new NotFoundException('Chapter not found');
    const existing = await manager.getRepository(VersionSnapshotEntity).findOneBy({
      chapter_id: chapterId,
      version_no: chapter.version
    });
    if (existing) return existing;

    const snapshot = manager.getRepository(VersionSnapshotEntity).create();
    snapshot.id = randomUUID();
    snapshot.chapter_id = chapterId;
    snapshot.version_no = chapter.version;
    snapshot.document = chapter.document as unknown as Record<string, unknown>;
    snapshot.content_hash = createHash('sha256').update(canonicalizeContent(chapter.document)).digest('hex');
    snapshot.created_by = actorId;
    snapshot.note = note;
    snapshot.change_type = 'auto';
    snapshot.revision_set_id = revisionSetId;
    return manager.save(snapshot);
  }

  /** 手动创建版本：给当前版本打不可变快照；已存在同版本快照则幂等返回 */
  createVersion(authorId: string, workId: string, chapterId: string, input: CreateVersionRequest): Promise<CreateVersionResponse> {
    return this.dataSource.transaction(async (manager) => {
      const chapter = await assertOwnedChapter(manager, workId, chapterId, authorId, true);
      const existing = await manager.getRepository(VersionSnapshotEntity).findOneBy({
        chapter_id: chapterId,
        version_no: chapter.version
      });
      if (existing) return { version_no: existing.version_no, snapshot_id: existing.id };

      const snapshot = manager.getRepository(VersionSnapshotEntity).create();
      snapshot.id = randomUUID();
      snapshot.chapter_id = chapterId;
      snapshot.version_no = chapter.version;
      snapshot.document = chapter.document as unknown as Record<string, unknown>;
      snapshot.content_hash = createHash('sha256').update(canonicalizeContent(chapter.document)).digest('hex');
      snapshot.created_by = authorId;
      snapshot.note = input.note ?? null;
      snapshot.change_type = 'manual';
      snapshot.revision_set_id = null;
      await manager.save(snapshot);
      return { version_no: snapshot.version_no, snapshot_id: snapshot.id };
    });
  }

  /** 版本历史（分页，version_no DESC） */
  listVersions(authorId: string, workId: string, chapterId: string, query: ListVersionsQuery): Promise<ListVersionsResponse> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedChapter(manager, workId, chapterId, authorId);
      const page = query.page ?? 1;
      const pageSize = query.page_size ?? 20;
      const repo = manager.getRepository(VersionSnapshotEntity);
      const total = await repo.countBy({ chapter_id: chapterId });
      const versions = await repo.find({
        where: { chapter_id: chapterId },
        order: { version_no: 'DESC' },
        skip: (page - 1) * pageSize,
        take: pageSize
      });
      return { versions: versions.map(toVersionSummary), total };
    });
  }

  /** 单个版本快照（含 document + hash） */
  getVersion(authorId: string, workId: string, chapterId: string, versionNo: number): Promise<GetVersionResponse> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedChapter(manager, workId, chapterId, authorId);
      const snapshot = await manager.getRepository(VersionSnapshotEntity).findOneBy({
        chapter_id: chapterId,
        version_no: versionNo
      });
      if (!snapshot) throw new NotFoundException('Version snapshot not found');
      return { snapshot: toVersionSnapshot(snapshot) };
    });
  }

  /** 对比两版本：节点变更 + 正文行级 diff */
  compareVersions(authorId: string, workId: string, chapterId: string, input: CompareVersionsRequest): Promise<CompareVersionsResponse> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedChapter(manager, workId, chapterId, authorId);
      const from = await manager.getRepository(VersionSnapshotEntity).findOneBy({
        chapter_id: chapterId,
        version_no: input.from_version_no
      });
      const to = await manager.getRepository(VersionSnapshotEntity).findOneBy({
        chapter_id: chapterId,
        version_no: input.to_version_no
      });
      if (!from) throw new NotFoundException(`Version ${input.from_version_no} not found`);
      if (!to) throw new NotFoundException(`Version ${input.to_version_no} not found`);
      return {
        from_version_no: input.from_version_no,
        to_version_no: input.to_version_no,
        node_changes: compareNodes(from.document, to.document),
        text_diff: diffText(flattenText(from.document), flattenText(to.document))
      };
    });
  }

  /** 回滚：以目标快照为基准生成新回滚修订集（actor_type='rollback'），作者确认后才成为当前正文 */
  rollback(authorId: string, workId: string, chapterId: string, targetVersionNo: number): Promise<{ revision_set: RevisionSet; preview: Record<string, unknown> }> {
    return this.dataSource.transaction(async (manager) => {
      const chapter = await assertOwnedChapter(manager, workId, chapterId, authorId, true);
      const target = await manager.getRepository(VersionSnapshotEntity).findOneBy({
        chapter_id: chapterId,
        version_no: targetVersionNo
      });
      if (!target) throw new NotFoundException('Target version snapshot not found');

      // 回滚前自动快照当前正文（不关联回滚修订集，记录回滚前状态）
      await this.ensureAutoSnapshot(manager, chapterId, null, authorId, '回滚前自动快照');

      // 生成 operations：将当前正文变为目标正文（整篇替换）
      const operations = replaceDocumentOperations(chapter.document, target.document);

      const entity = manager.getRepository(RevisionSetEntity).create();
      entity.id = randomUUID();
      entity.chapter_id = chapterId;
      entity.base_version = chapter.version;
      entity.actor_type = 'rollback';
      entity.actor_id = null;
      entity.operations = operations.map((step, index) => ({ index, step, status: 'pending' as const }));
      entity.status = 'pending';
      entity.ai_set = false;
      await manager.save(entity);

      await this.auditService.record(authorId, 'version_rollback', 'revision_set', entity.id, {
        chapter_id: chapterId,
        target_version_no: targetVersionNo,
        base_version: chapter.version
      }, workId);

      return { revision_set: toRevisionSet(entity), preview: target.document };
    });
  }

  /** 确认回滚：作者确认后才成为当前正文（幂等）。校验无未保存变更，否则 409 */
  confirmRollback(authorId: string, workId: string, revisionSetId: string): Promise<ConfirmRollbackResponse> {
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
      if (revisionSet.actor_type !== 'rollback') {
        throw new ConflictException({ message: 'Revision set is not a rollback' });
      }

      // 幂等：已确认直接返回当前章节
      if (revisionSet.status === 'resolved') {
        const current = await manager.getRepository(ChapterEntity).findOneBy({ id: revisionSet.chapter_id });
        if (!current) throw new NotFoundException('Chapter not found');
        return { version_no: current.version, document: current.document as unknown as Record<string, unknown> };
      }

      const chapter = await manager.getRepository(ChapterEntity).createQueryBuilder('chapter')
        .where('chapter.id = :chapterId', { chapterId: revisionSet.chapter_id })
        .setLock('pessimistic_write')
        .getOne();
      if (!chapter) throw new NotFoundException('Chapter not found');

      // 无未保存变更：章节当前版本必须等于回滚修订集 base_version
      if (chapter.version !== revisionSet.base_version) {
        throw new ConflictException({
          message: '请先保存',
          details: { server_version: chapter.version, base_version: revisionSet.base_version }
        });
      }

      let document;
      try {
        document = applyOperations(chapter.document, toSteps(revisionSet.operations));
      } catch {
        throw new ConflictException({ message: 'Invalid rollback operations' });
      }
      const contentHash = createHash('sha256').update(canonicalizeContent(document.toJSON())).digest('hex');
      const serverVersion = chapter.version + 1;
      const updated = await manager.update(ChapterEntity, { id: chapter.id, version: chapter.version }, {
        document: document.toJSON(),
        version: serverVersion,
        content_hash: contentHash
      });
      if (updated.affected !== 1) throw new ConflictException({ message: 'Chapter version conflict' });

      const change = manager.getRepository(ChapterChangeEntity).create();
      change.id = randomUUID();
      change.chapter_id = chapter.id;
      change.author_id = authorId;
      change.change_id = randomUUID();
      change.client_id = randomUUID();
      change.sequence = 1;
      change.base_version = chapter.version;
      change.server_version = serverVersion;
      change.operations = toSteps(revisionSet.operations);
      change.content_hash = contentHash;
      await manager.save(change);

      revisionSet.status = 'resolved';
      await manager.save(revisionSet);

      // 回滚确认后生成新版本快照（回滚结果），供后续对比/回滚；UNIQUE(chapter_id, version_no) 幂等兜底
      const snap = await manager.getRepository(VersionSnapshotEntity).findOneBy({
        chapter_id: chapter.id,
        version_no: serverVersion
      });
      if (!snap) {
        const snapshot = manager.getRepository(VersionSnapshotEntity).create();
        snapshot.id = randomUUID();
        snapshot.chapter_id = chapter.id;
        snapshot.version_no = serverVersion;
        snapshot.document = document.toJSON() as unknown as Record<string, unknown>;
        snapshot.content_hash = contentHash;
        snapshot.created_by = authorId;
        snapshot.note = '回滚后快照';
        snapshot.change_type = 'auto';
        snapshot.revision_set_id = revisionSetId;
        await manager.save(snapshot);
      }

      await this.auditService.record(authorId, 'version_rollback_confirm', 'revision_set', revisionSetId, {
        chapter_id: chapter.id,
        version: serverVersion
      }, workId);

      return { version_no: serverVersion, document: document.toJSON() as unknown as Record<string, unknown> };
    });
  }
}
