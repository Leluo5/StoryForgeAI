import { z } from 'zod';

// 复用 M1 基础 schema
const id = z.string().uuid();
const timestamp = z.string().datetime();
const contentHash = z.string().regex(/^[0-9a-f]{64}$/);

// ───────────────────────────── 枚举 ─────────────────────────────

export const revisionActorTypeSchema = z.enum(['author', 'ai', 'import', 'rollback']);
export const revisionStatusSchema = z.enum(['pending', 'partially_resolved', 'resolved']);
export const changeTypeSchema = z.enum(['manual', 'auto']);
export const commentStatusSchema = z.enum(['open', 'resolved', 'reopened']);
export const anchorStatusSchema = z.enum(['attached', 'orphaned']);
export const todoStatusSchema = z.enum(['open', 'in_progress', 'done', 'cancelled']);
export const notificationTypeSchema = z.enum(['mention', 'assign', 'task_result', 'system']);

export type RevisionActorType = z.infer<typeof revisionActorTypeSchema>;
export type RevisionStatus = z.infer<typeof revisionStatusSchema>;
export type ChangeType = z.infer<typeof changeTypeSchema>;
export type CommentStatus = z.infer<typeof commentStatusSchema>;
export type AnchorStatus = z.infer<typeof anchorStatusSchema>;
export type TodoStatus = z.infer<typeof todoStatusSchema>;
export type NotificationType = z.infer<typeof notificationTypeSchema>;

// ───────────────────────────── 核心实体 ─────────────────────────────

// 修订集实体（对齐 database/revision-set.entity.ts）
export const revisionSetSchema = z.object({
  id,
  chapter_id: id,
  base_version: z.number().int().nonnegative(),
  actor_type: revisionActorTypeSchema,
  actor_id: id.nullable(),
  operations: z.array(z.record(z.unknown())).min(1).max(200),
  status: revisionStatusSchema,
  ai_set: z.boolean(),
  created_at: timestamp
});

// 版本快照摘要（列表用，不含 document）
export const versionSummarySchema = z.object({
  id,
  chapter_id: id,
  version_no: z.number().int().nonnegative(),
  content_hash: contentHash,
  created_by: id.nullable(),
  note: z.string().nullable(),
  change_type: changeTypeSchema,
  revision_set_id: id.nullable(),
  created_at: timestamp
});

// 版本快照完整（含 document）
export const versionSnapshotSchema = versionSummarySchema.extend({
  document: z.record(z.unknown())
});

// 评论锚点：选区定位 + 原文上下文（anchor_status 独立列管理）
export const commentAnchorSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  original_text: z.string(),
  before_text: z.string(),
  after_text: z.string(),
  version: z.number().int().nonnegative()
}).refine((value) => value.end > value.start, 'end must be greater than start');

// 评论线程（对齐 database/comment-thread.entity.ts）
export const commentSchema = z.object({
  id,
  chapter_id: id,
  anchor: commentAnchorSchema,
  content: z.string(),
  author_id: id,
  parent_id: id.nullable(),
  status: commentStatusSchema,
  anchor_status: anchorStatusSchema,
  created_at: timestamp,
  updated_at: timestamp
});

// 待办（对齐 database/todo.entity.ts）
export const todoSchema = z.object({
  id,
  work_id: id,
  chapter_id: id.nullable(),
  comment_id: id.nullable(),
  revision_set_id: id.nullable(),
  title: z.string().min(1).max(200),
  description: z.string().nullable(),
  assignee_id: id.nullable(),
  status: todoStatusSchema,
  created_at: timestamp,
  updated_at: timestamp
});

// 通知（对齐 database/notification.entity.ts）
export const notificationSchema = z.object({
  id,
  recipient_id: id,
  type: notificationTypeSchema,
  linked_object: z.object({
    kind: z.string(),
    id: z.string(),
    label: z.string()
  }).nullable(),
  content: z.string(),
  read_at: timestamp.nullable(),
  created_at: timestamp
});

// 审计日志（对齐 database/audit-log.entity.ts）
export const auditLogSchema = z.object({
  id,
  actor_id: id.nullable(),
  action: z.string().min(1).max(80),
  target_type: z.string().min(1).max(40),
  target_id: id.nullable(),
  detail: z.record(z.unknown()),
  created_at: timestamp
});

// 修订集操作实体（单条操作视图：状态推进用）
export const revisionOperationSchema = z.object({
  index: z.number().int().nonnegative(),
  operation: z.record(z.unknown()),
  status: z.enum(['pending', 'accepted', 'rejected'])
});

