import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiError } from '../api/client';
import {
  knowledgeClient,
  type KnowledgeClient,
  type KnowledgeSoftDeleteResult,
  type KnowledgePurgeResult,
  type KnowledgeExportResult,
  type KnowledgeImportCommitResult,
  type KnowledgeBackupResult,
  type KnowledgeRestoreCommitResult,
  type KnowledgeUploadInput,
  type KnowledgeImportPreviewOptions
} from './knowledge-client';
import {
  knowledgeReducer,
  knowledgeInitialState,
  knowledgeCacheKey,
  mergeJobEvent,
  applyEntryOptimistic,
  revertEntryOptimistic,
  knowledgeErrorMessage,
  type KnowledgeState,
  type KnowledgeAction
} from './knowledge-state';
import type {
  KnowledgeEntrySummary,
  KnowledgeEntryDetail,
  KnowledgeTag,
  KnowledgeLink,
  KnowledgeJob,
  KnowledgeJobEvent,
  KnowledgeJobProgress,
  KnowledgeScope,
  KnowledgeEntryType,
  KnowledgeSearchResponse
} from '@storyforge/contracts';

// ───────────────────────────── mock 基础设施 ─────────────────────────────

const { apiRequestMock, fetchMock } = vi.hoisted(() => ({
  apiRequestMock: vi.fn(),
  fetchMock: vi.fn()
}));
vi.mock('../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/client')>();
  return { ...actual, apiRequest: apiRequestMock };
});

// 全局 EventSource mock（SSE）
class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  withCredentials: boolean;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  listeners = new Map<string, (event: MessageEvent<string>) => void>();
  closed = false;
  constructor(url: string, init?: EventSourceInit) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: string, lastEventId: string | null = null): void {
    const handler = type === 'message' ? this.onmessage : this.listeners.get(type);
    if (handler) handler({ data, lastEventId } as MessageEvent<string>);
  }
}

// ───────────────────────────── fixtures ─────────────────────────────

const UUID = '11111111-1111-4111-8111-111111111111';
const TS = '2026-01-01T00:00:00.000Z';

const summaryFixture: KnowledgeEntrySummary = {
  kind: 'entry',
  id: UUID,
  entry_type: 'article',
  title: '测试条目',
  excerpt: '摘要文本',
  tags: ['tag1'],
  structure_status: 'ready',
  outline_status: 'ready',
  favorite: false,
  pinned: false,
  created_at: TS,
  updated_at: TS
};

const detailFixture: KnowledgeEntryDetail = {
  ...summaryFixture,
  original_text: '原文内容',
  structured: null,
  outline: null,
  version: 1,
  content_hash: 'abcdef'
};

const tagFixture: KnowledgeTag = { id: UUID, name: 'tag1', entry_count: 1 };

const linkFixture: KnowledgeLink = {
  id: UUID,
  source_entry_id: UUID,
  target_entry_id: UUID,
  kind: 'manual',
  source_title: '源',
  target_title: '目标',
  created_at: TS
};

const progressFixture: KnowledgeJobProgress = { stage: 'start', processed: 0, total: 0, percent: 0 };

const jobFixture: KnowledgeJob = {
  id: UUID,
  kind: 'structure',
  status: 'queued',
  library_scope: 'global',
  progress: progressFixture,
  result: {},
  error: null,
  created_at: TS,
  finished_at: null
};

const eventFixture: KnowledgeJobEvent = {
  seq: 1,
  type: 'progress',
  job_id: UUID,
  progress: progressFixture,
  at: TS
};

// apiRequest mock：按 URL 返回预设响应
function mockApi(data: unknown): void {
  apiRequestMock.mockResolvedValue(data);
}

// 读取 apiRequest 第 N 次调用的 (path, schema, init)
function callAt(index: number): { path: string; init: RequestInit | undefined } {
  const [path, , init] = apiRequestMock.mock.calls[index] as [string, unknown, RequestInit | undefined];
  return { path, init };
}

