// M3c-3 知识库 T24 上传/作业/SSE 4 端点 · 接口层单测（L3）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.5；03-任务规划.md T24
// 验证：端点编排（service 透传 / 参数传递 / 视图映射）+ ok() 包装 + 契约校验。
// 守卫（SessionGuard/CsrfGuard）与路由前缀不在本单测覆盖（由 e2e/模块装配验证）。
// 注：SSE 的流式行为（心跳/close 清理）用 fake timers 直测 controller 层。
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { KnowledgeUploadsController } from './uploads.controller';
import { KnowledgeJobsController } from './jobs.controller';
import { KnowledgeJobsSseController } from './jobs-sse.controller';
import { KnowledgeIngestService } from './knowledge-ingest.service';
import { KnowledgeJobService } from './jobs.processor';
import { KnowledgeJobSseService } from './jobs.sse';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import {
  knowledgeJobSchema,
  knowledgeJobListQuerySchema,
  knowledgeJobReplayQuerySchema,
  knowledgeIdempotencyKeySchema
} from '@storyforge/contracts';
import type { AuthenticatedRequest } from '../common/http';

const AUTHOR_ID = randomUUID();
const JOB_ID = randomUUID();

/** 已认证请求（绕 guard 直调方法，author 固定） */
function req(overrides: Partial<AuthenticatedRequest> = {}): AuthenticatedRequest {
  return {
    requestId: 'req-t24-uploads-jobs',
    cookies: {},
    get: () => undefined,
    author: { id: AUTHOR_ID, email: 'x@example.com', display_name: 'X', created_at: '', updated_at: '' },
    ...overrides
  } as unknown as AuthenticatedRequest;
}

/** 一个完整作业实体（供 toJobView 消费） */
function jobEntity(overrides: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    owner_id: AUTHOR_ID,
    kind: 'structure',
    status: 'queued',
    library_scope: 'global',
    work_id: null,
    entry_id: randomUUID(),
    progress: {},
    result: {},
    error: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    finished_at: null,
    ...overrides
  };
}

describe('KnowledgeUploadsController · T24 上传端点', () => {
  let controller: KnowledgeUploadsController;
  const ingest = { uploadFiles: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    ingest.uploadFiles.mockResolvedValue({
      jobs: [{ job_id: JOB_ID, file_name: 'a.md', status: 'queued' }],
      rejected: []
    });
    controller = new KnowledgeUploadsController(ingest as unknown as KnowledgeIngestService);
  });

  it('上传：无表单字段 → scope 默认 global，透传文件与 opts', async () => {
    const file = { originalname: 'a.md', buffer: Buffer.from('hi'), mimetype: 'text/markdown', size: 2 };
    const res = await controller.upload(req(), [file as never], {});
    expect(ingest.uploadFiles).toHaveBeenCalledWith(
      AUTHOR_ID,
      [{ originalname: 'a.md', buffer: file.buffer, mimetype: 'text/markdown', size: 2 }],
      { scope: 'global' }
    );
    expect(res.request_id).toBe('req-t24-uploads-jobs');
    expect(res.data.jobs[0]).toHaveProperty('job_id');
  });

  it('上传：scope=work 携带 work_id/entry_type/idempotency_key 透传', async () => {
    const wid = randomUUID();
    const file = { originalname: 'b.txt', buffer: Buffer.from('x') };
    await controller.upload(req(), [file as never], {
      scope: 'work',
      work_id: wid,
      entry_type: 'paper',
      idempotency_key: 'ik-1'
    });
    expect(ingest.uploadFiles).toHaveBeenCalledWith(
      AUTHOR_ID,
      [{ originalname: 'b.txt', buffer: file.buffer }],
      { scope: 'work', work_id: wid, entry_type: 'paper', idempotency_key: 'ik-1' }
    );
  });

  it('上传：单文件 mimetype/size 缺失时不带该字段（exactOptionalPropertyTypes）', async () => {
    const file = { originalname: 'c.md', buffer: Buffer.from('y') };
    await controller.upload(req(), [file as never], {});
    expect(ingest.uploadFiles).toHaveBeenCalledWith(
      AUTHOR_ID,
      [{ originalname: 'c.md', buffer: file.buffer }],
      { scope: 'global' }
    );
  });

  it('上传：非法 scope → 422', async () => {
    const file = { originalname: 'a.md', buffer: Buffer.from('hi') };
    await expect(controller.upload(req(), [file as never], { scope: 'bogus' })).rejects.toThrow(
      UnprocessableEntityException
    );
  });

  it('上传：非法 entry_type → 422', async () => {
    const file = { originalname: 'a.md', buffer: Buffer.from('hi') };
    await expect(controller.upload(req(), [file as never], { entry_type: 'nope' })).rejects.toThrow(
      UnprocessableEntityException
    );
  });

  it('上传：非法 work_id → 422', async () => {
    const file = { originalname: 'a.md', buffer: Buffer.from('hi') };
    await expect(controller.upload(req(), [file as never], { work_id: 'not-a-uuid' })).rejects.toThrow(
      UnprocessableEntityException
    );
  });

  it('上传：idempotency_key 超长 → 422', async () => {
    const file = { originalname: 'a.md', buffer: Buffer.from('hi') };
    await expect(
      controller.upload(req(), [file as never], { idempotency_key: 'x'.repeat(200) })
    ).rejects.toThrow(UnprocessableEntityException);
  });
});