export type RevisionSet = z.infer<typeof revisionSetSchema>;
export type VersionSummary = z.infer<typeof versionSummarySchema>;
export type VersionSnapshot = z.infer<typeof versionSnapshotSchema>;
export type CommentAnchor = z.infer<typeof commentAnchorSchema>;
export type Comment = z.infer<typeof commentSchema>;
export type Todo = z.infer<typeof todoSchema>;
export type Notification = z.infer<typeof notificationSchema>;
export type AuditLog = z.infer<typeof auditLogSchema>;
export type RevisionOperation = z.infer<typeof revisionOperationSchema>;

// ───────────────────────────── 请求 Schema ─────────────────────────────

// 3.1 修订集
export const createRevisionSetRequestSchema = z.object({
  actor_type: revisionActorTypeSchema,
  base_version: z.number().int().nonnegative(),
  operations: z.array(z.record(z.unknown())).min(1).max(200)
});
export const resolveOperationRequestSchema = z.object({
  decision: z.enum(['accept', 'reject'])
});
export const listRevisionSetsQuerySchema = z.object({
  status: revisionStatusSchema.optional(),
  page: z.coerce.number().int().positive().optional(),
  page_size: z.coerce.number().int().positive().max(100).optional()
});

// 3.2 版本快照与回滚
export const createVersionRequestSchema = z.object({
  note: z.string().trim().max(200).optional()
});
export const compareVersionsRequestSchema = z.object({
  from_version_no: z.number().int().nonnegative(),
  to_version_no: z.number().int().nonnegative()
}).refine((value) => value.to_version_no !== value.from_version_no, 'versions must differ');
export const listVersionsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  page_size: z.coerce.number().int().positive().max(100).optional()
});

// 3.3 评论
export const createCommentRequestSchema = z.object({
  anchor: commentAnchorSchema,
  content: z.string().trim().min(1).max(5000)
});
export const replyCommentRequestSchema = z.object({
  content: z.string().trim().min(1).max(5000)
});
export const reAnchorCommentRequestSchema = z.object({
  anchor: commentAnchorSchema
});

// 3.4 待办
export const createTodoRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  assignee_id: id.optional(),
  chapter_id: id.optional(),
  comment_id: id.optional(),
  revision_set_id: id.optional()
});
export const updateTodoStatusRequestSchema = z.object({
  status: todoStatusSchema
});
export const listTodosQuerySchema = z.object({
  status: todoStatusSchema.optional(),
  assignee_id: id.optional(),
  page: z.coerce.number().int().positive().optional(),
  page_size: z.coerce.number().int().positive().max(100).optional()
});

// 3.5 通知
export const listNotificationsQuerySchema = z.object({
  unread_only: z.coerce.boolean().optional(),
  page: z.coerce.number().int().positive().optional(),
  page_size: z.coerce.number().int().positive().max(100).optional()
});

// 3.6 审计
export const listAuditLogsQuerySchema = z.object({
  actor_id: id.optional(),
  action: z.string().max(80).optional(),
  target_type: z.string().max(40).optional(),
  from: timestamp.optional(),
  to: timestamp.optional(),
  page: z.coerce.number().int().positive().optional(),
  page_size: z.coerce.number().int().positive().max(100).optional()
});

// ───────────────────────────── 响应 Schema ─────────────────────────────