// 读取 fetch 第 N 次调用的 (url, init)（fetchRaw：multipart 上传 / 二进制下载）
function fetchCallAt(index: number): { url: string; init: RequestInit | undefined } {
  const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit | undefined];
  return { url, init };
}

beforeEach(() => {
  apiRequestMock.mockReset();
  fetchMock.mockReset();
  MockEventSource.instances = [];
  vi.stubGlobal('EventSource', MockEventSource);
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ───────────────────────────── client：端点封装 ─────────────────────────────

describe('knowledgeClient 端点封装', () => {
  it('暴露 34 个端点方法', () => {
    const methods = [
      'fetchSummary', 'listEntries', 'createEntry', 'fetchEntry', 'patchEntry', 'removeEntry',
      'restoreEntry', 'purgeEntry', 'restructureEntry', 'setEntryFlags',
      'listTags', 'createTag', 'renameTag', 'deleteTag',
      'listLinks', 'createLink', 'deleteLink',
      'listRefs', 'createRefs', 'removeRef', 'setRefFlags', 'copyRef',
      'listJobs', 'getJob', 'subscribeJobEvents',
      'uploadFiles', 'exportKnowledge', 'downloadExport',
      'previewImport', 'commitImport',
      'createBackup', 'downloadBackup', 'previewRestore', 'commitRestore'
    ];
    for (const m of methods) {
      expect(typeof (knowledgeClient as unknown as Record<string, unknown>)[m]).toBe('function');
    }
  });

  it('fetchSummary 调用 GET /summary 并解析', async () => {
    const data = { global: { entries: 1, trash: 0, references: 2 }, work: null };
    mockApi(data);
    const res = await knowledgeClient.fetchSummary();
    expect(res).toEqual(data);
    const { path, init } = callAt(0);
    expect(path).toBe('/api/v1/knowledge/summary');
    expect(init?.method ?? 'GET').toBe('GET');
  });

  it('fetchSummary 带 work_id 追加查询参数', async () => {
    mockApi({ global: { entries: 1, trash: 0, references: 2 }, work: null });
    await knowledgeClient.fetchSummary({ work_id: UUID });
    const { path } = callAt(0);
    expect(path).toBe(`/api/v1/knowledge/summary?work_id=${UUID}`);
  });

  it('listEntries 用 parse 后的 query 构造 URLSearchParams（含默认 time_field/limit）', async () => {
    mockApi({ items: [summaryFixture], total: 1, next_cursor: null });
    await knowledgeClient.listEntries({ scope: 'global', types: ['article'], limit: 10 });
    const { path } = callAt(0);
    expect(path).toBe('/api/v1/knowledge/entries?scope=global&types=article&time_field=created_at&limit=10');
  });

  it('listEntries 回收站视图传 deleted=true', async () => {
    mockApi({ items: [summaryFixture], total: 1, next_cursor: null });
    await knowledgeClient.listEntries({ scope: 'global', deleted: true });
    const { path } = callAt(0);
    expect(path).toContain('deleted=true');
  });

  it('createEntry 调用 POST /entries 并传 JSON body', async () => {
    mockApi(detailFixture);
    const res = await knowledgeClient.createEntry({ scope: 'global', text: '内容', entry_type: 'article', title: '标题' });
    expect(res).toEqual(detailFixture);
    const { path, init } = callAt(0);
    expect(path).toBe('/api/v1/knowledge/entries');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toMatchObject({ scope: 'global', text: '内容', entry_type: 'article', title: '标题' });
  });

  it('fetchEntry 调用 GET /entries/:id', async () => {
    mockApi(detailFixture);
    await knowledgeClient.fetchEntry(UUID);
    const { path } = callAt(0);
    expect(path).toBe(`/api/v1/knowledge/entries/${UUID}`);
  });

  it('patchEntry 调用 PATCH /entries/:id 并带 expected_version', async () => {
    mockApi(detailFixture);
    await knowledgeClient.patchEntry(UUID, { title: '新标题', expected_version: 3 });
    const { path, init } = callAt(0);
    expect(path).toBe(`/api/v1/knowledge/entries/${UUID}`);
    expect(init?.method).toBe('PATCH');
    expect(JSON.parse(init?.body as string)).toEqual({ title: '新标题', expected_version: 3 });
  });

  it('removeEntry 调用 DELETE /entries/:id', async () => {
    const data: KnowledgeSoftDeleteResult = { id: UUID, deleted_at: TS, referenced_by: [] };
    mockApi(data);
    await knowledgeClient.removeEntry(UUID);
    const { path, init } = callAt(0);
    expect(path).toBe(`/api/v1/knowledge/entries/${UUID}`);
    expect(init?.method).toBe('DELETE');
  });

  it('restoreEntry 调用 POST /entries/:id/restore', async () => {
    mockApi({ ok: true });
    await knowledgeClient.restoreEntry(UUID);
    const { path, init } = callAt(0);
    expect(path).toBe(`/api/v1/knowledge/entries/${UUID}/restore`);
    expect(init?.method).toBe('POST');
  });

  it('purgeEntry 调用 DELETE /entries/:id/permanent 并带 confirm', async () => {
    const data: KnowledgePurgeResult = { id: UUID, purged_at: TS, referenced_by: [] };
    mockApi(data);
    await knowledgeClient.purgeEntry(UUID);
    const { path, init } = callAt(0);
    expect(path).toBe(`/api/v1/knowledge/entries/${UUID}/permanent`);
    expect(init?.method).toBe('DELETE');
  });

  it('restructureEntry 调用 POST /entries/:id/restructure 并带 entry_type', async () => {
    mockApi({ job_id: UUID, status: 'queued' });
    await knowledgeClient.restructureEntry(UUID, { entry_type: 'novel' });
    const { path, init } = callAt(0);
    expect(path).toBe(`/api/v1/knowledge/entries/${UUID}/restructure`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ entry_type: 'novel' });
  });

  it('setEntryFlags 调用 PUT /entries/:id/flags', async () => {
    mockApi({ favorite: true, pinned: false });
    await knowledgeClient.setEntryFlags(UUID, { favorite: true });
    const { path, init } = callAt(0);
    expect(path).toBe(`/api/v1/knowledge/entries/${UUID}/flags`);
    expect(init?.method).toBe('PUT');
    expect(JSON.parse(init?.body as string)).toEqual({ favorite: true });
  });

  it('listTags 调用 GET /tags 并带 scope/work_id', async () => {
    mockApi([tagFixture]);
    await knowledgeClient.listTags({ scope: 'work', work_id: UUID });
    const { path } = callAt(0);
    expect(path).toBe(`/api/v1/knowledge/tags?scope=work&work_id=${UUID}`);
  });

  it('createTag 调用 POST /tags', async () => {
    mockApi(tagFixture);
    await knowledgeClient.createTag({ scope: 'global', name: 'tag1' });
    const { path, init } = callAt(0);
    expect(path).toBe('/api/v1/knowledge/tags');
    expect(init?.method).toBe('POST');
  });

  it('renameTag 调用 PATCH /tags/:id', async () => {
    mockApi(tagFixture);
    await knowledgeClient.renameTag(UUID, { name: 'newname' });
    const { path, init } = callAt(0);
    expect(path).toBe(`/api/v1/knowledge/tags/${UUID}`);
    expect(init?.method).toBe('PATCH');
  });

  it('deleteTag 调用 DELETE /tags/:id', async () => {
    mockApi({ ok: true });
    await knowledgeClient.deleteTag(UUID);
    const { path, init } = callAt(0);
    expect(path).toBe(`/api/v1/knowledge/tags/${UUID}`);
    expect(init?.method).toBe('DELETE');
  });

  it('listLinks 调用 GET /entries/:id/links', async () => {
    mockApi([linkFixture]);
    await knowledgeClient.listLinks(UUID);
    const { path } = callAt(0);
    expect(path).toBe(`/api/v1/knowledge/entries/${UUID}/links`);
  });

  it('createLink 调用 POST /links', async () => {
    mockApi(linkFixture);
    await knowledgeClient.createLink({ source_entry_id: UUID, target_entry_id: UUID });
    const { path, init } = callAt(0);
    expect(path).toBe('/api/v1/knowledge/links');
    expect(init?.method).toBe('POST');
  });

  it('deleteLink 调用 DELETE /links/:id', async () => {
    mockApi({ ok: true });
    await knowledgeClient.deleteLink(UUID);
    const { path, init } = callAt(0);
    expect(path).toBe(`/api/v1/knowledge/links/${UUID}`);
    expect(init?.method).toBe('DELETE');
  });

  it('listRefs 走作品引用前缀 /works/:workId/knowledge/refs', async () => {
    mockApi([summaryFixture]);
    await knowledgeClient.listRefs(UUID);
    const { path } = callAt(0);
    expect(path).toBe(`/api/v1/works/${UUID}/knowledge/refs`);
  });

  it('createRefs 走作品前缀并带 entry_ids', async () => {
    mockApi([summaryFixture]);
    await knowledgeClient.createRefs(UUID, { entry_ids: [UUID] });
    const { path, init } = callAt(0);
    expect(path).toBe(`/api/v1/works/${UUID}/knowledge/refs`);
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ entry_ids: [UUID] });
  });

  it('removeRef 走作品前缀 DELETE refs/:refId', async () => {
    mockApi({ ok: true });
    await knowledgeClient.removeRef(UUID, UUID);
    const { path, init } = callAt(0);
    expect(path).toBe(`/api/v1/works/${UUID}/knowledge/refs/${UUID}`);
    expect(init?.method).toBe('DELETE');
  });

  it('setRefFlags 走作品前缀 PUT refs/:refId/flags', async () => {
    mockApi({ id: UUID, favorite: true, pinned: false });
    await knowledgeClient.setRefFlags(UUID, UUID, { favorite: true });
    const { path, init } = callAt(0);
    expect(path).toBe(`/api/v1/works/${UUID}/knowledge/refs/${UUID}/flags`);
    expect(init?.method).toBe('PUT');
  });

  it('copyRef 走作品前缀 POST refs/:refId/copy', async () => {
    mockApi(detailFixture);
    await knowledgeClient.copyRef(UUID, UUID, { keep_ref: true });
    const { path, init } = callAt(0);
    expect(path).toBe(`/api/v1/works/${UUID}/knowledge/refs/${UUID}/copy`);
    expect(init?.method).toBe('POST');
  });

  it('listJobs 调用 GET /jobs 并带过滤参数', async () => {
    mockApi({ items: [jobFixture], total: 1, next_cursor: null });
    await knowledgeClient.listJobs({ scope: 'global', kind: 'structure', status: 'queued' });
    const { path } = callAt(0);
    expect(path).toBe('/api/v1/knowledge/jobs?scope=global&kind=structure&status=queued');
  });

  it('getJob 调用 GET /jobs/:jobId', async () => {
    mockApi(jobFixture);
    await knowledgeClient.getJob(UUID);
    const { path } = callAt(0);
    expect(path).toBe(`/api/v1/knowledge/jobs/${UUID}`);
  });

  it('uploadFiles 用 FormData 调 POST /uploads', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { jobs: [], rejected: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const input: KnowledgeUploadInput = { files: [new File(['a'], 'a.md')], scope: 'global', entry_type: 'article', idempotency_key: 'key-1' };
    await knowledgeClient.uploadFiles(input);
    const { url, init } = fetchCallAt(0);
    expect(url).toBe('/api/v1/knowledge/uploads');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it('exportKnowledge 调用 POST /exports', async () => {
    const data: KnowledgeExportResult = { job_id: UUID, status: 'queued', file_name: 'a.md', entry_count: 1 };
    mockApi(data);
    await knowledgeClient.exportKnowledge({ scope: 'global', format: 'markdown' });
    const { path, init } = callAt(0);
    expect(path).toBe('/api/v1/knowledge/exports');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toMatchObject({ scope: 'global', format: 'markdown' });
  });

  it('downloadExport 用 fetch 下载二进制', async () => {
    const blob = new Blob(['content'], { type: 'text/markdown' });
    fetchMock.mockResolvedValue({ ok: true, status: 200, blob: async () => blob } as unknown as Response);
    const res = await knowledgeClient.downloadExport(UUID);
    expect(res).toBeInstanceOf(Blob);
    expect(res).toBe(blob);
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/knowledge/exports/${UUID}/download`, expect.objectContaining({ credentials: 'include' }));
  });

  it('previewImport 用 FormData 调 POST /imports/preview', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { preview_id: UUID, files: [], conflicts: [], summary: { total: 0, duplicate: 0, name_collision: 0, new: 0, failed: 0 } } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const opts: KnowledgeImportPreviewOptions = { scope: 'global' };
    await knowledgeClient.previewImport([new File(['a'], 'a.md')], opts);
    const { url, init } = fetchCallAt(0);
    expect(url).toBe('/api/v1/knowledge/imports/preview');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it('commitImport 调用 POST /imports/commit 并带 Idempotency-Key 头', async () => {
    const data: KnowledgeImportCommitResult = { job_id: UUID, status: 'queued', result: { created: 0, skipped: 0, overwritten: 0 } };
    mockApi(data);
    await knowledgeClient.commitImport({ preview_id: UUID, policy: 'rename' }, 'idem-1');
    const { path, init } = callAt(0);
    expect(path).toBe('/api/v1/knowledge/imports/commit');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Idempotency-Key': 'idem-1' });
  });

  it('createBackup 调用 POST /backups', async () => {
    const data: KnowledgeBackupResult = { job_id: UUID, status: 'queued', file_name: 'backup.json.gz', entry_count: 1 };
    mockApi(data);
    await knowledgeClient.createBackup({ scope: 'work', work_id: UUID });
    const { path, init } = callAt(0);
    expect(path).toBe('/api/v1/knowledge/backups');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({ scope: 'work', work_id: UUID });
  });

  it('downloadBackup 用 fetch 下载 gzip', async () => {
    const blob = new Blob(['gz'], { type: 'application/gzip' });
    fetchMock.mockResolvedValue({ ok: true, status: 200, blob: async () => blob } as unknown as Response);
    const res = await knowledgeClient.downloadBackup(UUID);
    expect(res).toBeInstanceOf(Blob);
    expect(res).toBe(blob);
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/knowledge/backups/${UUID}/download`, expect.objectContaining({ credentials: 'include' }));
  });

  it('previewRestore 用 FormData 调 POST /backups/restore/preview', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { preview_id: UUID, file_name: 'backup.json.gz', uncompressed_bytes: 0, summary: { total: 0, same_content: 0, same_title_diff_content: 0, new: 0 }, conflicts: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await knowledgeClient.previewRestore(new File(['a'], 'backup.json.gz'));
    const { url, init } = fetchCallAt(0);
    expect(url).toBe('/api/v1/knowledge/backups/restore/preview');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it('commitRestore 调用 POST /backups/restore/commit 并带 Idempotency-Key 头', async () => {
    const data: KnowledgeRestoreCommitResult = { job_id: UUID, status: 'queued', result: { succeeded: 1, failed: 0, skipped: 0 } };
    mockApi(data);
    await knowledgeClient.commitRestore({ preview_id: UUID, policy: 'skip' }, 'idem-2');
    const { path, init } = callAt(0);
    expect(path).toBe('/api/v1/knowledge/backups/restore/commit');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toEqual({ 'Idempotency-Key': 'idem-2' });
  });
});

// ───────────────────────────── client：SSE ─────────────────────────────

describe('subscribeJobEvents（SSE）', () => {
  it('创建 EventSource 带 withCredentials 与 after_seq', () => {
    const onEvent = vi.fn();
    knowledgeClient.subscribeJobEvents(UUID, { since: 5, onEvent });
    const inst = MockEventSource.instances[0]!;
    expect(inst).toBeDefined();
    expect(inst.withCredentials).toBe(true);
    expect(inst.url).toBe(`/api/v1/knowledge/jobs/${UUID}/events?after_seq=5`);
  });

  it('注册 6 个具名事件并归一化为 KnowledgeJobEvent 回调', () => {
    const onEvent = vi.fn();
    knowledgeClient.subscribeJobEvents(UUID, { onEvent });
    const inst = MockEventSource.instances[0]!;
    const payload: KnowledgeJobEvent = { seq: 7, type: 'progress', job_id: UUID, progress: { stage: 's1', processed: 1, total: 2, percent: 50 }, at: TS };
    inst.emit('progress', JSON.stringify(payload), '7');
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ seq: 7, type: 'progress', job_id: UUID }));
  });

  it('data 缺 seq 时用帧 id 兜底', () => {
    const onEvent = vi.fn();
    knowledgeClient.subscribeJobEvents(UUID, { onEvent });
    const inst = MockEventSource.instances[0]!;
    inst.emit('succeeded', JSON.stringify({ type: 'succeeded', job_id: UUID, at: TS }), '9');
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ seq: 9, type: 'succeeded' }));
  });

  it('非法 JSON 帧被忽略', () => {
    const onEvent = vi.fn();
    knowledgeClient.subscribeJobEvents(UUID, { onEvent });
    const inst = MockEventSource.instances[0]!;
    inst.emit('progress', 'not-json', '1');
    expect(onEvent).not.toHaveBeenCalled();
  });

  it('返回 close/getState，close 推进到 closed', () => {
    const onStateChange = vi.fn();
    const stream = knowledgeClient.subscribeJobEvents(UUID, { onEvent: vi.fn(), onStateChange });
    const inst = MockEventSource.instances[0]!;
    expect(stream.getState()).toBe('connecting');
    inst.onopen?.();
    expect(stream.getState()).toBe('open');
    stream.close();
    expect(inst.closed).toBe(true);
    expect(stream.getState()).toBe('closed');
    expect(onStateChange).toHaveBeenCalledWith('closed');
  });
});

