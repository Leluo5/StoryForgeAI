import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { NotificationService } from './notification.service';

let fixture: WritingFixture;
let service: NotificationService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new NotificationService(fixture.dataSource);
});
afterEach(() => destroyWritingFixture(fixture));

describe('NotificationService', () => {
  it('records a notification with linked_object snapshot', async () => {
    const notification = await service.record(fixture.authorId, 'assign', { kind: 'todo', id: 'todo-1', label: '校对' }, '你被指派了待办「校对」');
    expect(notification.recipient_id).toBe(fixture.authorId);
    expect(notification.type).toBe('assign');
    expect(notification.linked_object).toEqual({ kind: 'todo', id: 'todo-1', label: '校对' });
    expect(notification.read_at).toBeNull();
  });

  it('records all four notification types', async () => {
    const types = ['mention', 'assign', 'task_result', 'system'] as const;
    for (const type of types) {
      const n = await service.record(fixture.authorId, type, { kind: 'x', id: '1', label: 'L' }, `${type} content`);
      expect(n.type).toBe(type);
    }
    const { total } = await service.list(fixture.authorId, {});
    expect(total).toBe(4);
  });

  it('keeps linked_object readable even without a FK dependency (snapshot semantics)', async () => {
    const notification = await service.record(fixture.authorId, 'system', { kind: 'todo', id: 'deleted-todo', label: '已删除待办' }, '关联对象已删除');
    // 业务对象删除后，linked_object 快照仍保留可读历史说明（非外键依赖）
    expect(notification.linked_object?.label).toBe('已删除待办');
  });

  it('marks a single notification read idempotently', async () => {
    const n = await service.record(fixture.authorId, 'task_result', { kind: 'todo', id: '1', label: 'L' }, '结果');
    const first = await service.markRead(fixture.authorId, n.id);
    expect(first.notification.read_at).not.toBeNull();
    const second = await service.markRead(fixture.authorId, n.id);
    expect(second.notification.read_at).toEqual(first.notification.read_at);
  });

  it('throws 404 for a missing or cross-author notification', async () => {
    const n = await service.record(fixture.authorId, 'assign', { kind: 'todo', id: '1', label: 'L' }, '指派');
    await expect(service.markRead(fixture.otherAuthorId, n.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.markRead(fixture.authorId, '00000000-0000-0000-0000-000000000000'))
      .rejects.toMatchObject({ status: 404 });
  });

  it('marks all notifications read and returns the update count', async () => {
    await service.record(fixture.authorId, 'assign', { kind: 'todo', id: '1', label: 'L' }, '一');
    await service.record(fixture.authorId, 'system', { kind: 'x', id: '2', label: 'L' }, '二');
    await service.record(fixture.otherAuthorId, 'system', { kind: 'x', id: '3', label: 'L' }, '他人的');
    const result = await service.markAllRead(fixture.authorId);
    expect(result.updated).toBe(2);
    const { unread } = await service.unreadCount(fixture.authorId);
    expect(unread).toBe(0);
    // 他人通知不受影响
    const otherUnread = await service.unreadCount(fixture.otherAuthorId);
    expect(otherUnread.unread).toBe(1);
  });

  it('counts unread notifications', async () => {
    await service.record(fixture.authorId, 'assign', { kind: 'todo', id: '1', label: 'L' }, '未读1');
    await service.record(fixture.authorId, 'system', { kind: 'x', id: '2', label: 'L' }, '未读2');
    const n3 = await service.record(fixture.authorId, 'mention', { kind: 'x', id: '3', label: 'L' }, '未读3');
    await service.markRead(fixture.authorId, n3.id);
    const { unread } = await service.unreadCount(fixture.authorId);
    expect(unread).toBe(2);
  });

  it('lists notifications with pagination and unread-only filter', async () => {
    const read = await service.record(fixture.authorId, 'assign', { kind: 'todo', id: '1', label: 'L' }, '已读项');
    await service.markRead(fixture.authorId, read.id);
    await service.record(fixture.authorId, 'system', { kind: 'x', id: '2', label: 'L' }, '未读项');
    const all = await service.list(fixture.authorId, {});
    expect(all.total).toBe(2);
    const unreadOnly = await service.list(fixture.authorId, { unread_only: true });
    expect(unreadOnly.total).toBe(1);
    expect(unreadOnly.notifications[0]!.content).toBe('未读项');
    const paged = await service.list(fixture.authorId, { page: 1, page_size: 1 });
    expect(paged.notifications).toHaveLength(1);
    expect(paged.total).toBe(2);
  });
});
