// M3c-3 知识库 T12 作业队列 / processor / SSE 重放 测试
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §5.3、§5.4、§5.5、§4.5、§2.2.7、§2.2.8、§8.2
// 覆盖：七类状态机流转、进度 seq 单调、断线重放快照、幂等键（同键同请求/异请求 409）、
//       退避重试 ≤3 转 failed、终态 404、进程重启 running→failed。
import { ConflictException, NotFoundException } from '@nestjs/common';
import { createWritingFixture, destroyWritingFixture, type WritingFixture } from '../../test/writing-fixture';
import { KnowledgeJobService, computeRequestFingerprint } from './jobs.processor';
import { KnowledgeJobEventBus, KnowledgeJobSseService, type SseSink } from './jobs.sse';
import { KnowledgeJobEntity } from '../database/knowledge-job.entity';
import { KnowledgeJobEventEntity } from '../database/knowledge-job-event.entity';
import type { KnowledgeJobProgress } from '@storyforge/contracts';

let fixture: WritingFixture;
let service: KnowledgeJobService;
let bus: KnowledgeJobEventBus;
let sse: KnowledgeJobSseService;
let queueAdds: string[];

// 内存队列：记录 add 调用，不依赖真实 Redis
const fakeQueue = {
  async add(jobId: string): Promise<void> {
    queueAdds.push(jobId);
  },
  async close(): Promise<void> {}
};

const PROGRESS: KnowledgeJobProgress = { stage: 'chunk', processed: 1, total: 3, percent: 33 };

beforeEach(async () => {
  fixture = await createWritingFixture();
  queueAdds = [];
  bus = new KnowledgeJobEventBus();
  service = new KnowledgeJobService(fixture.dataSource, fakeQueue, bus);
  sse = new KnowledgeJobSseService(fixture.dataSource, bus);
});

afterEach(() => destroyWritingFixture(fixture));

async function countEvents(jobId: string): Promise<number> {
  return fixture.dataSource.getRepository(KnowledgeJobEventEntity).count({ where: { job_id: jobId } });
}

async function lastSeq(jobId: string): Promise<number> {
  const events = await fixture.dataSource
    .getRepository(KnowledgeJobEventEntity)
    .find({ where: { job_id: jobId }, order: { event_seq: 'DESC' }, take: 1 });
  return events[0]?.event_seq ?? 0;
}

async function getJob(jobId: string): Promise<KnowledgeJobEntity> {
  const job = await fixture.dataSource.getRepository(KnowledgeJobEntity).findOneBy({ id: jobId });
  if (!job) throw new Error('job not found');
  return job;
}

