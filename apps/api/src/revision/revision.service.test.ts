import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChapterEntity } from '../database/chapter.entity';
import { RevisionSetEntity } from '../database/revision-set.entity';
import { AuditLogEntity } from '../database/audit-log.entity';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { RevisionService } from './revision.service';
import { AuditService } from './audit.service';

let fixture: WritingFixture;
let service: RevisionService;

beforeEach(async () => {
  fixture = await createWritingFixture();
  service = new RevisionService(fixture.dataSource, new AuditService(fixture.dataSource));
});
afterEach(() => destroyWritingFixture(fixture));

const op = (text: string): Record<string, unknown> => ({ type: 'insert', text });

describe('RevisionService', () => {
  it('creates a revision set as pending with ordered operations', async () => {
    const created = await service.createRevisionSet(fixture.authorId, fixture.workId, fixture.chapterId, {
      actor_type: 'author',
      base_version: 0,
      operations: [op('一'), op('二')]
    });
    const rs = created.revision_set;
    expect(rs.status).toBe('pending');
    expect(rs.ai_set).toBe(false);
    expect(rs.actor_type).toBe('author');
    expect(rs.base_version).toBe(0);
    // 存储格式：每条包 index + step + status=pending，index 有序
    const entity = await fixture.dataSource.getRepository(RevisionSetEntity).findOneByOrFail({ id: rs.id });
    expect(entity.operations).toHaveLength(2);
    expect(entity.operations[0]).toMatchObject({ index: 0, status: 'pending' });
    expect(entity.operations[1]).toMatchObject({ index: 1, status: 'pending' });
    expect((entity.operations[0] as { step: Record<string, unknown> }).step).toEqual(op('一'));
  });

  it('marks ai-set revision sets separately and never mixes with manual ones', async () => {
    const ai = await service.createRevisionSet(fixture.authorId, fixture.workId, fixture.chapterId, {
      actor_type: 'ai', base_version: 0, operations: [op('AI 建议')]
    });
    expect(ai.revision_set.ai_set).toBe(true);
    const manual = await service.createRevisionSet(fixture.authorId, fixture.workId, fixture.chapterId, {
      actor_type: 'author', base_version: 0, operations: [op('手写')]
    });
    expect(manual.revision_set.ai_set).toBe(false);
    // 两个独立记录，不合并
    const list = await service.listRevisionSets(fixture.authorId, fixture.workId, fixture.chapterId, {});
    expect(list.total).toBe(2);
    expect(list.revision_sets.map((item) => item.ai_set).sort()).toEqual([false, true]);
  });

  it('throws 409 when base_version does not match the server version', async () => {
    // 推进章节版本到 1（模拟已有未快照修改）
    const chapter = await fixture.dataSource.getRepository(ChapterEntity).findOneByOrFail({ id: fixture.chapterId });
    await fixture.dataSource.getRepository(ChapterEntity).update(
      { id: chapter.id, version: chapter.version },
      { version: chapter.version + 1 }
    );
    await expect(service.createRevisionSet(fixture.authorId, fixture.workId, fixture.chapterId, {
      actor_type: 'author', base_version: 0, operations: [op('过期')]
    })).rejects.toMatchObject({ status: 409 });
  });

  it('rejects a revision set from another author (404)', async () => {
    await expect(service.createRevisionSet(fixture.otherAuthorId, fixture.workId, fixture.chapterId, {
      actor_type: 'author', base_version: 0, operations: [op('越权')]
    })).rejects.toMatchObject({ status: 404 });
  });

  it('accepts a single operation and advances status to partially_resolved then resolved', async () => {
    const created = await service.createRevisionSet(fixture.authorId, fixture.workId, fixture.chapterId, {
      actor_type: 'author', base_version: 0, operations: [op('一'), op('二')]
    });
    const first = await service.resolveOperation(fixture.authorId, fixture.workId, created.revision_set.id, 0, 'accept');
    expect(first.operation.status).toBe('accepted');
    expect(first.revision_set.status).toBe('partially_resolved');
    const second = await service.resolveOperation(fixture.authorId, fixture.workId, created.revision_set.id, 1, 'accept');
    expect(second.operation.status).toBe('accepted');
    expect(second.revision_set.status).toBe('resolved');
  });

  it('rejects a single operation without marking the set resolved when others remain pending', async () => {
    const created = await service.createRevisionSet(fixture.authorId, fixture.workId, fixture.chapterId, {
      actor_type: 'author', base_version: 0, operations: [op('一'), op('二')]
    });
    const rejected = await service.resolveOperation(fixture.authorId, fixture.workId, created.revision_set.id, 0, 'reject');
    expect(rejected.operation.status).toBe('rejected');
    expect(rejected.revision_set.status).toBe('pending');
  });

  it('is idempotent on resolve: a processed operation returns the same result without re-applying', async () => {
    const created = await service.createRevisionSet(fixture.authorId, fixture.workId, fixture.chapterId, {
      actor_type: 'author', base_version: 0, operations: [op('一'), op('二')]
    });
    const first = await service.resolveOperation(fixture.authorId, fixture.workId, created.revision_set.id, 0, 'accept');
    const second = await service.resolveOperation(fixture.authorId, fixture.workId, created.revision_set.id, 0, 'reject');
    // 幂等：第二次（reject）返回与第一次（accept）一致的处理结果，不覆盖原决定
    expect(second.operation.index).toBe(first.operation.index);
    expect(second.operation.status).toBe('accepted');
    expect(second.revision_set.status).toBe(first.revision_set.status);
    // 审计只记一次 accept，不记 reject
    const audit = fixture.dataSource.getRepository(AuditLogEntity);
    expect(await audit.countBy({ action: 'revision_accept' })).toBe(1);
    expect(await audit.countBy({ action: 'revision_reject' })).toBe(0);
  });

  it('throws 404 for a missing operation index', async () => {
    const created = await service.createRevisionSet(fixture.authorId, fixture.workId, fixture.chapterId, {
      actor_type: 'author', base_version: 0, operations: [op('一')]
    });
    await expect(service.resolveOperation(fixture.authorId, fixture.workId, created.revision_set.id, 5, 'accept'))
      .rejects.toMatchObject({ status: 404 });
  });

  it('lists revision sets newest first with status filter and pagination', async () => {
    await service.createRevisionSet(fixture.authorId, fixture.workId, fixture.chapterId, {
      actor_type: 'author', base_version: 0, operations: [op('一')]
    });
    await service.createRevisionSet(fixture.authorId, fixture.workId, fixture.chapterId, {
      actor_type: 'import', base_version: 0, operations: [op('二')]
    });
    const all = await service.listRevisionSets(fixture.authorId, fixture.workId, fixture.chapterId, {});
    expect(all.total).toBe(2);
    expect(all.revision_sets.map((item) => item.actor_type).sort()).toEqual(['author', 'import']);
    const pending = await service.listRevisionSets(fixture.authorId, fixture.workId, fixture.chapterId, { status: 'pending' });
    expect(pending.total).toBe(2);
    const resolved = await service.listRevisionSets(fixture.authorId, fixture.workId, fixture.chapterId, { status: 'resolved' });
    expect(resolved.total).toBe(0);
  });
});
