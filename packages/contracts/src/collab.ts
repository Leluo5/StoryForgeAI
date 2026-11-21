import { z } from 'zod';
import { aiTaskStatusSchema } from './ai-task';

// F11 多平台 Agent 协同契约：设置 / 就绪 / 角色资料任务 / 写回 / 归档
// 字段与长度对齐 F2 §4.2~§4.4 与 §3.2，错误码对齐 §8.1
// 设计原则：只暴露必要的字段名与布尔就绪，地址/密钥/上游原始错误一律不出现在契约中

const id = z.string().uuid();
const timestamp = z.string().datetime();

// ───────────────────────────── 枚举 ─────────────────────────────

// 可自动写回的角色资料字段（服务端权威白名单）
export const collabRoleFieldSchema = z.enum(['identity', 'personality', 'experience']);
export type CollabRoleField = z.infer<typeof collabRoleFieldSchema>;

// 角色资料字段长度上限（对齐 database/character.entity.ts 列约束）
export const collabRoleFieldLimitsSchema = z.object({
  identity: z.number().int().positive(),
  personality: z.number().int().positive(),
  experience: z.number().int().positive()
});
export type CollabRoleFieldLimits = z.infer<typeof collabRoleFieldLimitsSchema>;

// 通道名（与 ai_tasks.channel 检查约束一致）
export const collabChannelSchema = z.enum(['flowise', 'coze']);
export type CollabChannel = z.infer<typeof collabChannelSchema>;

// 写回单整体状态
export const collabWritebackStatusSchema = z.enum(['applied', 'partially_reverted', 'reverted']);
export type CollabWritebackStatus = z.infer<typeof collabWritebackStatusSchema>;

// 字段行状态
export const collabFieldStatusSchema = z.enum(['applied', 'reverted']);
export type CollabFieldStatus = z.infer<typeof collabFieldStatusSchema>;

// 归档发件箱状态
export const collabArchiveStatusSchema = z.enum(['pending', 'delivered', 'failed']);
export type CollabArchiveStatus = z.infer<typeof collabArchiveStatusSchema>;

// 就绪项
export const collabReadinessItemSchema = z.object({
  configured: z.boolean()
});
export type CollabReadinessItem = z.infer<typeof collabReadinessItemSchema>;

// ───────────────────────────── 配置 Schema ─────────────────────────────

export const collabSettingsSchema = z
  .object({
    work_id: id,
    test_character_id: id,
    agent_id: id,
    whitelist_fields: z.array(collabRoleFieldSchema),
    enabled: z.boolean().default(false),
    created_at: timestamp,
    updated_at: timestamp
  })
  .refine((v) => v.whitelist_fields.length >= 2 && v.whitelist_fields.length <= 3, {
    message: '白名单字段需 2-3 项',
    path: ['whitelist_fields']
  });
export type CollabSettings = z.infer<typeof collabSettingsSchema>;

export const putCollabSettingsRequestSchema = z
  .object({
    test_character_id: id,
    agent_id: id,
    whitelist_fields: z.array(collabRoleFieldSchema),
    enabled: z.boolean()
  })
  .refine((v) => v.whitelist_fields.length >= 2 && v.whitelist_fields.length <= 3, {
    message: '白名单字段需 2-3 项',
    path: ['whitelist_fields']
  });
export type PutCollabSettingsRequest = z.infer<typeof putCollabSettingsRequestSchema>;

// 就绪检查：只返回布尔值，不返回地址/密钥/上游原始错误
// 未配置时 settings 无角色/Agent，test_character_id/agent_id 为 null
export const collabReadinessSchema = z.object({
  settings: z.object({
    enabled: z.boolean(),
    test_character_id: id.nullable(),
    agent_id: id.nullable()
  }),
  channels: z.object({
    flowise: collabReadinessItemSchema,
    coze: collabReadinessItemSchema
  }),
  retrieval: collabReadinessItemSchema,
  archive: collabReadinessItemSchema
});
export type CollabReadiness = z.infer<typeof collabReadinessSchema>;

// ───────────────────────────── 任务 Schema ─────────────────────────────

export const createRoleProfileTaskRequestSchema = z.object({
  character_id: id,
  fields: z.array(collabRoleFieldSchema).min(2).max(3),
  instruction: z.string().trim().min(1).max(500)
});
export type CreateRoleProfileTaskRequest = z.infer<typeof createRoleProfileTaskRequestSchema>;

// 生成结果契约：上游必须返回单 JSON 对象
export const collabGenerateResultSchema = z
  .object({
    fields: z.record(z.string(), z.string()),
    notes: z.string().max(2000).optional().default('')
  })
  .strict();
