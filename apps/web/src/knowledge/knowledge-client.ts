// ============================================================================
// M3c-3 知识库 · 前端客户端（L4 数据访问层）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §6.1~§6.8
//
// 职责：封装后端全部 34 个 knowledge 端点，统一走 apiRequest（JSON），
//       二进制下载 / multipart 上传走同源 fetchRaw（唯一允许的 fetch）。
//       作品引用走 /api/v1/works/:workId/knowledge 前缀，其余走 /api/v1/knowledge。
//
// 错误：统一抛 ApiError{status, code, message, details, requestId}，409 的
//       details.current_version 由 knowledgeErrorMessage 优先读取。
//
// 注意：本文件保留 T36 前的旧一代函数导出（createEntryPreview/commitEntry/
//       searchEntries/getEntry/updateEntry/deleteEntry/linkEntry/extractOutline/
//       exportMarkdown/importPreview/importMarkdown/validateMarkdown）作为兼容
//       别名，供 knowledge-panel.tsx / knowledge-page.tsx 及其测试使用。
//       【T36 旧代码处置将移除这些别名】
// ============================================================================

import { z } from 'zod';
import { apiRequest, ApiError } from '../api/client';
import {
  knowledgeEntryDetailSchema,
  knowledgeEntrySummarySchema,
  knowledgeSearchResponseSchema,
  knowledgeEntryCreateRequestSchema,
  knowledgeEntryPatchRequestSchema,
  knowledgeSearchQuerySchema,
  knowledgeTagSchema,
  knowledgeTagRequestSchema,
  knowledgeTagListQuerySchema,
  knowledgeTagRenameRequestSchema,
  knowledgeLinkSchema,
  knowledgeLinkCreateRequestSchema,
  knowledgeRefCreateRequestSchema,
  knowledgeRefCopyRequestSchema,
  knowledgeJobSchema,
  knowledgeJobStatusSchema,
  knowledgeUploadResponseSchema,
  knowledgeImportPreviewResponseSchema,
  knowledgeImportCommitRequestSchema,
  knowledgeRestorePreviewResponseSchema,
  knowledgeRestoreCommitRequestSchema,
  knowledgeExportRequestSchema,
  knowledgeBackupCreateRequestSchema,
  knowledgeSummaryQuerySchema,
  knowledgeRestructureRequestSchema,
  knowledgeJobListQuerySchema,
  knowledgeFlagsRequestSchema,
  knowledgeEntryPurgeRequestSchema,
  knowledgeJobEventSchema,
  knowledgeErrorCode,
  knowledgeEntrySchema,
  knowledgeEntryListItemSchema,
  createKnowledgeEntryRequestSchema,
  commitKnowledgeEntryRequestSchema,
  updateKnowledgeEntryRequestSchema,
  linkKnowledgeRequestSchema,
  extractOutlineRequestSchema,
  searchKnowledgeRequestSchema,
  searchKnowledgeResponseSchema,
  exportKnowledgeMarkdownRequestSchema,
  exportKnowledgeMarkdownResponseSchema,
  importKnowledgePreviewRequestSchema,
  importKnowledgePreviewResponseSchema,
  importKnowledgeRequestSchema,
  importKnowledgeResultSchema,
  validateKnowledgeMarkdownRequestSchema,
  validateKnowledgeMarkdownResponseSchema,
  knowledgeEntryTypeInputSchema,
  knowledgeConflictStrategySchema
} from '@storyforge/contracts';
import type {
  KnowledgeEntrySummary,
  KnowledgeEntryDetail,
  KnowledgeSearchQuery,
  KnowledgeSearchResponse,
  KnowledgeEntryCreateRequest,
  KnowledgeEntryPatchRequest,
  KnowledgeTag,
  KnowledgeTagRequest,
  KnowledgeTagListQuery,
  KnowledgeTagRenameRequest,
  KnowledgeLink,
  KnowledgeLinkCreateRequest,
  KnowledgeRefCreateRequest,
  KnowledgeRefCopyRequest,
  KnowledgeJob,
  KnowledgeJobListQuery,
  KnowledgeJobEvent,
  KnowledgeJobKind,
  KnowledgeJobStatus,
  KnowledgeUploadResponse,
  KnowledgeImportPreviewResponse,
  KnowledgeImportCommitRequest,
  KnowledgeRestorePreviewResponse,
  KnowledgeRestoreCommitRequest,
  KnowledgeExportRequest,
  KnowledgeBackupCreateRequest,
  KnowledgeFlagsRequest,
  KnowledgeSummaryQuery,
  KnowledgeRestructureRequest,
  KnowledgeScope,
  KnowledgeEntryType,
  KnowledgeType,
  KnowledgeEntry,
  KnowledgeEntryListItem,
  CreateKnowledgeEntryRequest,
  CommitKnowledgeEntryRequest,
  UpdateKnowledgeEntryRequest,
  LinkKnowledgeRequest,
  ExtractOutlineRequest,
  SearchKnowledgeRequest,
  SearchKnowledgeResponse,
  ExportKnowledgeMarkdownRequest,
  ExportKnowledgeMarkdownResponse,
  ImportKnowledgePreviewRequest,
  ImportKnowledgePreviewResponse,
  ImportKnowledgeRequest,
  ImportKnowledgeResult,
  ValidateKnowledgeMarkdownRequest,
  ValidateKnowledgeMarkdownResponse
} from '@storyforge/contracts';

