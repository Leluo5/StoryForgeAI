import { randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import type {
  AnchorStatus,
  Comment,
  CommentAnchor,
  CommentStatus,
  CreateCommentRequest,
  ListCommentsResponse,
  ReAnchorCommentRequest,
  ReplyCommentRequest
} from '@storyforge/contracts';
import { ChapterEntity } from '../database/chapter.entity';
import { CommentThreadEntity } from '../database/comment-thread.entity';
import { WorkEntity } from '../database/work.entity';
import { AuditService } from './audit.service';

function toComment(entity: CommentThreadEntity): Comment {
  return {
    id: entity.id,
    chapter_id: entity.chapter_id,
    anchor: entity.anchor as CommentAnchor,
    content: entity.content,
    author_id: entity.author_id,
    parent_id: entity.parent_id,
    status: entity.status as CommentStatus,
    anchor_status: entity.anchor_status as AnchorStatus,
    created_at: entity.created_at.toISOString(),
    updated_at: entity.updated_at.toISOString()
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

async function assertOwnedThread(manager: EntityManager, workId: string, commentId: string, authorId: string, lock = false): Promise<CommentThreadEntity> {
  const qb = manager.getRepository(CommentThreadEntity).createQueryBuilder('comment')
    .innerJoin(ChapterEntity, 'chapter', 'chapter.id = comment.chapter_id')
    .innerJoin(WorkEntity, 'work', 'work.id = chapter.work_id')
    .where('comment.id = :commentId', { commentId })
    .andWhere('chapter.work_id = :workId', { workId })
    .andWhere('work.author_id = :authorId', { authorId });
  if (lock) qb.setLock('pessimistic_write');
  const comment = await qb.getOne();
  if (!comment) throw new NotFoundException('Comment thread not found');
  return comment;
}

/** 提取文档纯文本（递归收集 text 节点） */
function flattenText(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const record = value as Record<string, unknown>;
  if (record.type === 'text' && typeof record.text === 'string') return record.text;
  if (Array.isArray(record.content)) return record.content.map(flattenText).join('');
  return '';
}

/** 用「原文上下文」在新文档纯文本中重新定位锚点；找不到则标记失联 */
function relocateAnchor(anchor: CommentAnchor, chapterDocument: unknown, chapterVersion: number): { anchor: CommentAnchor; anchor_status: AnchorStatus } {
  try {
    const text = flattenText(chapterDocument);
    const original = anchor.original_text;
    if (!original) return { anchor: { ...anchor, version: chapterVersion }, anchor_status: 'orphaned' };
    const start = text.indexOf(original);
    if (start < 0) return { anchor: { ...anchor, version: chapterVersion }, anchor_status: 'orphaned' };
    const end = start + original.length;
    return { anchor: { ...anchor, start, end, version: chapterVersion }, anchor_status: 'attached' };
  } catch {
    return { anchor: { ...anchor, version: chapterVersion }, anchor_status: 'orphaned' };
  }
}

@Injectable()
export class CommentService {
  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(AuditService) private readonly auditService: AuditService
  ) {}

  /** 创建评论：记录选区、原文、前后文、章节版本、作者 */
  createComment(authorId: string, workId: string, chapterId: string, input: CreateCommentRequest): Promise<{ comment: Comment }> {
    return this.dataSource.transaction(async (manager) => {
      const chapter = await assertOwnedChapter(manager, workId, chapterId, authorId, true);
      const anchor: CommentAnchor = { ...input.anchor, version: chapter.version };
      const entity = manager.getRepository(CommentThreadEntity).create();
      entity.id = randomUUID();
      entity.chapter_id = chapterId;
      entity.anchor = anchor;
      entity.content = input.content;
      entity.author_id = authorId;
      entity.parent_id = null;
      entity.status = 'open';
      entity.anchor_status = 'attached';
      await manager.save(entity);
      await this.auditService.record(authorId, 'comment_create', 'comment_thread', entity.id, {
        chapter_id: chapterId,
        version: chapter.version
      }, workId);
      return { comment: toComment(entity) };
    });
  }

  /** 回复评论 */
  replyComment(authorId: string, workId: string, commentId: string, input: ReplyCommentRequest): Promise<{ reply: Comment }> {
    return this.dataSource.transaction(async (manager) => {
      const parent = await assertOwnedThread(manager, workId, commentId, authorId, true);
      const entity = manager.getRepository(CommentThreadEntity).create();
      entity.id = randomUUID();
      entity.chapter_id = parent.chapter_id;
      entity.anchor = { ...(parent.anchor as CommentAnchor), start: 0, end: 1 };
      entity.content = input.content;
      entity.author_id = authorId;
      entity.parent_id = parent.id;
      entity.status = 'open';
      entity.anchor_status = parent.anchor_status as AnchorStatus;
      await manager.save(entity);
      return { reply: toComment(entity) };
    });
  }

  /** 解决评论（幂等） */
  resolveComment(authorId: string, workId: string, commentId: string): Promise<{ comment: Comment }> {
    return this.dataSource.transaction(async (manager) => {
      const comment = await assertOwnedThread(manager, workId, commentId, authorId, true);
      if (comment.status === 'resolved') return { comment: toComment(comment) };
      comment.status = 'resolved';
      await manager.save(comment);
      await this.auditService.record(authorId, 'comment_resolve', 'comment_thread', commentId, {
        previous: comment.status
      }, workId);
      return { comment: toComment(comment) };
    });
  }

  /** 重新打开评论（幂等） */
  reopenComment(authorId: string, workId: string, commentId: string): Promise<{ comment: Comment }> {
    return this.dataSource.transaction(async (manager) => {
      const comment = await assertOwnedThread(manager, workId, commentId, authorId, true);
      if (comment.status === 'reopened') return { comment: toComment(comment) };
      comment.status = 'reopened';
      await manager.save(comment);
      await this.auditService.record(authorId, 'comment_reopen', 'comment_thread', commentId, {
        previous: comment.status
      }, workId);
      return { comment: toComment(comment) };
    });
  }

  /** 手动重新关联锚点：anchor_status 回 attached */
  reAnchorComment(authorId: string, workId: string, commentId: string, input: ReAnchorCommentRequest): Promise<{ comment: Comment }> {
    return this.dataSource.transaction(async (manager) => {
      const comment = await assertOwnedThread(manager, workId, commentId, authorId, true);
      comment.anchor = { ...input.anchor, version: input.anchor.version };
      comment.anchor_status = 'attached';
      await manager.save(comment);
      await this.auditService.record(authorId, 'comment_reanchor', 'comment_thread', commentId, {
        chapter_id: comment.chapter_id
      }, workId);
      return { comment: toComment(comment) };
    });
  }

  /** 列出章节评论（含回复树、失联标记），按创建时间升序 */
  listComments(authorId: string, workId: string, chapterId: string): Promise<ListCommentsResponse> {
    return this.dataSource.transaction(async (manager) => {
      await assertOwnedChapter(manager, workId, chapterId, authorId);
      const comments = await manager.getRepository(CommentThreadEntity).find({
        where: { chapter_id: chapterId },
        order: { created_at: 'ASC' }
      });
      return { comments: comments.map(toComment) };
    });
  }
}
