import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { AiTaskEntity } from '../database/ai-task.entity';
import { AgentArchiveOutboxEntity } from '../database/agent-archive-outbox.entity';
import { CollabArchiveProcessor } from './collab-archive.processor';
import { CollabArchiveService } from './collab-archive.service';
import { CollabUpstreamError } from './channel/collab-upstream.error';
import { AuditService } from '../revision/audit.service';
import { AuditLogEntity } from '../database/audit-log.entity';
import { env } from '../config/env';

// T17 归档重试队列处理器单测：真实 DB fixture + 替身 archiveService。
// 场景：成功/已投递幂等/可重试未超限/超限置 failed+审计/重复重试不新增记录。

let fixture: WritingFixture;
let processor: CollabArchiveProcessor;
let deliverMock: ReturnType<typeof vi.fn>;
let auditService: AuditService;

function makeJob(taskId: string): { data: { taskId: string } } {
  return { data: { taskId } };
}

function collabError(retryable: boolean, code = 'COLLAB_UPSTREAM_FAILED') {
  return new CollabUpstreamError('上游失败', retryable, code as never);
}

beforeEach(async () => {
  vi.clearAllMocks();
  fixture = await createWritingFixture();
  auditService = new AuditService(fixture.dataSource);
  deliverMock = vi.fn();
  processor = new CollabArchiveProcessor(fixture.dataSource, {
    deliver: deliverMock
  } as unknown as CollabArchiveService, auditService);
});

afterEach(() => destroyWritingFixture(fixture));

async function seedTask(workId: string, authorId: string): Promise<string> {
  const repo = fixture.dataSource.getRepository(AiTaskEntity);
  const t = await repo.save(repo.create({
    id: randomUUID(),
    idempotency_key: randomUUID(),
    work_id: workId,
    chapter_id: null,
    scope: 'role_profile',
    channel: 'flowise',
    tool: 'role_profile',
    agent_id: null,
    input_summary: { character_id: randomUUID(), fields: ['identity', 'personality'], instruction: '补充角色' },
    base_version: 0,
    status: 'succeeded',
    created_by: authorId
  }));
  return t.id;
}

async function seedOutbox(taskId: string, opts: { status?: string; attempts?: number; externalId?: string | null } = {}): Promise<string> {
  const repo = fixture.dataSource.getRepository(AgentArchiveOutboxEntity);
  const row = await repo.save(repo.create({
    id: randomUUID(),
    task_id: taskId,
    status: opts.status ?? 'pending',
    attempts: opts.attempts ?? 0,
    external_id: opts.externalId ?? null,
    payload: { work_id: fixture.workId, channel: 'flowise', result_text: '结果', fields: { identity: 'v' } }
  }));
  return row.id;
}

describe('CollabArchiveProcessor (T17 归档重试队列)', () => {
  it('成功投递：调 deliver + 写审计 collab_archive_delivered', async () => {
    const taskId = await seedTask(fixture.workId, fixture.authorId);
    await seedOutbox(taskId);
    deliverMock.mockResolvedValue({ status: 'delivered', externalId: 'exec-1', attempts: 1 });

    await processor.process(makeJob(taskId) as never);

    expect(deliverMock).toHaveBeenCalledWith(taskId);
    const audit = await fixture.dataSource.getRepository(AuditLogEntity).findOneBy({ action: 'collab_archive_delivered' });
    expect(audit).not.toBeNull();
    expect(audit?.detail).toMatchObject({ task_id: taskId, external_id: 'exec-1' });
  });

  it('已 delivered：幂等返回，不调 deliver、不写投递审计', async () => {
    const taskId = await seedTask(fixture.workId, fixture.authorId);
    await seedOutbox(taskId, { status: 'delivered', attempts: 3, externalId: 'exec-old' });

    await processor.process(makeJob(taskId) as never);

    expect(deliverMock).not.toHaveBeenCalled();
    const delivered = await fixture.dataSource.getRepository(AuditLogEntity).findOneBy({ action: 'collab_archive_delivered' });
    expect(delivered).toBeNull();
  });

  it('可重试失败未超限：重抛，不置 failed', async () => {
    const taskId = await seedTask(fixture.workId, fixture.authorId);
    await seedOutbox(taskId, { attempts: 1 }); // attempts 1，deliver 抛错后仍 < MAX
    deliverMock.mockRejectedValue(collabError(true));

    await expect(processor.process(makeJob(taskId) as never)).rejects.toMatchObject({ code: 'COLLAB_UPSTREAM_FAILED' });

    const row = await fixture.dataSource.getRepository(AgentArchiveOutboxEntity).findOneByOrFail({ task_id: taskId });
    expect(row.status).toBe('pending');
    const failed = await fixture.dataSource.getRepository(AuditLogEntity).findOneBy({ action: 'collab_archive_failed' });
    expect(failed).toBeNull();
  });

  it('超限：置 failed + 审计 collab_archive_failed + UnrecoverableError', async () => {
    const taskId = await seedTask(fixture.workId, fixture.authorId);
    // attempts = MAX-1，真实 deliver 失败后 +1 → MAX，视为超限
    const maxAttempts = env.COLLAB_ARCHIVE_MAX_ATTEMPTS;
    await seedOutbox(taskId, { attempts: maxAttempts - 1 });
    // 替身模拟真实 deliver 的失败副作用：先对 outbox 行 attempts+1，再抛错
    deliverMock.mockImplementation(async (tid: string) => {
      const repo = fixture.dataSource.getRepository(AgentArchiveOutboxEntity);
      const row = await repo.findOneByOrFail({ task_id: tid });
      row.attempts = row.attempts + 1;
      row.updated_at = new Date();
      await repo.save(row);
      throw collabError(true);
    });

    await expect(processor.process(makeJob(taskId) as never)).rejects.toBeInstanceOf(UnrecoverableError);

    const row = await fixture.dataSource.getRepository(AgentArchiveOutboxEntity).findOneByOrFail({ task_id: taskId });
    expect(row.status).toBe('failed');
    const failed = await fixture.dataSource.getRepository(AuditLogEntity).findOneBy({ action: 'collab_archive_failed' });
    expect(failed).not.toBeNull();
    expect(failed?.detail).toMatchObject({ task_id: taskId });
  });

  it('不可重试失败：置 failed + 审计（不等超限）', async () => {
    const taskId = await seedTask(fixture.workId, fixture.authorId);
    await seedOutbox(taskId, { attempts: 0 });
    deliverMock.mockRejectedValue(collabError(false, 'COLLAB_CHANNEL_NOT_CONFIGURED'));

    await expect(processor.process(makeJob(taskId) as never)).rejects.toBeInstanceOf(UnrecoverableError);

    const row = await fixture.dataSource.getRepository(AgentArchiveOutboxEntity).findOneByOrFail({ task_id: taskId });
    expect(row.status).toBe('failed');
  });

  it('重复重试已投递：返回当前状态，不新增 outbox 记录', async () => {
    const taskId = await seedTask(fixture.workId, fixture.authorId);
    const outboxId = await seedOutbox(taskId, { status: 'delivered', attempts: 2, externalId: 'exec-x' });

    await processor.process(makeJob(taskId) as never);

    const rows = await fixture.dataSource.getRepository(AgentArchiveOutboxEntity).findBy({ task_id: taskId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(outboxId);
    expect(rows[0]!.status).toBe('delivered');
    expect(rows[0]!.attempts).toBe(2);
  });
});