describe('KnowledgeJobsController · T24 作业列表/详情', () => {
  let controller: KnowledgeJobsController;
  const jobs = { getJob: vi.fn(), listJobs: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new KnowledgeJobsController(jobs as unknown as KnowledgeJobService);
  });

  it('listJobs：透传过滤，items 映射为契约视图（progress {} → 默认值）', async () => {
    jobs.listJobs.mockResolvedValue({ items: [jobEntity()], total: 1, next_cursor: null });
    const res = await controller.listJobs(req(), { scope: 'global' });
    expect(jobs.listJobs).toHaveBeenCalledWith(AUTHOR_ID, { scope: 'global' });
    expect(res.request_id).toBe('req-t24-uploads-jobs');
    // 契约校验：progress 空对象须归一化，避免 knowledgeJobSchema 422
    const parsed = knowledgeJobSchema.parse(res.data.items[0]);
    expect(parsed.progress).toEqual({ stage: 'queued', processed: 0, total: 0, percent: 0 });
    expect(res.data.total).toBe(1);
    expect(res.data.next_cursor).toBeNull();
  });

  it('listJobs：progress 已有值原样保留', async () => {
    jobs.listJobs.mockResolvedValue({
      items: [
        jobEntity({
          progress: { stage: 'parsing', processed: 1, total: 3, percent: 33 }
        })
      ],
      total: 1,
      next_cursor: null
    });
    const res = await controller.listJobs(req(), {});
    const parsed = knowledgeJobSchema.parse(res.data.items[0]);
    expect(parsed.progress).toEqual({ stage: 'parsing', processed: 1, total: 3, percent: 33 });
  });

  it('listJobs：work_id null 转 undefined（契约 optional 不接受 null）', async () => {
    jobs.listJobs.mockResolvedValue({ items: [jobEntity({ work_id: null })], total: 1, next_cursor: null });
    const res = await controller.listJobs(req(), {});
    const parsed = knowledgeJobSchema.parse(res.data.items[0]);
    expect(parsed.work_id).toBeUndefined();
  });

  it('getJob：返回映射视图', async () => {
    jobs.getJob.mockResolvedValue(jobEntity());
    const res = await controller.getJob(req(), JOB_ID);
    expect(jobs.getJob).toHaveBeenCalledWith(JOB_ID);
    const parsed = knowledgeJobSchema.parse(res.data);
    expect(parsed.id).toBe(JOB_ID);
  });

  it('getJob：404 透传（service 抛 NotFoundException）', async () => {
    jobs.getJob.mockRejectedValue(
      new NotFoundException({ code: 'KNOWLEDGE_JOB_NOT_FOUND', message: '作业不存在' })
    );
    await expect(controller.getJob(req(), JOB_ID)).rejects.toThrow(NotFoundException);
  });

  it('getJob：非本人作业 → 404（归属隔离，不泄露存在性）', async () => {
    jobs.getJob.mockResolvedValue(jobEntity({ owner_id: randomUUID() }));
    await expect(controller.getJob(req(), JOB_ID)).rejects.toThrow(NotFoundException);
  });
});

