import { z } from 'zod';
import {
  knowledgeConflictPolicySchema,
  knowledgeEntryTypeSchema,
  knowledgeScopeSchema
} from './knowledge';

// ============================================================================
// M3c-3 知识库作业与 SSE 事件契约（F2 §3.1~§3.4、§4.5、§4.6）
//
// 作业：ingest | structure | outline | export_markdown | export_backup |
//       import_markdown | restore_backup
// 状态：queued | running | succeeded | failed | cancelled
// SSE 事件 type：queued | running | progress | succeeded | failed | cancelled
// 断线重放：`Last-Event-ID` 与 `?after_seq=`
// ============================================================================

const id = z.string().uuid();
const timestamp = z.string().datetime();

export const KNOWLEDGE_JOB_ENTRY_IDS_MAX = 200; // 导出 entry_ids 上限
export const KNOWLEDGE_JOB_FILE_COUNT_MAX = 10; // 单次上传 / 导入文件数上限

// ───────────────────────────── 作业枚举（§3.2） ─────────────────────────────

export const knowledgeJobKindSchema = z.enum([
  'ingest',
  'structure',
  'outline',
  'export_markdown',
  'export_backup',
  'import_markdown',
  'restore_backup'
]);
export type KnowledgeJobKind = z.infer<typeof knowledgeJobKindSchema>;

export const knowledgeJobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type KnowledgeJobStatus = z.infer<typeof knowledgeJobStatusSchema>;

// ───────────────────────────── 进度（§3.3） ─────────────────────────────

export const knowledgeJobProgressSchema = z
  .object({
    stage: z.string().trim().min(1).max(100),
    processed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    percent: z.number().int().min(0).max(100)
  })
  .strict();
export type KnowledgeJobProgress = z.infer<typeof knowledgeJobProgressSchema>;

// ───────────────────────────── 作业实体（§3.3） ─────────────────────────────

export const knowledgeJobSchema = z
  .object({
    id,
    kind: knowledgeJobKindSchema,
    status: knowledgeJobStatusSchema,
    library_scope: knowledgeScopeSchema,
    work_id: id.optional(),
    entry_id: id.optional(),
    progress: knowledgeJobProgressSchema,
    result: z.record(z.unknown()),
    error: z
      .object({
        code: z.string().trim().min(1).max(128),
        message: z.string().max(500),
        reason: z.string().max(200).optional()
      })
      .strict()
      .nullable(),
    created_at: timestamp,
    finished_at: timestamp.nullable()
  })
  .strict();
export type KnowledgeJob = z.infer<typeof knowledgeJobSchema>;

// ───────────────────────────── SSE 事件（§4.5） ─────────────────────────────

export const knowledgeJobEventTypeSchema = z.enum([
  'queued',
  'running',
  'progress',
  'succeeded',
  'failed',
  'cancelled'
]);
export type KnowledgeJobEventType = z.infer<typeof knowledgeJobEventTypeSchema>;

// 断线重放查询参数：`?after_seq=<number>`（`Last-Event-ID` 头等价）
export const knowledgeJobReplayQuerySchema = z
  .object({
    after_seq: z.coerce.number().int().nonnegative().optional()
  })
  .strict();
export type KnowledgeJobReplayQuery = z.infer<typeof knowledgeJobReplayQuerySchema>;

// SSE 事件负载：seq 为单调递增序列号（供 Last-Event-ID / after_seq 重放）
export const knowledgeJobEventSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    type: knowledgeJobEventTypeSchema,
    job_id: id,
    progress: knowledgeJobProgressSchema.optional(),
    payload: z.record(z.unknown()).optional(),
    at: timestamp
  })
  .strict();
export type KnowledgeJobEvent = z.infer<typeof knowledgeJobEventSchema>;

// ───────────────────────────── 上传响应（§4.5） ─────────────────────────────

export const knowledgeUploadJobItemSchema = z
  .object({
    job_id: id,
    file_name: z.string().trim().min(1).max(255),
    status: knowledgeJobStatusSchema
  })
  .strict();
export type KnowledgeUploadJobItem = z.infer<typeof knowledgeUploadJobItemSchema>;