// 3.1 修订集
export const createRevisionSetResponseSchema = z.object({ revision_set: revisionSetSchema });
export const listRevisionSetsResponseSchema = z.object({
  revision_sets: z.array(revisionSetSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  page_size: z.number().int().positive()
});
export const resolveOperationResponseSchema = z.object({
  revision_set: revisionSetSchema,
  operation: revisionOperationSchema
});

// 3.2 版本
export const createVersionResponseSchema = z.object({
  version_no: z.number().int().nonnegative(),
  snapshot_id: id
});
export const listVersionsResponseSchema = z.object({
  versions: z.array(versionSummarySchema),
  total: z.number().int().nonnegative()
});
export const getVersionResponseSchema = z.object({ snapshot: versionSnapshotSchema });
export const compareVersionsResponseSchema = z.object({
  from_version_no: z.number().int().nonnegative(),
  to_version_no: z.number().int().nonnegative(),
  node_changes: z.array(z.object({
    node_path: z.string(),
    change: z.enum(['added', 'removed', 'modified'])
  })),
  text_diff: z.array(z.object({
    kind: z.enum(['insert', 'delete', 'equal']),
    text: z.string()
  }))
});
export const rollbackResponseSchema = z.object({
  revision_set: revisionSetSchema,
  preview: z.record(z.unknown())
});
export const confirmRollbackResponseSchema = z.object({
  version_no: z.number().int().nonnegative(),
  document: z.record(z.unknown())
});

// 3.3 评论
export const createCommentResponseSchema = z.object({ comment: commentSchema });
export const replyCommentResponseSchema = z.object({ reply: commentSchema });
export const listCommentsResponseSchema = z.object({
  comments: z.array(commentSchema)
});

// 3.4 待办
export const createTodoResponseSchema = z.object({ todo: todoSchema });
export const listTodosResponseSchema = z.object({
  todos: z.array(todoSchema),
  total: z.number().int().nonnegative()
});
export const updateTodoStatusResponseSchema = z.object({ todo: todoSchema });

// 3.5 通知
export const listNotificationsResponseSchema = z.object({
  notifications: z.array(notificationSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  page_size: z.number().int().positive()
});
export const readNotificationResponseSchema = z.object({ notification: notificationSchema });
export const readAllNotificationsResponseSchema = z.object({ updated: z.number().int().nonnegative() });
export const unreadCountResponseSchema = z.object({ unread: z.number().int().nonnegative() });

// 3.6 审计
export const listAuditLogsResponseSchema = z.object({
  audit_logs: z.array(auditLogSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  page_size: z.number().int().positive()
});

// ───────────────────────────── 类型导出 ─────────────────────────────

export type CreateRevisionSetRequest = z.infer<typeof createRevisionSetRequestSchema>;
export type ResolveOperationRequest = z.infer<typeof resolveOperationRequestSchema>;
export type ListRevisionSetsQuery = z.infer<typeof listRevisionSetsQuerySchema>;
export type CreateVersionRequest = z.infer<typeof createVersionRequestSchema>;
export type CompareVersionsRequest = z.infer<typeof compareVersionsRequestSchema>;
export type ListVersionsQuery = z.infer<typeof listVersionsQuerySchema>;
export type CreateCommentRequest = z.infer<typeof createCommentRequestSchema>;
export type ReplyCommentRequest = z.infer<typeof replyCommentRequestSchema>;
export type ReAnchorCommentRequest = z.infer<typeof reAnchorCommentRequestSchema>;
export type CreateTodoRequest = z.infer<typeof createTodoRequestSchema>;
export type UpdateTodoStatusRequest = z.infer<typeof updateTodoStatusRequestSchema>;
export type ListTodosQuery = z.infer<typeof listTodosQuerySchema>;
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuerySchema>;
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;

export type CreateRevisionSetResponse = z.infer<typeof createRevisionSetResponseSchema>;
export type ListRevisionSetsResponse = z.infer<typeof listRevisionSetsResponseSchema>;
export type ResolveOperationResponse = z.infer<typeof resolveOperationResponseSchema>;
export type CreateVersionResponse = z.infer<typeof createVersionResponseSchema>;
export type ListVersionsResponse = z.infer<typeof listVersionsResponseSchema>;
export type GetVersionResponse = z.infer<typeof getVersionResponseSchema>;
export type CompareVersionsResponse = z.infer<typeof compareVersionsResponseSchema>;
export type RollbackResponse = z.infer<typeof rollbackResponseSchema>;
export type ConfirmRollbackResponse = z.infer<typeof confirmRollbackResponseSchema>;
export type CreateCommentResponse = z.infer<typeof createCommentResponseSchema>;
export type ReplyCommentResponse = z.infer<typeof replyCommentResponseSchema>;
export type ListCommentsResponse = z.infer<typeof listCommentsResponseSchema>;
export type CreateTodoResponse = z.infer<typeof createTodoResponseSchema>;
export type ListTodosResponse = z.infer<typeof listTodosResponseSchema>;
export type UpdateTodoStatusResponse = z.infer<typeof updateTodoStatusResponseSchema>;
export type ListNotificationsResponse = z.infer<typeof listNotificationsResponseSchema>;
export type ReadNotificationResponse = z.infer<typeof readNotificationResponseSchema>;
export type ReadAllNotificationsResponse = z.infer<typeof readAllNotificationsResponseSchema>;
export type UnreadCountResponse = z.infer<typeof unreadCountResponseSchema>;
export type ListAuditLogsResponse = z.infer<typeof listAuditLogsResponseSchema>;