describe('KnowledgeJobsSseController · T24 SSE 端点', () => {
  let controller: KnowledgeJobsSseController;
  const jobs = { getJob: vi.fn() };
  const sse = { streamEvents: vi.fn(), getJob: vi.fn(), buildReplaySnapshot: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new KnowledgeJobsSseController(
      jobs as unknown as KnowledgeJobService,
      sse as unknown as KnowledgeJobSseService
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 构造 fake express Response（setHeader/flushHeaders/write/end） */
  function fakeResponse() {
    return {
      setHeader: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      end: vi.fn()
    };
  }

  /** 构造 fake request（EventEmitter 支持 close 监听） */
  function fakeRequest(headers: Record<string, string> = {}) {
    const r = new EventEmitter() as unknown as AuthenticatedRequest;
    (r as unknown as Record<string, unknown>).headers = headers;
    (r as unknown as Record<string, unknown>).author = {
      id: AUTHOR_ID,
      email: 'x@example.com',
      display_name: 'X',
      created_at: '',
      updated_at: ''
    };
    (r as unknown as Record<string, unknown>).requestId = 'req-t24-sse';
    return r;
  }

  it('SSE：设置流式头 + flushHeaders + sink 转发事件帧', async () => {
    vi.useFakeTimers();
    jobs.getJob.mockResolvedValue(jobEntity({ owner_id: AUTHOR_ID }));
    sse.streamEvents.mockImplementation(async (_jobId: string, _afterSeq: number, sink: { write: (d: string) => void }) => {
      sink.write('data: {"event":"progress","seq":1}\n\n');
    });
    const response = fakeResponse();
    const request = fakeRequest();
    await controller.streamJobEvents(request, JOB_ID, {}, response as never);

    expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache, no-transform');
    expect(response.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive');
    expect(response.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    expect(response.flushHeaders).toHaveBeenCalled();
    expect(response.write).toHaveBeenCalledWith('data: {"event":"progress","seq":1}\n\n');
    expect(sse.streamEvents).toHaveBeenCalledWith(JOB_ID, 0, expect.anything());
  });

  it('SSE：心跳 15s 写注释帧，close 清理后停止', async () => {
    vi.useFakeTimers();
    jobs.getJob.mockResolvedValue(jobEntity({ owner_id: AUTHOR_ID }));
    sse.streamEvents.mockResolvedValue(undefined);
    const response = fakeResponse();
    const request = fakeRequest();
    await controller.streamJobEvents(request, JOB_ID, {}, response as never);

    vi.advanceTimersByTime(15_000);
    expect(response.write).toHaveBeenCalledWith(': ping\n\n');

    const callsAfterHeartbeat = response.write.mock.calls.length;
    request.emit('close');
    vi.advanceTimersByTime(15_000);
    expect(response.write.mock.calls.length).toBe(callsAfterHeartbeat);
  });

  it('SSE：after_seq 查询参数优先透传', async () => {
    jobs.getJob.mockResolvedValue(jobEntity({ owner_id: AUTHOR_ID }));
    sse.streamEvents.mockResolvedValue(undefined);
    const response = fakeResponse();
    const request = fakeRequest();
    await controller.streamJobEvents(request, JOB_ID, { after_seq: 5 }, response as never);
    expect(sse.streamEvents).toHaveBeenCalledWith(JOB_ID, 5, expect.anything());
  });

  it('SSE：Last-Event-ID 头作为 afterSeq 回退', async () => {
    jobs.getJob.mockResolvedValue(jobEntity({ owner_id: AUTHOR_ID }));
    sse.streamEvents.mockResolvedValue(undefined);
    const response = fakeResponse();
    const request = fakeRequest({ 'last-event-id': '3' });
    await controller.streamJobEvents(request, JOB_ID, {}, response as never);
    expect(sse.streamEvents).toHaveBeenCalledWith(JOB_ID, 3, expect.anything());
  });

  it('SSE：作业不属于当前作者 → 404', async () => {
    jobs.getJob.mockResolvedValue(jobEntity({ owner_id: randomUUID() }));
    const response = fakeResponse();
    const request = fakeRequest();
    await expect(controller.streamJobEvents(request, JOB_ID, {}, response as never)).rejects.toThrow(
      NotFoundException
    );
    expect(sse.streamEvents).not.toHaveBeenCalled();
  });
});

describe('KnowledgeJobsController · ZodValidationPipe 422 校验', () => {
  it('list query：非法 scope → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeJobListQuerySchema);
    expect(() => pipe.transform({ scope: 'bogus' })).toThrow();
  });

  it('list query：合法 global 通过', () => {
    const pipe = new ZodValidationPipe(knowledgeJobListQuerySchema);
    expect(() => pipe.transform({ scope: 'global' })).not.toThrow();
  });

  it('replay query：after_seq 非数字 → 422', () => {
    const pipe = new ZodValidationPipe(knowledgeJobReplayQuerySchema);
    expect(() => pipe.transform({ after_seq: 'abc' })).toThrow();
  });

  it('replay query：合法 after_seq 通过', () => {
    const pipe = new ZodValidationPipe(knowledgeJobReplayQuerySchema);
    expect(() => pipe.transform({ after_seq: 5 })).not.toThrow();
  });

  it('idempotency key：超长 → 422', () => {
    expect(knowledgeIdempotencyKeySchema.safeParse('x'.repeat(200)).success).toBe(false);
    expect(knowledgeIdempotencyKeySchema.safeParse('ik-1').success).toBe(true);
  });
});