export const knowledgeUploadRejectedItemSchema = z
  .object({
    file_name: z.string().trim().min(1).max(255),
    code: z.string().trim().min(1).max(128),
    message: z.string().max(500)
  })
  .strict();
export type KnowledgeUploadRejectedItem = z.infer<typeof knowledgeUploadRejectedItemSchema>;

export const knowledgeUploadResponseSchema = z
  .object({
    jobs: z.array(knowledgeUploadJobItemSchema),
    rejected: z.array(knowledgeUploadRejectedItemSchema)
  })
  .strict();
export type KnowledgeUploadResponse = z.infer<typeof knowledgeUploadResponseSchema>;

// ───────────────────────────── 导出请求（§4.6） ─────────────────────────────

export const knowledgeExportRequestSchema = z
  .object({
    scope: knowledgeScopeSchema,
    work_id: id.optional(),
    entry_ids: z.array(id).max(KNOWLEDGE_JOB_ENTRY_IDS_MAX).optional(),
    types: z.array(knowledgeEntryTypeSchema).optional(),
    tag_ids: z.array(id).optional(),
    format: z.literal('markdown')
  })
  .strict();
export type KnowledgeExportRequest = z.infer<typeof knowledgeExportRequestSchema>;

// ───────────────────────────── Markdown 导入 preview / commit（§4.6） ─────────────────────────────

export const knowledgeImportPreviewFileSchema = z
  .object({
    file_name: z.string().trim().min(1).max(255),
    title: z.string().max(200),
    entry_type: knowledgeEntryTypeSchema,
    excerpt: z.string().max(160),
    size: z.number().int().nonnegative(),
    conflict: z.enum(['duplicate', 'name_collision', 'new']).default('new')
  })
  .strict();
export type KnowledgeImportPreviewFile = z.infer<typeof knowledgeImportPreviewFileSchema>;

export const knowledgeImportConflictSchema = z
  .object({
    file_index: z.number().int().nonnegative(),
    file_name: z.string().trim().min(1).max(255),
    reason: z.enum(['duplicate', 'name_collision'])
  })
  .strict();
export type KnowledgeImportConflict = z.infer<typeof knowledgeImportConflictSchema>;

export const knowledgeImportSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    duplicate: z.number().int().nonnegative(),
    name_collision: z.number().int().nonnegative(),
    new: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative()
  })
  .strict();
export type KnowledgeImportSummary = z.infer<typeof knowledgeImportSummarySchema>;

export const knowledgeImportPreviewResponseSchema = z
  .object({
    preview_id: id,
    files: z.array(knowledgeImportPreviewFileSchema),
    conflicts: z.array(knowledgeImportConflictSchema),
    summary: knowledgeImportSummarySchema
  })
  .strict();
export type KnowledgeImportPreviewResponse = z.infer<typeof knowledgeImportPreviewResponseSchema>;

export const knowledgeImportResolutionSchema = z
  .object({
    file_index: z.number().int().nonnegative(),
    action: knowledgeConflictPolicySchema
  })
  .strict();
export type KnowledgeImportResolution = z.infer<typeof knowledgeImportResolutionSchema>;

export const knowledgeImportCommitRequestSchema = z
  .object({
    preview_id: id,
    policy: knowledgeConflictPolicySchema,
    resolutions: z.array(knowledgeImportResolutionSchema).optional(),
    idempotency_key: z.string().trim().min(1).max(128).optional()
  })
  .strict();
export type KnowledgeImportCommitRequest = z.infer<typeof knowledgeImportCommitRequestSchema>;

// ───────────────────────────── 作业请求通用（Idempotency-Key 头，§3.4） ─────────────────────────────

export const knowledgeIdempotencyKeySchema = z.string().trim().min(1).max(128);
export type KnowledgeIdempotencyKey = z.infer<typeof knowledgeIdempotencyKeySchema>;

// ───────────────────────────── 作业列表过滤（§4.5） ─────────────────────────────

export const knowledgeJobListQuerySchema = z
  .object({
    scope: knowledgeScopeSchema.optional(),
    work_id: id.optional(),
    kind: knowledgeJobKindSchema.optional(),
    status: knowledgeJobStatusSchema.optional()
  })
  .strict();
export type KnowledgeJobListQuery = z.infer<typeof knowledgeJobListQuerySchema>;