export type CollabGenerateResult = z.infer<typeof collabGenerateResultSchema>;

// 引用快照（来源、标题、摘录）
export const collabCitationSchema = z.object({
  source_id: z.string().min(1).max(128),
  title: z.string().min(1).max(200),
  snippet: z.string().max(500),
  score: z.number().nullable()
});
export type CollabCitation = z.infer<typeof collabCitationSchema>;

// 字段写回行
export const collabWritebackFieldSchema = z.object({
  field_key: collabRoleFieldSchema,
  before_value: z.unknown().nullable(),
  after_value: z.unknown().nullable(),
  status: collabFieldStatusSchema,
  reverted_at: timestamp.nullable(),
  reverted_by: id.nullable()
});
export type CollabWritebackField = z.infer<typeof collabWritebackFieldSchema>;

// 写回单
export const collabWritebackSchema = z.object({
  id: id,
  task_id: id,
  work_id: id,
  character_id: id,
  channel: collabChannelSchema,
  status: collabWritebackStatusSchema,
  applied_version: z.number().int().positive(),
  applied_at: timestamp,
  fields: z.array(collabWritebackFieldSchema)
});
export type CollabWriteback = z.infer<typeof collabWritebackSchema>;

// 归档记录（只暴露状态与次数）
export const collabArchiveSchema = z.object({
  status: collabArchiveStatusSchema,
  attempts: z.number().int().nonnegative(),
  external_id: z.string().max(128).nullable(),
  delivered_at: timestamp.nullable()
});
export type CollabArchive = z.infer<typeof collabArchiveSchema>;

// 任务详情（状态、通道、错误、引用、写回、归档）
export const collabTaskDetailSchema = z.object({
  task: z.object({
    id: id,
    status: aiTaskStatusSchema,
    channel: collabChannelSchema.nullable(),
    error: z.record(z.unknown()).nullable()
  }),
  citations: z.array(collabCitationSchema),
  writeback: collabWritebackSchema.nullable(),
  archive: collabArchiveSchema.nullable()
});
export type CollabTaskDetail = z.infer<typeof collabTaskDetailSchema>;

// ───────────────────────────── 撤销 Schema ─────────────────────────────

export const revertWritebackFieldRequestSchema = z.object({
  // 可选：客户端传入写回后的值做前置校验；缺省由服务端比对库内 after_value
  expected_value: z.unknown().optional()
});
export type RevertWritebackFieldRequest = z.infer<typeof revertWritebackFieldRequestSchema>;

// 撤销冲突：返回当前角色字段值与写回后值
export const collabFieldConflictSchema = z.object({
  field_key: collabRoleFieldSchema,
  current_value: z.unknown().nullable(),
  after_value: z.unknown().nullable()
});
export type CollabFieldConflict = z.infer<typeof collabFieldConflictSchema>;

// ───────────────────────────── 通道端口类型（F2 §5.1） ─────────────────────────────

export type AgentChannelName = CollabChannel;

export interface AgentChannelRequest {
  taskId: string;
  workId: string;
  channel: AgentChannelName;
  chatflowId?: string;
  instruction: string;
  roleContext: Record<string, unknown>;
  citations: Array<{ source_id: string; title: string; snippet: string }>;
  outputFields: CollabRoleField[];
}

export interface AgentChannelResult {
  rawText: string;
  model: string;
  latencyMs: number;
}

export interface AgentChannel {
  readonly name: AgentChannelName;
  invoke(request: AgentChannelRequest): Promise<AgentChannelResult>;
}

// ───────────────────────────── 错误码（F2 §8.1） ─────────────────────────────

export const collabErrorCodeSchema = z.enum([
  'COLLAB_DISABLED',
  'COLLAB_TEST_ROLE_MISMATCH',
  'COLLAB_FIELD_NOT_ALLOWED',
  'COLLAB_CHANNEL_NOT_CONFIGURED',
  'COLLAB_NO_CITATION',
  'COLLAB_UPSTREAM_TIMEOUT',
  'COLLAB_UPSTREAM_FAILED',
  'COLLAB_INVALID_RESULT',
  'COLLAB_FIELD_CONFLICT'
]);
export type CollabErrorCode = z.infer<typeof collabErrorCodeSchema>;

// ───────────────────────────── 写回列表（F2 §5.3 GET /works/:workId/role-profile/writebacks） ─────────────────────────────

export const collabWritebackListResponseSchema = z.object({
  items: z.array(collabWritebackSchema)
});
export type CollabWritebackListResponse = z.infer<typeof collabWritebackListResponseSchema>;