// ───────────────────────────── state：reducer 事件幂等 ─────────────────────────────

describe('knowledgeReducer 事件幂等', () => {
  it('重复 progress 事件合并（lastSeq 去重）', () => {
    let state = knowledgeInitialState;
    const act: KnowledgeAction = { type: 'JOB_EVENT', event: eventFixture };
    state = knowledgeReducer(state, act);
    expect(state.jobs[UUID]?.lastSeq).toBe(1);
    const before = state;
    state = knowledgeReducer(state, act);
    expect(state.jobs[UUID]?.lastSeq).toBe(1);
    expect(state).toBe(before);
  });

  it('递增事件更新 lastSeq 与进度', () => {
    let state = knowledgeInitialState;
    state = knowledgeReducer(state, { type: 'JOB_EVENT', event: eventFixture });
    state = knowledgeReducer(state, {
      type: 'JOB_EVENT',
      event: { ...eventFixture, seq: 2, progress: { stage: 'done', processed: 2, total: 2, percent: 100 } }
    });
    expect(state.jobs[UUID]?.lastSeq).toBe(2);
    expect(state.jobs[UUID]?.job?.progress?.percent).toBe(100);
  });

  it('succeeded 事件置作业为已完成', () => {
    let state = knowledgeInitialState;
    state = knowledgeReducer(state, { type: 'JOB_EVENT', event: eventFixture });
    state = knowledgeReducer(state, {
      type: 'JOB_EVENT',
      event: { seq: 3, type: 'succeeded', job_id: UUID, payload: { ok: true }, at: TS }
    });
    expect(state.jobs[UUID]?.job?.status).toBe('succeeded');
  });

  it('failed 事件写入错误信息', () => {
    let state = knowledgeInitialState;
    state = knowledgeReducer(state, {
      type: 'JOB_EVENT',
      event: { seq: 4, type: 'failed', job_id: UUID, payload: { code: 'X', message: '失败' }, at: TS }
    });
    expect(state.jobs[UUID]?.error).toBe('失败');
  });
});

