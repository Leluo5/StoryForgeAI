import { z } from 'zod';

// ─────────────────────────────────────────────────────────────
// 工作流（Workflow）契约
// 对齐 F12 概念但精简 + 去敏感：
//  - platform_config / llm_config 只存非敏感标识（workflow_id/workspace_id/model）
//  - base_url / api_key 等密钥一律禁止（服务端 env 注入）
//  - status 三态：active / disabled / archived
//  - versions 为版本快照数组（保留最近 MAX_VERSIONS 条）
// ─────────────────────────────────────────────────────────────

/** 保留最近 N 个版本快照，超出从头部丢弃（与 agent 一致） */
export const MAX_WORKFLOW_VERSIONS = 50;

// ── 枚举 ──

export const workflowStatusSchema = z.enum(['active', 'disabled', 'archived']);
export type WorkflowStatus = z.infer<typeof workflowStatusSchema>;

export const workflowPlatformSchema = z.enum(['coze']);
export type WorkflowPlatform = z.infer<typeof workflowPlatformSchema>;

export const workflowSourceSchema = z.enum(['manual', 'coze_import']);
export type WorkflowSource = z.infer<typeof workflowSourceSchema>;

export const workflowChangeTypeSchema = z.enum(['create', 'update', 'archive', 'restore', 'rollback']);
export type WorkflowChangeType = z.infer<typeof workflowChangeTypeSchema>;

// ── 平台配置（仅非敏感标识，严格模式拒绝任意键 / URL / 令牌） ──

const platformIdPattern = /^[A-Za-z0-9-]{1,64}$/;

export const workflowPlatformConfigSchema = z
  .object({
    workflow_id: z.string().regex(platformIdPattern, 'workflow_id 仅允许字母数字与连字符').optional(),
    workspace_id: z.string().regex(platformIdPattern, 'workspace_id 仅允许字母数字与连字符').optional()
  })
  .strict()
  .default({});
export type WorkflowPlatformConfig = z.infer<typeof workflowPlatformConfigSchema>;

// ── LLM 配置（不含 base_url/api_key，密钥由服务端 env 注入） ──

export const workflowLlmConfigSchema = z
  .object({
    model: z.string().min(1).max(120)
  })
  .strict();
export type WorkflowLlmConfig = z.infer<typeof workflowLlmConfigSchema>;

// ── 版本快照 ──

export const workflowVersionSnapshotSchema = z.object({
  version_no: z.number().int().positive(),
  change_type: workflowChangeTypeSchema,
  note: z.string().default(''),
  created_at: z.string().datetime(),
  snapshot: z.record(z.string(), z.unknown())
});
export type WorkflowVersionSnapshot = z.infer<typeof workflowVersionSnapshotSchema>;

export const workflowVersionSummarySchema = z.object({
  version_no: z.number().int().positive(),
  change_type: workflowChangeTypeSchema,
  note: z.string(),
  created_at: z.string().datetime()
});
export type WorkflowVersionSummary = z.infer<typeof workflowVersionSummarySchema>;

// ── 实体 ──

export const workflowSchema = z.object({
  id: z.string().uuid(),
  author_id: z.string().uuid(),
  name: z.string().min(1).max(80),
  description: z.string().default(''),
  status: workflowStatusSchema,
  platform: workflowPlatformSchema,
  platform_config: workflowPlatformConfigSchema,
  llm_config: workflowLlmConfigSchema,
  source: workflowSourceSchema,
  version_no: z.number().int().positive().default(1),
  versions: z.array(workflowVersionSnapshotSchema).default([]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  archived_at: z.string().datetime().nullable().default(null)
});
export type Workflow = z.infer<typeof workflowSchema>;

// ── 列表项（列表时剔除 versions 大字段，保持轻量） ──

export const workflowListItemSchema = workflowSchema.omit({ versions: true });
export type WorkflowListItem = z.infer<typeof workflowListItemSchema>;

// ── 请求：创建 ──

export const createWorkflowRequestSchema = z.object({
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional().default(''),
  platform: workflowPlatformSchema.optional().default('coze'),
  platform_config: workflowPlatformConfigSchema.optional().default({}),
  llm_config: workflowLlmConfigSchema,
  source: workflowSourceSchema.optional().default('manual')
});
export type CreateWorkflowRequest = z.infer<typeof createWorkflowRequestSchema>;
export type CreateWorkflowInput = z.input<typeof createWorkflowRequestSchema>;

// ── 请求：更新（至少一项，且状态机约束） ──

export const updateWorkflowRequestSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    platform_config: workflowPlatformConfigSchema.optional(),
    llm_config: workflowLlmConfigSchema.optional(),
    status: workflowStatusSchema.optional()
  })
  .refine((val) => Object.keys(val).length > 0, { message: '至少提供一个要更新的字段' })
  // archived 只能由 archive/restore 端点驱动，普通更新不允许直接改到 archived
  .refine((val) => val.status !== 'archived', {
    message: '不能通过普通更新设置 archived 状态，请使用归档接口'
  });
export type UpdateWorkflowRequest = z.infer<typeof updateWorkflowRequestSchema>;
export type UpdateWorkflowInput = z.input<typeof updateWorkflowRequestSchema>;

// ── 请求：归档 / 恢复 ──

export const archiveWorkflowRequestSchema = z.object({
  note: z.string().max(500).optional().default('')
});
export type ArchiveWorkflowRequest = z.infer<typeof archiveWorkflowRequestSchema>;

export const rollbackWorkflowRequestSchema = z.object({
  note: z.string().max(500).optional().default('')
});
export type RollbackWorkflowRequest = z.infer<typeof rollbackWorkflowRequestSchema>;

// ── 响应信封 data 载荷 ──

export const listWorkflowsResponseSchema = z.object({
  workflows: z.array(workflowListItemSchema),
  total: z.number().int().nonnegative()
});

export const workflowResponseSchema = z.object({
  workflow: workflowSchema
});

export const workflowVersionsResponseSchema = z.object({
  versions: z.array(workflowVersionSummarySchema),
  version_no: z.number().int().positive()
});

export const deleteWorkflowResponseSchema = z.object({
  deleted: z.literal(true),
  id: z.string().uuid()
});