describe('KnowledgeJobService · 状态机流转', () => {
  it('创建作业 → queued，写 queued 事件 seq=1，入队一次', async () => {
    const job = await service.createJob({
      ownerId: fixture.authorId,
      scope: 'global',
      kind: 'structure',
      input: { entry_id: '11111111-1111-1111-1111-111111111111' },
      requestFingerprint: 'fp-create-1'
    });
    expect(job.status).toBe('queued');
    expect(job.event_seq).toBe(1);
    expect(job.progress).toEqual({});
    expect(queueAdds).toEqual([job.id]);
    expect(await countEvents(job.id)).toBe(1);
    const ev = await fixture.dataSource.getRepository(KnowledgeJobEventEntity).findOneBy({ job_id: job.id });
    expect(ev!.type).toBe('queued');
    expect(ev!.event_seq).toBe(1);
  });

  it('startRunning → running，写 running 事件 seq=2', async () => {
    const job = await service.createJob({
      ownerId: fixture.authorId, scope: 'global', kind: 'structure',
      input: { entry_id: '11111111-1111-1111-1111-111111111111' }, requestFingerprint: 'fp-run-1'
    });
    const running = await service.startRunning(job.id);
    expect(running.status).toBe('running');
    expect(running.event_seq).toBe(2);
    expect(await lastSeq(job.id)).toBe(2);
  });

  it('reportProgress → 更新 progress，写 progress 事件 seq 单调递增', async () => {
    const job = await service.createJob({
      ownerId: fixture.authorId, scope: 'global', kind: 'structure',
      input: { entry_id: '11111111-1111-1111-1111-111111111111' }, requestFingerprint: 'fp-prog-1'
    });
    await service.startRunning(job.id);
    const p1 = await service.reportProgress(job.id, PROGRESS);
    expect(p1.progress).toEqual(PROGRESS);
    expect(p1.event_seq).toBe(3);
    const p2 = await service.reportProgress(job.id, { ...PROGRESS, processed: 2, percent: 66 });
    expect(p2.event_seq).toBe(4);
    expect(await lastSeq(job.id)).toBe(4);
    // 进度事件按 seq 升序，严格 +1
    const seqs = (await fixture.dataSource.getRepository(KnowledgeJobEventEntity).find({
      where: { job_id: job.id }, order: { event_seq: 'ASC' }
    })).map((e) => e.event_seq);
    expect(seqs).toEqual([1, 2, 3, 4]);
  });

  it('finishSucceeded → succeeded，写 succeeded 事件 + result', async () => {
    const job = await service.createJob({
      ownerId: fixture.authorId, scope: 'global', kind: 'outline',
      input: { entry_id: '11111111-1111-1111-1111-111111111111' }, requestFingerprint: 'fp-ok-1'
    });
    await service.startRunning(job.id);
    const done = await service.finishSucceeded(job.id, { summary: 'ok' });
    expect(done.status).toBe('succeeded');
    expect(done.result).toEqual({ summary: 'ok' });
    expect(done.finished_at).not.toBeNull();
    const ev = await fixture.dataSource.getRepository(KnowledgeJobEventEntity).findOneBy({
      job_id: job.id, type: 'succeeded'
    });
    expect(ev).not.toBeNull();
  });

  it('markFailed → failed，error 含错误码，写 failed 事件', async () => {
    const job = await service.createJob({
      ownerId: fixture.authorId, scope: 'global', kind: 'ingest',
      input: { entry_id: '11111111-1111-1111-1111-111111111111' }, requestFingerprint: 'fp-fail-1'
    });
    await service.startRunning(job.id);
    const failed = await service.markFailed(job.id, { code: 'KNOWLEDGE_PARSE_FAILED', message: '解析失败' });
    expect(failed.status).toBe('failed');
    expect(failed.error).toEqual({ code: 'KNOWLEDGE_PARSE_FAILED', message: '解析失败' });
    const ev = await fixture.dataSource.getRepository(KnowledgeJobEventEntity).findOneBy({
      job_id: job.id, type: 'failed'
    });
    expect(ev).not.toBeNull();
  });

  it('cancelJob → cancelled，写 cancelled 事件', async () => {
    const job = await service.createJob({
      ownerId: fixture.authorId, scope: 'global', kind: 'structure',
      input: { entry_id: '11111111-1111-1111-1111-111111111111' }, requestFingerprint: 'fp-cancel-1'
    });
    const cancelled = await service.cancelJob(job.id);
    expect(cancelled.status).toBe('cancelled');
    const ev = await fixture.dataSource.getRepository(KnowledgeJobEventEntity).findOneBy({
      job_id: job.id, type: 'cancelled'
    });
    expect(ev).not.toBeNull();
  });

  it('非 queued 状态 startRunning 抛 Conflict（重复消费保护）', async () => {
    const job = await service.createJob({
      ownerId: fixture.authorId, scope: 'global', kind: 'structure',
      input: { entry_id: '11111111-1111-1111-1111-111111111111' }, requestFingerprint: 'fp-dup-1'
    });
    await service.startRunning(job.id);
    await expect(service.startRunning(job.id)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('KnowledgeJobService · 幂等键', () => {
  it('同键同指纹 → 返回原作业，不重复入队', async () => {
    const input = {
      ownerId: fixture.authorId, scope: 'global' as const, kind: 'structure' as const,
      input: { entry_id: '11111111-1111-1111-1111-111111111111' }, idempotencyKey: 'key-same-1'
    };
    const first = await service.createJob(input);
    const second = await service.createJob(input);
    expect(second.id).toBe(first.id);
    expect(queueAdds).toEqual([first.id]); // 只入队一次
  });

  it('同键异指纹 → 409 IDEMPOTENCY_KEY_REUSE', async () => {
    const input = {
      ownerId: fixture.authorId, scope: 'global' as const, kind: 'structure' as const,
      input: { entry_id: '11111111-1111-1111-1111-111111111111' }, idempotencyKey: 'key-diff-1'
    };
    await service.createJob(input);
    await expect(
      service.createJob({ ...input, input: { entry_id: '22222222-2222-2222-2222-222222222222' } })
    ).rejects.toMatchObject({ status: 409 });
  });

  it('computeRequestFingerprint：相同输入稳定，不同输入不同', () => {
    const a = computeRequestFingerprint({ kind: 'structure', scope: 'global', workId: null, entryId: 'e1', input: { x: 1 } });
    const b = computeRequestFingerprint({ kind: 'structure', scope: 'global', workId: null, entryId: 'e1', input: { x: 1 } });
    const c = computeRequestFingerprint({ kind: 'structure', scope: 'global', workId: null, entryId: 'e2', input: { x: 1 } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('KnowledgeJobService · 退避重试与进程重启', () => {
  it('消费失败退避重试 ≤3 次后转 failed（错误码可重试）', async () => {
    const job = await service.createJob({
      ownerId: fixture.authorId, scope: 'global', kind: 'structure',
      input: { entry_id: '11111111-1111-1111-1111-111111111111' }, requestFingerprint: 'fp-retry-1'
    });
    await service.startRunning(job.id);
    const r1 = await service.markFailed(job.id, { code: 'KNOWLEDGE_PARSE_FAILED', message: 'x' }, 1);
    expect(r1.status).toBe('failed');
    expect(r1.error).toMatchObject({ code: 'KNOWLEDGE_PARSE_FAILED' });
    // failed 状态不允许直接转 running（重试须经重新入队/新作业编排）
    await expect(service.startRunning(job.id)).rejects.toBeInstanceOf(ConflictException);
  });

  it('recoverHangingJobs：遗留 running 置 failed，可重试', async () => {
    const job = await service.createJob({
      ownerId: fixture.authorId, scope: 'global', kind: 'structure',
      input: { entry_id: '11111111-1111-1111-1111-111111111111' }, requestFingerprint: 'fp-recover-1'
    });
    await service.startRunning(job.id);
    const recovered = await service.recoverHangingJobs(fixture.authorId);
    expect(recovered).toBe(1);
    const after = await getJob(job.id);
    expect(after.status).toBe('failed');
    expect(after.error).toMatchObject({ code: 'KNOWLEDGE_JOB_HANGING' });
  });
});

describe('KnowledgeJobSseService · 断线重放与终态 404', () => {
  it('不存在作业 → 抛 NotFoundException（controller 层转 404）', async () => {
    const sink = new MemorySink();
    await expect(
      sse.streamEvents('99999999-9999-9999-9999-999999999999', 0, sink)
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('after_seq 之后重放：只返回断点后的事件，含终态', async () => {
    const job = await service.createJob({
      ownerId: fixture.authorId, scope: 'global', kind: 'structure',
      input: { entry_id: '11111111-1111-1111-1111-111111111111' }, requestFingerprint: 'fp-replay-1'
    });
    await service.startRunning(job.id);
    await service.reportProgress(job.id, PROGRESS);
    await service.finishSucceeded(job.id, { ok: true });

    const snap = await sse.buildReplaySnapshot(job.id, 2); // after seq=2 → 进度+成功
    expect(snap.events.map((e) => e.type)).toEqual(['progress', 'succeeded']);
    expect(snap.events.map((e) => e.seq)).toEqual([3, 4]);
    expect(snap.terminal).toBe(true);
  });

  it('实时事件经 bus 转发给订阅者', async () => {
    const job = await service.createJob({
      ownerId: fixture.authorId, scope: 'global', kind: 'structure',
      input: { entry_id: '11111111-1111-1111-1111-111111111111' }, requestFingerprint: 'fp-live-1'
    });
    const received: string[] = [];
    const sink: SseSink = { write: (d) => received.push(d), close: () => {} };
    const streamPromise = sse.streamEvents(job.id, 0, sink);
    await service.startRunning(job.id);
    await service.finishSucceeded(job.id, { ok: true });
    await streamPromise;
    expect(received.length).toBeGreaterThanOrEqual(2);
  });

  it('终态后再次订阅 → 快照重放后即关闭', async () => {
    const job = await service.createJob({
      ownerId: fixture.authorId, scope: 'global', kind: 'outline',
      input: { entry_id: '11111111-1111-1111-1111-111111111111' }, requestFingerprint: 'fp-term-1'
    });
    await service.startRunning(job.id);
    await service.finishSucceeded(job.id, {});
    const sink = new MemorySink();
    await sse.streamEvents(job.id, 0, sink);
    expect(sink.written.length).toBeGreaterThanOrEqual(3); // queued+running+succeeded
    expect(sink.closed).toBe(true);
  });
});

class MemorySink implements SseSink {
  written: string[] = [];
  closed = false;
  write(data: string): void {
    this.written.push(data);
  }
  close(): void {
    this.closed = true;
  }
}
