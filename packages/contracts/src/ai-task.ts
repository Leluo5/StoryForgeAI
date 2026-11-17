import { z } from 'zod';

// 复用 M1/M2 基础 schema
const id = z.string().uuid();
const timestamp = z.string().datetime();

// ───────────────────────────── 枚举 ─────────────────────────────

export const aiTaskStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
// SSE 推送事件类型（含传输层包装 snapshot）
export const aiTaskEventTypeSchema = z.enum(['queued', 'running', 'progress', 'succeeded', 'failed', 'cancelled', 'snapshot']);
// ai_task_events 表持久化类型（对齐 DB CHECK，不含 snapshot）
export const aiTaskPersistedEventTypeSchema = z.enum(['queued', 'running', 'progress', 'succeeded', 'failed', 'cancelled']);
export const aiToolSchema = z.enum(['continue', 'rewrite', 'expand', 'polish']);

export type AiTaskStatus = z.infer<typeof aiTaskStatusSchema>;
export type AiTaskEventType = z.infer<typeof aiTaskEventTypeSchema>;
export type AiTaskPersistedEventType = z.infer<typeof aiTaskPersistedEventTypeSchema>;
export type AiTool = z.infer<typeof aiToolSchema>;

// ───────────────────────────── 核心实体 ─────────────────────────────

// AI 创作任务（对齐 database/ai-task.entity.ts）
export const aiTaskSchema = z.object({
  id,
  work_id: id,
  chapter_id: id,
  tool: aiToolSchema,
  agent_id: id.nullable(),
  input_summary: z.record(z.unknown()),
  base_version: z.number().int().nonnegative(),
  status: aiTaskStatusSchema,
  event_seq: z.number().int().nonnegative(),
  result_revision_set_id: id.nullable(),
  error: z.record(z.unknown()).nullable(),
  attempts: z.number().int().nonnegative(),
  created_by: id,
  created_at: timestamp,
  updated_at: timestamp
});

// 任务进度事件（对齐 database/ai-task-event.entity.ts）
export const aiTaskEventSchema = z.object({
  id,
  task_id: id,
  event_seq: z.number().int().nonnegative(),
  type: aiTaskPersistedEventTypeSchema,
  payload: z.record(z.unknown()),
  created_at: timestamp
});

export type AiTask = z.infer<typeof aiTaskSchema>;
export type AiTaskEvent = z.infer<typeof aiTaskEventSchema>;

// ───────────────────────────── 请求 Schema ─────────────────────────────

// 发起 AI 创作任务
export const createAiTaskRequestSchema = z.object({
  tool: aiToolSchema,
  input_summary: z.record(z.unknown()).default({}),
  idempotency_key: z.string().min(1).max(128)
});
export const listAiTasksQuerySchema = z.object({
  status: aiTaskStatusSchema.optional(),
  page: z.coerce.number().int().positive().optional(),
  page_size: z.coerce.number().int().positive().max(100).optional()
});
// SSE 补取参数（since 与 Last-Event-ID 等价）
export const listAiTaskEventsQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().optional()
});

export type CreateAiTaskRequest = z.infer<typeof createAiTaskRequestSchema>;
export type ListAiTasksQuery = z.infer<typeof listAiTasksQuerySchema>;
export type ListAiTaskEventsQuery = z.infer<typeof listAiTaskEventsQuerySchema>;

// ───────────────────────────── 响应 Schema ─────────────────────────────

export const createAiTaskResponseSchema = z.object({ task: aiTaskSchema });
export const getAiTaskResponseSchema = z.object({ task: aiTaskSchema });
export const retryAiTaskResponseSchema = z.object({ task: aiTaskSchema });
export const cancelAiTaskResponseSchema = z.object({ task: aiTaskSchema });
export const listAiTasksResponseSchema = z.object({
  tasks: z.array(aiTaskSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  page_size: z.number().int().positive()
});
export const listAiTaskEventsResponseSchema = z.object({
  events: z.array(aiTaskEventSchema)
});

export type CreateAiTaskResponse = z.infer<typeof createAiTaskResponseSchema>;
export type GetAiTaskResponse = z.infer<typeof getAiTaskResponseSchema>;
export type RetryAiTaskResponse = z.infer<typeof retryAiTaskResponseSchema>;
export type CancelAiTaskResponse = z.infer<typeof cancelAiTaskResponseSchema>;
export type ListAiTasksResponse = z.infer<typeof listAiTasksResponseSchema>;
export type ListAiTaskEventsResponse = z.infer<typeof listAiTaskEventsResponseSchema>;