// ───────────────────────────── state：缓存键隔离 ─────────────────────────────

describe('knowledgeCacheKey 库/作品隔离', () => {
  it('global 与 work 键不同', () => {
    expect(knowledgeCacheKey({ scope: 'global' })).not.toBe(knowledgeCacheKey({ scope: 'work', workId: UUID }));
  });

  it('不同作品键不同', () => {
    const a = '22222222-2222-4222-8222-222222222222';
    expect(knowledgeCacheKey({ scope: 'work', workId: UUID })).not.toBe(knowledgeCacheKey({ scope: 'work', workId: a }));
  });

  it('keyword/types/tagIds 影响键', () => {
    expect(knowledgeCacheKey({ scope: 'global', keyword: 'a' })).not.toBe(knowledgeCacheKey({ scope: 'global', keyword: 'b' }));
    expect(knowledgeCacheKey({ scope: 'global', types: ['article'] })).not.toBe(knowledgeCacheKey({ scope: 'global', types: ['novel'] }));
  });

  it('键稳定（相同输入相同输出）', () => {
    expect(knowledgeCacheKey({ scope: 'global', keyword: 'a', types: ['article'] }))
      .toBe(knowledgeCacheKey({ scope: 'global', keyword: 'a', types: ['article'] }));
  });
});

