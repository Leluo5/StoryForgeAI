import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TodoEntity } from '../database/todo.entity';
import { NotificationEntity } from '../database/notification.entity';
import { AuditLogEntity } from '../database/audit-log.entity';
import { CommentThreadEntity } from '../database/comment-thread.entity';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { TodoService } from './todo.service';
import { AuditService } from './audit.service';
import { CommentService } from './comment.service';

let fixture: WritingFixture;
let service: TodoService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new TodoService(fixture.dataSource, new AuditService(fixture.dataSource));
});
afterEach(() => destroyWritingFixture(fixture));

async function countNotifications(type?: string): Promise<number> {
  const qb = fixture.dataSource.getRepository(NotificationEntity).createQueryBuilder('n');
  if (type) qb.where('n.type = :type', { type });
  return qb.getCount();
}

async function auditActions(action: string): Promise<number> {
  return fixture.dataSource.getRepository(AuditLogEntity).createQueryBuilder('a')
    .where('a.action = :action', { action })
    .getCount();
}

describe('TodoService', () => {
  it('creates an open todo and emits an assign notification when assignee is set', async () => {
    const { todo } = await service.createTodo(fixture.authorId, fixture.workId, {
      title: '校对第三章',
      description: '检查时间线矛盾',
      assignee_id: fixture.otherAuthorId,
      chapter_id: fixture.chapterId
    });
    expect(todo.status).toBe('open');
    expect(todo.assignee_id).toBe(fixture.otherAuthorId);
    expect(todo.chapter_id).toBe(fixture.chapterId);
    expect(await countNotifications('assign')).toBe(1);
    expect(await auditActions('todo_create')).toBe(1);
  });

  it('creates a todo without notification when no assignee', async () => {
    const { todo } = await service.createTodo(fixture.authorId, fixture.workId, {
      title: '无负责人待办'
    });
    expect(todo.status).toBe('open');
    expect(todo.assignee_id).toBeNull();
    expect(await countNotifications()).toBe(0);
  });

  it('moves through the state machine open → in_progress → done', async () => {
    const { todo } = await service.createTodo(fixture.authorId, fixture.workId, { title: '流转' });
    const inProgress = await service.updateStatus(fixture.authorId, fixture.workId, todo.id, 'in_progress');
    expect(inProgress.todo.status).toBe('in_progress');
    const done = await service.updateStatus(fixture.authorId, fixture.workId, todo.id, 'done');
    expect(done.todo.status).toBe('done');
    expect(await auditActions('todo_status')).toBe(2);
  });

  it('rejects illegal transition from done with 422', async () => {
    const { todo } = await service.createTodo(fixture.authorId, fixture.workId, { title: '已完成' });
    await service.updateStatus(fixture.authorId, fixture.workId, todo.id, 'in_progress');
    await service.updateStatus(fixture.authorId, fixture.workId, todo.id, 'done');
    await expect(service.updateStatus(fixture.authorId, fixture.workId, todo.id, 'open'))
      .rejects.toMatchObject({ status: 422 });
  });

  it('rejects illegal transition from cancelled with 422', async () => {
    const { todo } = await service.createTodo(fixture.authorId, fixture.workId, { title: '已取消' });
    await service.updateStatus(fixture.authorId, fixture.workId, todo.id, 'cancelled');
    await expect(service.updateStatus(fixture.authorId, fixture.workId, todo.id, 'in_progress'))
      .rejects.toMatchObject({ status: 422 });
  });

  it('keeps done as final state on repeated completion without extra audit', async () => {
    const { todo } = await service.createTodo(fixture.authorId, fixture.workId, { title: '重复完成' });
    await service.updateStatus(fixture.authorId, fixture.workId, todo.id, 'done');
    const again = await service.updateStatus(fixture.authorId, fixture.workId, todo.id, 'done');
    expect(again.todo.status).toBe('done');
    expect(await auditActions('todo_status')).toBe(1);
  });

  it('emits a task_result notification on status change when assignee is set', async () => {
    const { todo } = await service.createTodo(fixture.authorId, fixture.workId, {
      title: '通知流转',
      assignee_id: fixture.otherAuthorId
    });
    await service.updateStatus(fixture.authorId, fixture.workId, todo.id, 'in_progress');
    expect(await countNotifications('task_result')).toBe(1);
  });

  it('converts a comment into a todo linked to the comment', async () => {
    const commentService = new CommentService(fixture.dataSource, new AuditService(fixture.dataSource));
    const { comment } = await commentService.createComment(fixture.authorId, fixture.workId, fixture.chapterId, {
      anchor: { start: 0, end: 2, original_text: '原文', before_text: '', after_text: '', version: 0 },
      content: '这段需要改写'
    });
    const { todo } = await service.commentToTodo(fixture.authorId, fixture.workId, comment.id, {
      title: '改写这段'
    });
    expect(todo.comment_id).toBe(comment.id);
    expect(todo.chapter_id).toBe(comment.chapter_id);
    expect(todo.description).toBe('这段需要改写');
    const saved = await fixture.dataSource.getRepository(CommentThreadEntity).findOneByOrFail({ id: comment.id });
    expect(saved.id).toBe(comment.id);
  });

  it('lists todos with status filter and pagination', async () => {
    await service.createTodo(fixture.authorId, fixture.workId, { title: 'A' });
    await service.createTodo(fixture.authorId, fixture.workId, { title: 'B' });
    await service.createTodo(fixture.authorId, fixture.workId, { title: 'C' });
    const all = await service.listTodos(fixture.authorId, fixture.workId, {});
    expect(all.total).toBe(3);
    const one = await service.listTodos(fixture.authorId, fixture.workId, { page: 1, page_size: 2 });
    expect(one.todos).toHaveLength(2);
    expect(one.total).toBe(3);
  });

  it('throws 404 for a missing todo on status update', async () => {
    await expect(service.updateStatus(fixture.authorId, fixture.workId, '00000000-0000-0000-0000-000000000000', 'done'))
      .rejects.toMatchObject({ status: 404 });
  });

  it('throws 404 for cross-author access', async () => {
    const { todo } = await service.createTodo(fixture.authorId, fixture.workId, { title: '私有' });
    await expect(service.updateStatus(fixture.otherAuthorId, fixture.workId, todo.id, 'done'))
      .rejects.toMatchObject({ status: 404 });
  });
});
