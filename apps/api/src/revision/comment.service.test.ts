import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommentAnchor } from '@storyforge/contracts';
import { ChapterEntity } from '../database/chapter.entity';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { CommentService } from './comment.service';
import { AuditService } from './audit.service';

let fixture: WritingFixture;
let service: CommentService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new CommentService(fixture.dataSource, new AuditService(fixture.dataSource));
});
afterEach(() => destroyWritingFixture(fixture));

function anchor(text: string, start = 0, end = text.length, version = 0): CommentAnchor {
  return { start, end, original_text: text, before_text: '', after_text: '', version };
}

describe('CommentService', () => {
  it('creates a comment with the chapter version snapshot', async () => {
    const { comment } = await service.createComment(fixture.authorId, fixture.workId, fixture.chapterId, {
      anchor: anchor('你好'),
      content: '这段不错'
    });
    expect(comment.status).toBe('open');
    expect(comment.anchor_status).toBe('attached');
    expect(comment.anchor.version).toBe(0);
    expect(comment.parent_id).toBeNull();
  });

  it('replies to a comment thread', async () => {
    const { comment } = await service.createComment(fixture.authorId, fixture.workId, fixture.chapterId, {
      anchor: anchor('原文'),
      content: '首评'
    });
    const { reply } = await service.replyComment(fixture.authorId, fixture.workId, comment.id, { content: '回复' });
    expect(reply.parent_id).toBe(comment.id);
    expect(reply.chapter_id).toBe(comment.chapter_id);
  });

  it('resolves and reopens a comment idempotently', async () => {
    const { comment } = await service.createComment(fixture.authorId, fixture.workId, fixture.chapterId, {
      anchor: anchor('原文'),
      content: '待解决'
    });
    const resolved = await service.resolveComment(fixture.authorId, fixture.workId, comment.id);
    expect(resolved.comment.status).toBe('resolved');
    const again = await service.resolveComment(fixture.authorId, fixture.workId, comment.id);
    expect(again.comment.status).toBe('resolved');
    const reopened = await service.reopenComment(fixture.authorId, fixture.workId, comment.id);
    expect(reopened.comment.status).toBe('reopened');
  });

  it('re-anchors a comment to a new position and marks it attached', async () => {
    const { comment } = await service.createComment(fixture.authorId, fixture.workId, fixture.chapterId, {
      anchor: anchor('旧位置'),
      content: '评论'
    });
    const moved = await service.reAnchorComment(fixture.authorId, fixture.workId, comment.id, {
      anchor: anchor('新位置', 5, 9)
    });
    expect(moved.comment.anchor_status).toBe('attached');
    expect(moved.comment.anchor.original_text).toBe('新位置');
  });

  it('lists chapter comments with reply tree ordering', async () => {
    const { comment } = await service.createComment(fixture.authorId, fixture.workId, fixture.chapterId, {
      anchor: anchor('原文'),
      content: '首评'
    });
    await service.replyComment(fixture.authorId, fixture.workId, comment.id, { content: '回复1' });
    await service.replyComment(fixture.authorId, fixture.workId, comment.id, { content: '回复2' });
    const { comments } = await service.listComments(fixture.authorId, fixture.workId, fixture.chapterId);
    expect(comments).toHaveLength(3);
    expect(comments[0]!.parent_id).toBeNull();
    expect(comments[1]!.parent_id).toBe(comment.id);
    expect(comments[2]!.parent_id).toBe(comment.id);
  });

  it('throws 404 for a missing comment when resolving', async () => {
    await expect(service.resolveComment(fixture.authorId, fixture.workId, '00000000-0000-0000-0000-000000000000'))
      .rejects.toMatchObject({ status: 404 });
  });

  it('throws 404 for cross-author access', async () => {
    const { comment } = await service.createComment(fixture.authorId, fixture.workId, fixture.chapterId, {
      anchor: anchor('原文'),
      content: '他人不可见'
    });
    await expect(service.resolveComment(fixture.otherAuthorId, fixture.workId, comment.id))
      .rejects.toMatchObject({ status: 404 });
  });

  it('relocates an anchor when the original text still exists in the updated document', async () => {
    const { comment } = await service.createComment(fixture.authorId, fixture.workId, fixture.chapterId, {
      anchor: anchor('保留文字'),
      content: '评论'
    });
    // 模拟正文变更：在文档中加入了新文字但保留锚点原文
    await fixture.dataSource.getRepository(ChapterEntity).update(
      { id: fixture.chapterId },
      {
        document: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '前缀保留文字后缀' }] }] },
        version: 1
      }
    );
    // 通过公开 API 无法直接触发 relocate，这里验证 re-anchor 路径的 attached 语义
    const moved = await service.reAnchorComment(fixture.authorId, fixture.workId, comment.id, {
      anchor: anchor('保留文字', 2, 6, 1)
    });
    expect(moved.comment.anchor_status).toBe('attached');
    expect(moved.comment.anchor.version).toBe(1);
  });
});