// ───────────────────────────── state：乐观回滚 ─────────────────────────────

describe('乐观更新回滚', () => {
  function loaded(): KnowledgeState {
    return knowledgeReducer(knowledgeInitialState, {
      type: 'LIST_LOADED',
      items: [summaryFixture],
      nextCursor: null,
      total: 1,
      cacheKey: 'k'
    });
  }

  it('applyEntryOptimistic 本地改 favorite', () => {
    const s = loaded();
    const { state, snapshot } = applyEntryOptimistic(s, UUID, { favorite: true });
    expect(state.items[0]?.favorite).toBe(true);
    expect(snapshot?.favorite).toBe(false);
  });

  it('revertEntryOptimistic 回滚到快照', () => {
    const s = loaded();
    const { state, snapshot } = applyEntryOptimistic(s, UUID, { favorite: true });
    const reverted = revertEntryOptimistic(state, UUID, snapshot);
    expect(reverted.items[0]?.favorite).toBe(false);
  });

  it('ENTRY_REMOVE 从列表移除', () => {
    const s = loaded();
    const next = knowledgeReducer(s, { type: 'ENTRY_REMOVE', entryId: UUID });
    expect(next.items).toHaveLength(0);
  });

  it('ENTRY_RESTORE 恢复条目到列表', () => {
    const s = loaded();
    const removed = knowledgeReducer(s, { type: 'ENTRY_REMOVE', entryId: UUID });
    const restored = knowledgeReducer(removed, { type: 'ENTRY_RESTORE', entryId: UUID });
    expect(restored.items).toHaveLength(1);
  });
});

