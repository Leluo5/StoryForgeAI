import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { AuditService } from './audit.service';

let fixture: WritingFixture;
let service: AuditService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new AuditService(fixture.dataSource);
});
afterEach(() => destroyWritingFixture(fixture));

describe('AuditService', () => {
  it('records an audit log and embeds work_id into detail', async () => {
    const log = await service.record(fixture.authorId, 'revision_create', 'revision_set', randomUUID(), {
      chapter_id: fixture.chapterId,
      base_version: 0
    }, fixture.workId);
    expect(log.action).toBe('revision_create');
    expect(log.detail.work_id).toBe(fixture.workId);
  });

  it('queries audit logs within a work scope only', async () => {
    await service.record(fixture.authorId, 'todo_status', 'todo', randomUUID(), { from: 'open', to: 'done' }, fixture.workId);
    await service.record(fixture.authorId, 'comment_resolve', 'comment_thread', randomUUID(), {}, fixture.workId);
    // 另一作品的审计不应被查到
    await service.record(fixture.authorId, 'version_rollback', 'revision_set', randomUUID(), {}, randomUUID());
    const result = await service.query(fixture.workId, {});
    expect(result.total).toBe(2);
    expect(result.audit_logs.every((l) => l.detail.work_id === fixture.workId)).toBe(true);
  });

  it('filters by actor / action / target_type', async () => {
    await service.record(fixture.authorId, 'revision_accept', 'revision_set', randomUUID(), {}, fixture.workId);
    await service.record(fixture.authorId, 'revision_reject', 'revision_set', randomUUID(), {}, fixture.workId);
    await service.record(fixture.otherAuthorId, 'revision_accept', 'revision_set', randomUUID(), {}, fixture.workId);
    const byAction = await service.query(fixture.workId, { action: 'revision_accept' });
    expect(byAction.total).toBe(2);
    const byActor = await service.query(fixture.workId, { actor_id: fixture.authorId });
    expect(byActor.total).toBe(2);
    const byType = await service.query(fixture.workId, { target_type: 'revision_set' });
    expect(byType.total).toBe(3);
  });

  it('filters by time range', async () => {
    await service.record(fixture.authorId, 'revision_create', 'revision_set', randomUUID(), {}, fixture.workId);
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const within = await service.query(fixture.workId, { from: past, to: future });
    expect(within.total).toBe(1);
    const afterFuture = await service.query(fixture.workId, { from: future });
    expect(afterFuture.total).toBe(0);
  });

  it('paginates audit logs', async () => {
    for (let i = 0; i < 5; i++) {
      await service.record(fixture.authorId, `action_${i}`, 'todo', randomUUID(), {}, fixture.workId);
    }
    const page = await service.query(fixture.workId, { page: 1, page_size: 3 });
    expect(page.audit_logs).toHaveLength(3);
    expect(page.total).toBe(5);
    expect(page.page_size).toBe(3);
  });

  it('returns empty for a work with no audit logs', async () => {
    const result = await service.query(fixture.workId, {});
    expect(result.total).toBe(0);
    expect(result.audit_logs).toEqual([]);
  });

  it('never exposes another work audit log through cross-work query', async () => {
    await service.record(fixture.authorId, 'version_rollback', 'revision_set', randomUUID(), {}, fixture.workId);
    await service.record(fixture.authorId, 'version_rollback', 'revision_set', randomUUID(), {}, randomUUID());
    const result = await service.query(randomUUID(), {});
    expect(result.total).toBe(0);
  });
});