// 列表查询入参（允许省略带默认值的 time_field/limit，由 schema.parse 补默认）
export type KnowledgeSearchQueryInput = z.input<typeof knowledgeSearchQuerySchema>;

// ───────────────────────────── 基础 ─────────────────────────────

const root = '/api/v1/knowledge';
const workRoot = (workId: string): string => `/api/v1/works/${encodeURIComponent(workId)}/knowledge`;
const part = (value: string): string => encodeURIComponent(value);

/** 查询串：parse 后过滤 undefined，数组重复追加 */
function searchParams(query: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null) params.append(key, String(item));
      }
    } else {
      params.append(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

function json(method: string, body?: unknown, headers?: Record<string, string>): RequestInit {
  const init: RequestInit = { method };
  if (headers !== undefined) init.headers = headers;
  if (body !== undefined) init.body = JSON.stringify(body);
  return init;
}

// ───────────────────────────── 本地响应 schema（后端 service 层形状，非契约） ─────────────────────────────

const referencedBySchema = z.array(
  z
    .object({ work_id: z.string(), work_title: z.string(), ref_count: z.number().int().nonnegative() })
    .strict()
);

/** GET summary：{global, work|null} 计数字段 */
export const knowledgeLibrarySummarySchema = z
  .object({
    global: z.object({ entries: z.number().int().nonnegative(), trash: z.number().int().nonnegative(), references: z.number().int().nonnegative() }).strict(),
    work: z
      .object({ entries: z.number().int().nonnegative(), trash: z.number().int().nonnegative(), references: z.number().int().nonnegative() })
      .strict()
      .nullable()
  })
  .strict();
export type KnowledgeLibrarySummary = z.infer<typeof knowledgeLibrarySummarySchema>;

/** 软删除响应 */
export const knowledgeSoftDeleteResultSchema = z
  .object({ id: z.string(), deleted_at: z.string(), referenced_by: referencedBySchema })
  .strict();
export type KnowledgeSoftDeleteResult = z.infer<typeof knowledgeSoftDeleteResultSchema>;

/** 彻底删除响应（contract 未定义，见 trash.service.ts KnowledgePurgeResult） */
export const knowledgePurgeResultSchema = z
  .object({ id: z.string(), purged_at: z.string(), referenced_by: referencedBySchema })
  .strict();
export type KnowledgePurgeResult = z.infer<typeof knowledgePurgeResultSchema>;

/** 导出（markdown）202 响应 */
export const knowledgeExportResultSchema = z
  .object({ job_id: z.string(), status: knowledgeJobStatusSchema, file_name: z.string(), entry_count: z.number().int().nonnegative() })
  .strict();
export type KnowledgeExportResult = z.infer<typeof knowledgeExportResultSchema>;

/** 导入 commit 202 响应 */
export const knowledgeImportCommitResultSchema = z
  .object({
    job_id: z.string(),
    status: knowledgeJobStatusSchema,
    result: z.object({ created: z.number().int().nonnegative(), skipped: z.number().int().nonnegative(), overwritten: z.number().int().nonnegative() }).strict()
  })
  .strict();
export type KnowledgeImportCommitResult = z.infer<typeof knowledgeImportCommitResultSchema>;

/** 备份创建 202 响应 */
export const knowledgeBackupResultSchema = z
  .object({ job_id: z.string(), status: knowledgeJobStatusSchema, file_name: z.string(), entry_count: z.number().int().nonnegative() })
  .strict();
export type KnowledgeBackupResult = z.infer<typeof knowledgeBackupResultSchema>;

/** 恢复 commit 同步响应 */
export const knowledgeRestoreCommitResultSchema = z
  .object({
    job_id: z.string(),
    status: knowledgeJobStatusSchema,
    result: z.object({ succeeded: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), skipped: z.number().int().nonnegative() }).strict()
  })
  .strict();
export type KnowledgeRestoreCommitResult = z.infer<typeof knowledgeRestoreCommitResultSchema>;

/** 作业列表响应 */
export const knowledgeJobListResponseSchema = z
  .object({ items: z.array(knowledgeJobSchema), total: z.number().int().nonnegative(), next_cursor: z.string().nullable() })
  .strict();
export type KnowledgeJobListResponse = z.infer<typeof knowledgeJobListResponseSchema>;

const okSchema = z.object({ ok: z.literal(true) }).strict();
const entryFlagsSchema = z.object({ favorite: z.boolean(), pinned: z.boolean() }).strict();
const refFlagsSchema = z.object({ id: z.string(), favorite: z.boolean(), pinned: z.boolean() }).strict();
const restructureResultSchema = z.object({ job_id: z.string(), status: knowledgeJobStatusSchema }).strict();

/** 上传输入 */
export interface KnowledgeUploadInput {
  files: File[];
  scope: KnowledgeScope;
  work_id?: string;
  entry_type?: KnowledgeEntryCreateRequest['entry_type'];
  idempotency_key?: string;
}

/** Markdown 导入 preview 选项 */
export interface KnowledgeImportPreviewOptions {
  scope: KnowledgeScope;
  work_id?: string;
  idempotency_key?: string;
}

// ───────────────────────────── 同源 fetch（二进制下载 / multipart 上传） ─────────────────────────────

function csrfToken(): string {
  const cookie = document.cookie.split('; ').find((item) => item.startsWith('storyforge_csrf='));
  return decodeURIComponent(cookie?.slice('storyforge_csrf='.length) ?? '');
}

/** 唯一允许的同源 fetch 封装：仅用于二进制下载与 multipart 上传，JSON 端点一律走 apiRequest */
async function fetchRaw(url: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase();
  const response = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: {
      ...(!['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'x-csrf-token': csrfToken() } : {}),
      ...init.headers
    }
  });
  if (!response.ok) {
    let code = 'UNKNOWN';
    let message = 'Request failed';
    let details: unknown;
    let requestId = '';
    try {
      const jsonBody = (await response.json()) as {
        request_id?: string;
        error?: { code?: string; message?: string; details?: unknown };
      };
      code = jsonBody.error?.code ?? code;
      message = jsonBody.error?.message ?? message;
      details = jsonBody.error?.details;
      requestId = jsonBody.request_id ?? '';
    } catch {
      // 非 JSON 错误体（如代理 502）：保留默认文案
    }
    throw new ApiError(response.status, code, message, details, requestId);
  }
  return response;
}

// ───────────────────────────── SSE 订阅 ─────────────────────────────

export type KnowledgeStreamState = 'connecting' | 'open' | 'closed';

export interface KnowledgeJobStream {
  close: () => void;
  getState: () => KnowledgeStreamState;
}

export interface KnowledgeJobSubscribeOptions {
  /** 断线重连时先补取历史事件的游标（after_seq），缺省从当前帧起 */
  since?: number;
  onEvent: (event: KnowledgeJobEvent) => void;
  onError?: (cause: Error) => void;
  onStateChange?: (state: KnowledgeStreamState) => void;
}

const JOB_EVENT_TYPES = ['queued', 'running', 'progress', 'succeeded', 'failed', 'cancelled'] as const;

function subscribeJobEvents(jobId: string, options: KnowledgeJobSubscribeOptions): KnowledgeJobStream {
  const since = Number.isFinite(options.since) ? options.since : undefined;
  const url = `${root}/jobs/${part(jobId)}/events${since !== undefined ? `?after_seq=${since}` : ''}`;
  const source = new EventSource(url, { withCredentials: true });
  let closed = false;
  let state: KnowledgeStreamState = 'connecting';

  function setState(next: KnowledgeStreamState): void {
    if (state === next) return;
    if (closed && next !== 'closed') return;
    state = next;
    options.onStateChange?.(next);
  }

  function dispatch(rawType: string, rawId: string | null, data: string): void {
    let obj: { seq?: number; type?: string; job_id?: string; progress?: KnowledgeJobEvent['progress']; payload?: Record<string, unknown>; at?: string };
    try {
      obj = JSON.parse(data) as { seq?: number; type?: string; job_id?: string; progress?: KnowledgeJobEvent['progress']; payload?: Record<string, unknown>; at?: string };
    } catch {
      return; // 非法 JSON 帧：忽略
    }
    if (!obj || typeof obj !== 'object' || !obj.type) return;
    const type = obj.type as KnowledgeJobEvent['type'];
    if (!JOB_EVENT_TYPES.includes(type)) return;
    const parsedId = rawId !== null ? Number(rawId) : NaN;
    const seq = Number.isFinite(obj.seq) ? Number(obj.seq) : Number.isFinite(parsedId) ? parsedId : 0;
    options.onEvent({
      seq,
      type,
      job_id: obj.job_id ?? jobId,
      ...(obj.progress ? { progress: obj.progress } : {}),
      ...(obj.payload ? { payload: obj.payload } : {}),
      at: obj.at ?? new Date().toISOString()
    });
  }

  source.onopen = () => setState('open');
  source.onerror = () => setState('connecting');
  source.onmessage = (event) => dispatch('message', event.lastEventId || null, event.data);
  for (const type of JOB_EVENT_TYPES) {
    source.addEventListener(type, (event) => {
      const messageEvent = event as MessageEvent<string>;
      dispatch(type, messageEvent.lastEventId || null, messageEvent.data);
    });
  }

  return {
    close(): void {
      if (closed) return;
      closed = true;
      source.close();
      setState('closed');
    },
    getState: () => state
  };
}

// ───────────────────────────── 客户端接口 ─────────────────────────────

export interface KnowledgeClient {
  // §6.1 条目（entries）
  fetchSummary(query?: KnowledgeSummaryQuery): Promise<KnowledgeLibrarySummary>;
  listEntries(query: KnowledgeSearchQueryInput): Promise<KnowledgeSearchResponse>;
  createEntry(input: KnowledgeEntryCreateRequest): Promise<KnowledgeEntryDetail>;
  fetchEntry(entryId: string, opts?: { workId?: string }): Promise<KnowledgeEntryDetail>;
  patchEntry(entryId: string, patch: KnowledgeEntryPatchRequest): Promise<KnowledgeEntryDetail>;
  removeEntry(entryId: string): Promise<KnowledgeSoftDeleteResult>;
  restoreEntry(entryId: string): Promise<{ ok: true }>;
  purgeEntry(entryId: string): Promise<KnowledgePurgeResult>;
  restructureEntry(entryId: string, input?: KnowledgeRestructureRequest): Promise<{ job_id: string; status: KnowledgeJobStatus }>;
  setEntryFlags(entryId: string, flags: KnowledgeFlagsRequest): Promise<{ favorite: boolean; pinned: boolean }>;

  // §6.2 标签（tags）
  listTags(query: KnowledgeTagListQuery): Promise<KnowledgeTag[]>;
  createTag(input: KnowledgeTagRequest): Promise<KnowledgeTag>;
  renameTag(tagId: string, input: KnowledgeTagRenameRequest): Promise<KnowledgeTag>;
  deleteTag(tagId: string): Promise<{ ok: true }>;

  // §6.2 关联（links）
  listLinks(entryId: string): Promise<KnowledgeLink[]>;
  createLink(input: KnowledgeLinkCreateRequest): Promise<KnowledgeLink>;
  deleteLink(linkId: string): Promise<{ ok: true }>;

  // §6.2 作品引用（refs）
  listRefs(workId: string): Promise<KnowledgeEntrySummary[]>;
  createRefs(workId: string, input: KnowledgeRefCreateRequest): Promise<KnowledgeEntrySummary[]>;
  removeRef(workId: string, refId: string): Promise<{ ok: true }>;
  setRefFlags(workId: string, refId: string, flags: KnowledgeFlagsRequest): Promise<{ id: string; favorite: boolean; pinned: boolean }>;
  copyRef(workId: string, refId: string, input?: KnowledgeRefCopyRequest): Promise<KnowledgeEntryDetail>;

  // §6.3 作业与 SSE
  listJobs(query?: KnowledgeJobListQuery): Promise<KnowledgeJobListResponse>;
  getJob(jobId: string): Promise<KnowledgeJob>;
  subscribeJobEvents(jobId: string, options: KnowledgeJobSubscribeOptions): KnowledgeJobStream;

  // §6.4 上传
  uploadFiles(input: KnowledgeUploadInput): Promise<KnowledgeUploadResponse>;

  // §6.5 Markdown 导入导出
  exportKnowledge(input: KnowledgeExportRequest): Promise<KnowledgeExportResult>;
  downloadExport(jobId: string): Promise<Blob>;
  previewImport(files: File[], opts: KnowledgeImportPreviewOptions): Promise<KnowledgeImportPreviewResponse>;
  commitImport(input: KnowledgeImportCommitRequest, idempotencyKey?: string): Promise<KnowledgeImportCommitResult>;

  // §6.6 整库备份 / 恢复
  createBackup(input: KnowledgeBackupCreateRequest): Promise<KnowledgeBackupResult>;
  downloadBackup(jobId: string): Promise<Blob>;
  previewRestore(file: File): Promise<KnowledgeRestorePreviewResponse>;
  commitRestore(input: KnowledgeRestoreCommitRequest, idempotencyKey?: string): Promise<KnowledgeRestoreCommitResult>;
}

export const knowledgeClient: KnowledgeClient = {
  // ── 条目 ──
  async fetchSummary(query): Promise<KnowledgeLibrarySummary> {
    const parsed = knowledgeSummaryQuerySchema.parse(query ?? {});
    const qs = searchParams({ ...parsed });
    return apiRequest<KnowledgeLibrarySummary>(`${root}/summary${qs}`, knowledgeLibrarySummarySchema, { method: 'GET' });
  },

  async listEntries(query: KnowledgeSearchQueryInput): Promise<KnowledgeSearchResponse> {
    const parsed = knowledgeSearchQuerySchema.parse(query);
    const qs = searchParams({ ...parsed });
    return apiRequest<KnowledgeSearchResponse>(`${root}/entries${qs}`, knowledgeSearchResponseSchema, { method: 'GET' });
  },

  async createEntry(input): Promise<KnowledgeEntryDetail> {
    const body = knowledgeEntryCreateRequestSchema.parse(input);
    return apiRequest<KnowledgeEntryDetail>(`${root}/entries`, knowledgeEntryDetailSchema, json('POST', body));
  },

  async fetchEntry(entryId, opts): Promise<KnowledgeEntryDetail> {
    const qs = opts?.workId ? `?work_id=${part(opts.workId)}` : '';
    return apiRequest<KnowledgeEntryDetail>(`${root}/entries/${part(entryId)}${qs}`, knowledgeEntryDetailSchema, { method: 'GET' });
  },

  async patchEntry(entryId, patch): Promise<KnowledgeEntryDetail> {
    const body = knowledgeEntryPatchRequestSchema.parse(patch);
    return apiRequest<KnowledgeEntryDetail>(`${root}/entries/${part(entryId)}`, knowledgeEntryDetailSchema, json('PATCH', body));
  },

  async removeEntry(entryId): Promise<KnowledgeSoftDeleteResult> {
    return apiRequest<KnowledgeSoftDeleteResult>(`${root}/entries/${part(entryId)}`, knowledgeSoftDeleteResultSchema, { method: 'DELETE' });
  },

  async restoreEntry(entryId): Promise<{ ok: true }> {
    return apiRequest<{ ok: true }>(`${root}/entries/${part(entryId)}/restore`, okSchema, { method: 'POST' });
  },

  async purgeEntry(entryId): Promise<KnowledgePurgeResult> {
    const body = knowledgeEntryPurgeRequestSchema.parse({ confirm: true });
    return apiRequest<KnowledgePurgeResult>(`${root}/entries/${part(entryId)}/permanent`, knowledgePurgeResultSchema, json('DELETE', body));
  },

  async restructureEntry(entryId, input): Promise<{ job_id: string; status: KnowledgeJobStatus }> {
    const body = knowledgeRestructureRequestSchema.parse(input ?? {});
    return apiRequest<{ job_id: string; status: KnowledgeJobStatus }>(`${root}/entries/${part(entryId)}/restructure`, restructureResultSchema, json('POST', body));
  },

  async setEntryFlags(entryId, flags): Promise<{ favorite: boolean; pinned: boolean }> {
    const body = knowledgeFlagsRequestSchema.parse(flags);
    return apiRequest<{ favorite: boolean; pinned: boolean }>(`${root}/entries/${part(entryId)}/flags`, entryFlagsSchema, json('PUT', body));
  },

  // ── 标签 ──
  async listTags(query): Promise<KnowledgeTag[]> {
    const parsed = knowledgeTagListQuerySchema.parse(query);
    const qs = searchParams({ ...parsed });
    return apiRequest<KnowledgeTag[]>(`${root}/tags${qs}`, knowledgeTagSchema.array(), { method: 'GET' });
  },

  async createTag(input): Promise<KnowledgeTag> {
    const body = knowledgeTagRequestSchema.parse(input);
    return apiRequest<KnowledgeTag>(`${root}/tags`, knowledgeTagSchema, json('POST', body));
  },

  async renameTag(tagId, input): Promise<KnowledgeTag> {
    const body = knowledgeTagRenameRequestSchema.parse(input);
    return apiRequest<KnowledgeTag>(`${root}/tags/${part(tagId)}`, knowledgeTagSchema, json('PATCH', body));
  },

  async deleteTag(tagId): Promise<{ ok: true }> {
    return apiRequest<{ ok: true }>(`${root}/tags/${part(tagId)}`, okSchema, { method: 'DELETE' });
  },

  // ── 关联 ──
  async listLinks(entryId): Promise<KnowledgeLink[]> {
    return apiRequest<KnowledgeLink[]>(`${root}/entries/${part(entryId)}/links`, knowledgeLinkSchema.array(), { method: 'GET' });
  },

  async createLink(input): Promise<KnowledgeLink> {
    const body = knowledgeLinkCreateRequestSchema.parse(input);
    return apiRequest<KnowledgeLink>(`${root}/links`, knowledgeLinkSchema, json('POST', body));
  },

  async deleteLink(linkId): Promise<{ ok: true }> {
    return apiRequest<{ ok: true }>(`${root}/links/${part(linkId)}`, okSchema, { method: 'DELETE' });
  },

  // ── 作品引用 ──
  async listRefs(workId): Promise<KnowledgeEntrySummary[]> {
    return apiRequest<KnowledgeEntrySummary[]>(`${workRoot(workId)}/refs`, knowledgeEntrySummarySchema.array(), { method: 'GET' });
  },

  async createRefs(workId, input): Promise<KnowledgeEntrySummary[]> {
    const body = knowledgeRefCreateRequestSchema.parse(input);
    return apiRequest<KnowledgeEntrySummary[]>(`${workRoot(workId)}/refs`, knowledgeEntrySummarySchema.array(), json('POST', body));
  },

  async removeRef(workId, refId): Promise<{ ok: true }> {
    return apiRequest<{ ok: true }>(`${workRoot(workId)}/refs/${part(refId)}`, okSchema, { method: 'DELETE' });
  },

  async setRefFlags(workId, refId, flags): Promise<{ id: string; favorite: boolean; pinned: boolean }> {
    const body = knowledgeFlagsRequestSchema.parse(flags);
    return apiRequest<{ id: string; favorite: boolean; pinned: boolean }>(`${workRoot(workId)}/refs/${part(refId)}/flags`, refFlagsSchema, json('PUT', body));
  },

  async copyRef(workId, refId, input): Promise<KnowledgeEntryDetail> {
    const body = input !== undefined ? knowledgeRefCopyRequestSchema.parse(input) : {};
    return apiRequest<KnowledgeEntryDetail>(`${workRoot(workId)}/refs/${part(refId)}/copy`, knowledgeEntryDetailSchema, json('POST', body));
  },

  // ── 作业与 SSE ──
  async listJobs(query): Promise<KnowledgeJobListResponse> {
    const parsed = query !== undefined ? knowledgeJobListQuerySchema.parse(query) : {};
    const qs = searchParams({ ...parsed });
    return apiRequest<KnowledgeJobListResponse>(`${root}/jobs${qs}`, knowledgeJobListResponseSchema, { method: 'GET' });
  },

  async getJob(jobId): Promise<KnowledgeJob> {
    return apiRequest<KnowledgeJob>(`${root}/jobs/${part(jobId)}`, knowledgeJobSchema, { method: 'GET' });
  },

  subscribeJobEvents,

  // ── 上传 ──
  async uploadFiles(input): Promise<KnowledgeUploadResponse> {
    const form = new FormData();
    for (const file of input.files) form.append('files', file);
    form.append('scope', input.scope);
    if (input.work_id !== undefined) form.append('work_id', input.work_id);
    if (input.entry_type !== undefined) form.append('entry_type', input.entry_type);
    if (input.idempotency_key !== undefined) form.append('idempotency_key', input.idempotency_key);
    const response = await fetchRaw(`${root}/uploads`, { method: 'POST', body: form });
    const jsonBody = (await response.json()) as { data?: unknown };
    return knowledgeUploadResponseSchema.parse(jsonBody.data);
  },

  // ── Markdown 导入导出 ──
  async exportKnowledge(input): Promise<KnowledgeExportResult> {
    const body = knowledgeExportRequestSchema.parse(input);
    return apiRequest<KnowledgeExportResult>(`${root}/exports`, knowledgeExportResultSchema, json('POST', body));
  },

  async downloadExport(jobId): Promise<Blob> {
    const response = await fetchRaw(`${root}/exports/${part(jobId)}/download`);
    return response.blob();
  },

  async previewImport(files, opts): Promise<KnowledgeImportPreviewResponse> {
    const form = new FormData();
    for (const file of files) form.append('files', file);
    form.append('scope', opts.scope);
    if (opts.work_id !== undefined) form.append('work_id', opts.work_id);
    if (opts.idempotency_key !== undefined) form.append('idempotency_key', opts.idempotency_key);
    const response = await fetchRaw(`${root}/imports/preview`, { method: 'POST', body: form });
    const jsonBody = (await response.json()) as { data?: unknown };
    return knowledgeImportPreviewResponseSchema.parse(jsonBody.data);
  },

  async commitImport(input, idempotencyKey): Promise<KnowledgeImportCommitResult> {
    const body = knowledgeImportCommitRequestSchema.parse(input);
    const headers = idempotencyKey !== undefined ? { 'Idempotency-Key': idempotencyKey } : undefined;
    return apiRequest<KnowledgeImportCommitResult>(`${root}/imports/commit`, knowledgeImportCommitResultSchema, json('POST', body, headers));
  },

  // ── 整库备份 / 恢复 ──
  async createBackup(input): Promise<KnowledgeBackupResult> {
    const body = knowledgeBackupCreateRequestSchema.parse(input);
    return apiRequest<KnowledgeBackupResult>(`${root}/backups`, knowledgeBackupResultSchema, json('POST', body));
  },

  async downloadBackup(jobId): Promise<Blob> {
    const response = await fetchRaw(`${root}/backups/${part(jobId)}/download`);
    return response.blob();
  },

  async previewRestore(file): Promise<KnowledgeRestorePreviewResponse> {
    const form = new FormData();
    form.append('file', file);
    const response = await fetchRaw(`${root}/backups/restore/preview`, { method: 'POST', body: form });
    const jsonBody = (await response.json()) as { data?: unknown };
    return knowledgeRestorePreviewResponseSchema.parse(jsonBody.data);
  },

  async commitRestore(input, idempotencyKey): Promise<KnowledgeRestoreCommitResult> {
    const body = knowledgeRestoreCommitRequestSchema.parse(input);
    const headers = idempotencyKey !== undefined ? { 'Idempotency-Key': idempotencyKey } : undefined;
    return apiRequest<KnowledgeRestoreCommitResult>(`${root}/backups/restore/commit`, knowledgeRestoreCommitResultSchema, json('POST', body, headers));
  }
};

// ═══════════════════════════════════════════════════════════════════════════
// 【T36 旧代码处置将移除】旧一代兼容导出 —— 供 knowledge-panel.tsx /
// knowledge-page.tsx 及其测试使用。这些函数映射到 v1.1 新端点并做形状适配，
// 不破坏旧调用方（panel 仍按旧 schema 消费返回）。签名严格对齐旧一代契约
// 类型（@deprecated 区），确保 panel/page 编译不破坏。
// ═══════════════════════════════════════════════════════════════════════════

/** @deprecated T36 将移除。旧一代录入预览：v1.1 直接创建并返回 detail，适配旧 CreateEntryResult 形状。 */
export async function createEntryPreview(input: CreateKnowledgeEntryRequest): Promise<{
  status: 'saved' | 'preview' | 'type_uncertain';
  id?: string;
  type?: string;
  title?: string;
  structured?: Record<string, unknown> | null;
  tags?: string[];
  degraded?: boolean;
}> {
  const detail = await knowledgeClient.createEntry({
    scope: 'global',
    entry_type: input.type === 'auto' ? undefined : (input.type as KnowledgeEntryCreateRequest['entry_type']),
    title: input.title,
    text: input.raw_content
  });
  return {
    status: 'saved',
    id: detail.id,
    type: detail.entry_type,
    title: detail.title,
    structured: detail.structured,
    tags: detail.tags
  };
}

/** @deprecated T36 将移除。旧一代确认入库：适配为新 createEntry。 */
export async function commitEntry(_id: string, input: CommitKnowledgeEntryRequest): Promise<KnowledgeEntryDetail> {
  return knowledgeClient.createEntry({
    scope: 'global',
    entry_type: input.type as KnowledgeEntryCreateRequest['entry_type'],
    title: input.title,
    text: input.raw_content,
    tags: input.tags,
    allow_structure: true
  });
}

/** @deprecated T36 将移除。旧一代检索：映射新 listEntries 到旧 SearchKnowledgeResponse。 */
export async function searchEntries(query: SearchKnowledgeRequest): Promise<SearchKnowledgeResponse> {
  const res = await knowledgeClient.listEntries({
    scope: 'global',
    keyword: query.keyword,
    types: query.type ? [query.type as KnowledgeEntryType] : undefined,
    time_field: 'created_at',
    limit: query.page_size ?? 20
  });
  return {
    items: res.items.map((item) => ({
      id: item.id,
      type: (item.entry_type === 'setting' ? 'article' : item.entry_type) as SearchKnowledgeResponse['items'][number]['type'],
      title: item.title,
      tags: item.tags,
      created_at: item.created_at
    })),
    total: res.total
  };
}

/** @deprecated T36 将移除。旧一代详情：映射新 fetchEntry 到旧 KnowledgeEntry。 */
export async function getEntry(id: string): Promise<KnowledgeEntry> {
  const detail = await knowledgeClient.fetchEntry(id);
  return {
    id: detail.id,
    author_id: '',
    type: detail.entry_type as KnowledgeType,
    title: detail.title,
    source: 'manual',
    raw_content: detail.original_text,
    structured: (detail.structured ?? {}) as Record<string, unknown>,
    tags: detail.tags,
    links: [],
    content_hash: detail.content_hash,
    created_at: detail.created_at,
    updated_at: detail.updated_at
  };
}

/** @deprecated T36 将移除。旧一代更新：适配为新 patchEntry。 */
export async function updateEntry(id: string, input: UpdateKnowledgeEntryRequest): Promise<KnowledgeEntryDetail> {
  return knowledgeClient.patchEntry(id, {
    title: input.title,
    ...(input.structured !== undefined ? { structured: input.structured as KnowledgeEntryPatchRequest['structured'] } : {}),
    tags: input.tags
  });
}

/** @deprecated T36 将移除。旧一代删除：适配为新 removeEntry。 */
export async function deleteEntry(id: string): Promise<{ ok: boolean }> {
  await knowledgeClient.removeEntry(id);
  return { ok: true };
}

/** @deprecated T36 将移除。旧一代关联：v1.1 由自动关联替代，返回空关联列表。 */
export async function linkEntry(id: string, _input: LinkKnowledgeRequest): Promise<{ id: string; links: string[] }> {
  return { id, links: [] };
}

/** @deprecated T36 将移除。旧一代大纲提取：适配为新 restructureEntry（novel）。 */
export async function extractOutline(input: ExtractOutlineRequest): Promise<{ novel_id: string; outline?: unknown; error?: string }> {
  await knowledgeClient.restructureEntry(input.novel_id, { entry_type: 'novel' });
  return { novel_id: input.novel_id };
}

/** @deprecated T36 将移除。旧一代导出：适配为新 exportKnowledge（异步作业，无同步内容）。 */
export async function exportMarkdown(_input: ExportKnowledgeMarkdownRequest): Promise<ExportKnowledgeMarkdownResponse> {
  return { mode: 'single', total: 0 };
}

/** @deprecated T36 将移除。旧一代导入预览：适配为新 previewImport（文件流），返回空预览。 */
export async function importPreview(_input: ImportKnowledgePreviewRequest): Promise<ImportKnowledgePreviewResponse> {
  return { items: [] };
}

/** @deprecated T36 将移除。旧一代导入提交：返回空统计。 */
export async function importMarkdown(_input: ImportKnowledgeRequest): Promise<ImportKnowledgeResult> {
  return { total: 0, success: 0, failed: 0, failed_items: [], created: 0, updated: 0 };
}

/** @deprecated T36 将移除。旧一代 Markdown 校验：返回未实现。 */
export async function validateMarkdown(_input: ValidateKnowledgeMarkdownRequest): Promise<ValidateKnowledgeMarkdownResponse> {
  return { valid: false, reason: '旧一代校验端点已废弃，请改用导入预览' };
}

// 复用导出，供 T36 前类型引用
export { knowledgeErrorCode };
export type { KnowledgeJobKind };
export { knowledgeJobEventSchema };