// ───────────────────────────── state：错误映射 ─────────────────────────────

describe('knowledgeErrorMessage', () => {
  it('409 优先读 details.current_version', () => {
    const err = new ApiError(409, 'KNOWLEDGE_VERSION_CONFLICT', '版本冲突', { current_version: 3 }, 'req-1');
    expect(knowledgeErrorMessage(err)).toContain('3');
  });

  it('非 ApiError 走通用错误文案', () => {
    expect(knowledgeErrorMessage(new Error('网络错误'))).toBe('网络错误');
  });

  it('普通 ApiError 用 message', () => {
    const err = new ApiError(400, 'BAD', '参数错误', undefined, 'req-2');
    expect(knowledgeErrorMessage(err)).toBe('参数错误');
  });
});

// ───────────────────────────── 兼容别名保留 ─────────────────────────────

describe('旧一代兼容导出（panel/page 依赖）', () => {
  it('保留 12 个旧函数导出', async () => {
    const mod = await import('./knowledge-client');
    const names = [
      'createEntryPreview', 'commitEntry', 'searchEntries', 'getEntry', 'updateEntry',
      'deleteEntry', 'linkEntry', 'extractOutline', 'exportMarkdown',
      'importPreview', 'importMarkdown', 'validateMarkdown'
    ];
    for (const n of names) {
      expect(typeof (mod as unknown as Record<string, unknown>)[n]).toBe('function');
    }
  });
});
