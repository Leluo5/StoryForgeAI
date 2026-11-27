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
// 工具标识：M3b 起工具权威移至 DB 表 ai_tools（tool_id 自由字符串，由服务端权威校验存在性）
export const aiToolSchema = z.string().min(1).max(40);
// 任务作用域：chapter（章节正文修订）/ plot（剧情推衍与结构生成）
// character（角色版图生成）/ role_profile（F11 角色资料）/ workflow_run（M4-T7 工作流运行）
// character_map（M4-T8 AI 建图：仅基于已入库角色生成关系边）
export const aiTaskScopeSchema = z.enum(['chapter', 'plot', 'character', 'role_profile', 'workflow_run', 'character_map']);

export type AiTaskStatus = z.infer<typeof aiTaskStatusSchema>;
export type AiTaskEventType = z.infer<typeof aiTaskEventTypeSchema>;
export type AiTaskPersistedEventType = z.infer<typeof aiTaskPersistedEventTypeSchema>;
export type AiTool = z.infer<typeof aiToolSchema>;

// ───────────────────────────── 核心实体 ─────────────────────────────

// AI 创作任务（对齐 database/ai-task.entity.ts）
export const aiTaskSchema = z.object({
  id,
  // 工作流运行任务（scope='workflow_run'）无作品归属，可为空
  work_id: id.nullable(),
  // 章节任务必填；剧情推衍任务（scope='plot'）与工作流运行任务（scope='workflow_run'）为空
  chapter_id: id.nullable(),
  scope: aiTaskScopeSchema,
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
