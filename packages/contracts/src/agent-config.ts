import { z } from 'zod';

// 复用 M1/M2/M3a 基础 schema
const id = z.string().uuid();
const timestamp = z.string().datetime();

// ───────────────────────────── 枚举 ─────────────────────────────

export const agentStatusSchema = z.enum(['active', 'disabled']);
export const agentPlatformSchema = z.enum(['mock', 'coze', 'flowise']);

export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type AgentPlatform = z.infer<typeof agentPlatformSchema>;

// 平台级配置：仅允许非敏感标识，禁止 URL/令牌/任意键；地址与密钥只能来自环境变量
// F2 §4.5：platform_config 只存 flowise_chatflow_id，Coze/Mock 使用空对象
export const agentPlatformConfigSchema = z
  .object({
    flowise_chatflow_id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional()
  })
  .strict()
  .default({});
export type AgentPlatformConfig = z.infer<typeof agentPlatformConfigSchema>;

// 模型参数：受控字段（温度/最大 token），防任意 JSON 注入
export const modelConfigSchema = z
  .object({
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().max(32768).optional()
  })
  .strict()
  .default({});

// ───────────────────────────── 核心实体 ─────────────────────────────

// AI 创作 Agent（对齐 database/agent.entity.ts）
export const agentSchema = z.object({
  id,
  author_id: id,
  name: z.string().min(1).max(80),
  platform: agentPlatformSchema,
  platform_config: agentPlatformConfigSchema.optional().default({}),
  model_id: z.string().min(1).max(80),
  model_config: modelConfigSchema,
  status: agentStatusSchema,
  is_default: z.boolean(),
  // 功能描述（V2 实体已有，V1 契约补上以支持详情页展示）
  description: z.string().default(''),
  created_at: timestamp,
  updated_at: timestamp
});

// 创作工具注册表（对齐 database/ai-tool.entity.ts）
// 命名 aiToolConfigSchema / AiToolConfig：避免与 ai-task.ts 的 aiToolSchema（工具标识）冲突
export const aiToolConfigSchema = z.object({
  id,
  tool_id: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  description: z.string().max(255).nullable(),
  agent_id: id.nullable(),
  enabled: z.boolean(),
  created_at: timestamp,
  updated_at: timestamp
});

export type Agent = z.infer<typeof agentSchema>;
export type AiToolConfig = z.infer<typeof aiToolConfigSchema>;

// 绑定 Agent 概要（工具列表/Agent 列表的关联展示）
export const agentSummarySchema = z.object({
  id,
  name: z.string().min(1).max(80),
  platform: agentPlatformSchema,
  model_id: z.string().min(1).max(80),
  status: agentStatusSchema
});
export type AgentSummary = z.infer<typeof agentSummarySchema>;

// ───────────────────────────── 请求 Schema ─────────────────────────────

// 创建 Agent
export const createAgentRequestSchema = z.object({
  name: z.string().min(1).max(80),
  platform: agentPlatformSchema.default('mock'),
  platform_config: agentPlatformConfigSchema.optional(),
  model_id: z.string().min(1).max(80),
  model_config: modelConfigSchema,
  is_default: z.boolean().optional()
});

// 更新 Agent（部分字段）
export const updateAgentRequestSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    platform: agentPlatformSchema.optional(),
    platform_config: agentPlatformConfigSchema.optional(),
    model_id: z.string().min(1).max(80).optional(),
    model_config: modelConfigSchema.optional(),
    status: agentStatusSchema.optional(),
    is_default: z.boolean().optional()
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少提供一项更新' });

// 更新工具（部分字段）
export const updateToolRequestSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(255).nullable().optional(),
    agent_id: id.nullable().optional(),
    enabled: z.boolean().optional()
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少提供一项更新' });

export type CreateAgentRequest = z.infer<typeof createAgentRequestSchema>;
export type UpdateAgentRequest = z.infer<typeof updateAgentRequestSchema>;
export type UpdateToolRequest = z.infer<typeof updateToolRequestSchema>;

// 服务层方法参数用「输入」类型：.default() 字段（platform/model_config）可省略，由 schema 在入口补默认值。
export type CreateAgentInput = z.input<typeof createAgentRequestSchema>;
export type UpdateAgentInput = z.input<typeof updateAgentRequestSchema>;
export type UpdateToolInput = z.input<typeof updateToolRequestSchema>;

// ───────────────────────────── 响应 Schema ─────────────────────────────

// Agent 列表项：含绑定工具数
export const agentListItemSchema = agentSchema.extend({
  bound_tool_count: z.number().int().nonnegative()
});
export type AgentListItem = z.infer<typeof agentListItemSchema>;

// 工具列表项：含绑定 Agent 概要
export const aiToolListItemSchema = aiToolConfigSchema.extend({
  bound_agent: agentSummarySchema.nullable()
});
export type AiToolListItem = z.infer<typeof aiToolListItemSchema>;

export const createAgentResponseSchema = z.object({ agent: agentSchema });
export const updateAgentResponseSchema = z.object({ agent: agentSchema });
export const deleteAgentResponseSchema = z.object({ ok: z.boolean() });
export const listAgentsResponseSchema = z.object({ agents: z.array(agentListItemSchema) });

export const listToolsResponseSchema = z.object({ tools: z.array(aiToolListItemSchema) });
export const updateToolResponseSchema = z.object({
  tool: aiToolListItemSchema,
  // 停用工具时的提示（不阻断）
  warning: z.string().nullable()
});

// Agent 详情：Agent 列表项 + 已绑定工具列表
export const getAgentDetailResponseSchema = z.object({
  agent: agentListItemSchema,
  tools: z.array(aiToolListItemSchema)
});

export type CreateAgentResponse = z.infer<typeof createAgentResponseSchema>;
export type UpdateAgentResponse = z.infer<typeof updateAgentResponseSchema>;
export type DeleteAgentResponse = z.infer<typeof deleteAgentResponseSchema>;
export type ListAgentsResponse = z.infer<typeof listAgentsResponseSchema>;
export type ListToolsResponse = z.infer<typeof listToolsResponseSchema>;
export type UpdateToolResponse = z.infer<typeof updateToolResponseSchema>;
export type GetAgentDetailResponse = z.infer<typeof getAgentDetailResponseSchema>;

// ═══════════════════════════════════════════════════════════════════
// V2 扩展：作品级三类 Agent + 版本快照 + 分组 + 流程进度
// 全部 schema 追加，不修改任何现有导出（向后兼容保证）
// ═══════════════════════════════════════════════════════════════════

// ─── V2 枚举 ───

export const agentStatusV2Schema = z.enum(['active', 'disabled', 'archived']);
export type AgentStatusV2 = z.infer<typeof agentStatusV2Schema>;

export const agentKindSchema = z.enum(['legacy', 'role_agent', 'tool_agent', 'flow_step_agent']);
export type AgentKind = z.infer<typeof agentKindSchema>;

export const agentScopeSchema = z.enum(['project', 'role']);
export type AgentScope = z.infer<typeof agentScopeSchema>;

export const agentSourceSchema = z.enum(['manual', 'template', 'migration', 'auto']);
export type AgentSource = z.infer<typeof agentSourceSchema>;

export const agentCredentialSourceSchema = z.enum(['global', 'own']);
export type AgentCredentialSource = z.infer<typeof agentCredentialSourceSchema>;

export const agentChangeTypeSchema = z.enum(['create', 'update', 'archive', 'restore', 'rollback']);
export type AgentChangeType = z.infer<typeof agentChangeTypeSchema>;

export const flowStepStatusSchema = z.enum(['pending', 'running', 'done', 'failed']);
export type FlowStepStatus = z.infer<typeof flowStepStatusSchema>;

export const flowProgressStatusSchema = z.enum(['idle', 'running', 'done', 'failed']);
export type FlowProgressStatus = z.infer<typeof flowProgressStatusSchema>;

// ─── V2 完整模型参数（10 项） ───

export const modelConfigV2Schema = z
  .object({
    model: z.string().max(80).optional(),
    temperature: z.number().min(0).max(2).default(0.7),
    top_p: z.number().min(0).max(1).default(1.0),
    max_tokens: z.number().int().positive().max(32768).default(2048),
    system_prompt: z.string().default(''),
    stream: z.boolean().default(false),
    frequency_penalty: z.number().min(-2).max(2).default(0),
    presence_penalty: z.number().min(-2).max(2).default(0),
    response_format: z.enum(['text', 'json', 'markdown']).default('text'),
    stop: z.array(z.string().max(64)).max(4).default([])
  })
  .strict()
  .default({});

export type ModelConfigV2 = z.infer<typeof modelConfigV2Schema>;

// ─── V2 Agent 扩展实体 ───

export const agentV2Schema = agentSchema.extend({
  project_id: id.optional().nullable(),
  kind: agentKindSchema.optional().default('legacy'),
  description: z.string().optional().default(''),
  role_id: id.optional().nullable(),
  tool_name: z.string().max(40).optional().nullable(),
  step_order: z.number().int().min(1).max(11).optional().nullable(),
  scope: agentScopeSchema.optional().default('project'),
  platform_config: agentPlatformConfigSchema.optional().default({}),
  source: agentSourceSchema.optional().default('manual'),
  tags: z.array(z.string()).optional().default([]),
  manual_group_key: id.optional().nullable(),
  credential_source: agentCredentialSourceSchema.optional().default('global'),
  version_no: z.number().int().positive().optional().default(1),
  archived_at: timestamp.optional().nullable()
});
export type AgentV2 = z.infer<typeof agentV2Schema>;

// ─── V2 Agent Identity 校验 ───

/** kind + 归属字段互斥校验：role_agent 必须 role_id；tool_agent 必须 tool_name；flow_step_agent 必须 step_order 1-11 */
export function validateAgentIdentity(input: {
  kind: AgentKind;
  role_id?: string | null;
  tool_name?: string | null;
  step_order?: number | null;
}): void {
  const { kind, role_id, tool_name, step_order } = input;
  if (kind === 'role_agent') {
    if (!role_id || tool_name || step_order) throw new Error('role_agent 必须且只能提供 role_id');
  } else if (kind === 'tool_agent') {
    if (!tool_name || role_id || step_order) throw new Error('tool_agent 必须且只能提供 tool_name');
  } else if (kind === 'flow_step_agent') {
    if (step_order == null || step_order < 1 || step_order > 11) throw new Error('flow_step_agent 的 step_order 须为 1-11');
    if (role_id || tool_name) throw new Error('flow_step_agent 不能提供 role_id/tool_name');
  }
}

// ─── V2 请求 Schema ───

export const createAgentV2RequestSchema = z
  .object({
    name: z.string().min(1).max(80),
    project_id: id.optional(),
    kind: agentKindSchema.optional().default('legacy'),
    description: z.string().max(500).optional(),
    role_id: id.optional(),
    tool_name: z.string().max(40).optional(),
    step_order: z.number().int().min(1).max(11).optional(),
    scope: agentScopeSchema.optional(),
    platform: agentPlatformSchema.default('mock'),
    platform_config: agentPlatformConfigSchema.optional(),
    model_id: z.string().min(1).max(80).optional(),
    model_config: modelConfigV2Schema.optional(),
    source: agentSourceSchema.optional(),
    tags: z.array(z.string().max(40)).optional(),
    is_default: z.boolean().optional()
  })
  .superRefine((v, ctx) => {
    try {
      validateAgentIdentity({ kind: v.kind ?? 'legacy', role_id: v.role_id ?? null, tool_name: v.tool_name ?? null, step_order: v.step_order ?? null });
    } catch (e) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message });
    }
  });

export const updateAgentV2RequestSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(500).optional(),
    platform: agentPlatformSchema.optional(),
    platform_config: agentPlatformConfigSchema.optional(),
    model_id: z.string().min(1).max(80).optional(),
    model_config: modelConfigV2Schema.optional(),
    status: agentStatusV2Schema.optional(),
    is_default: z.boolean().optional(),
    tags: z.array(z.string().max(40)).optional(),
    manual_group_key: id.nullable().optional()
  })
  .refine((v) => Object.keys(v).length > 0, { message: '至少提供一项更新' });

export type CreateAgentV2Request = z.infer<typeof createAgentV2RequestSchema>;
export type UpdateAgentV2Request = z.infer<typeof updateAgentV2RequestSchema>;
export type CreateAgentV2Input = z.input<typeof createAgentV2RequestSchema>;
export type UpdateAgentV2Input = z.input<typeof updateAgentV2RequestSchema>;

// ─── 版本快照 ───

export const agentVersionSnapshotSchema = z.object({
  version_no: z.number().int().positive(),
  change_type: agentChangeTypeSchema,
  note: z.string().default(''),
  created_at: timestamp,
  snapshot: z.record(z.unknown())
});
export type AgentVersionSnapshot = z.infer<typeof agentVersionSnapshotSchema>;

export const agentVersionSummarySchema = agentVersionSnapshotSchema.omit({ snapshot: true });
export type AgentVersionSummary = z.infer<typeof agentVersionSummarySchema>;

// ─── 列表查询 ───

export const listAgentsV2QuerySchema = z.object({
  project_id: id.optional(),
  kind: agentKindSchema.optional(),
  status: agentStatusV2Schema.optional(),
  role_id: id.optional(),
  tool_name: z.string().optional(),
  keyword: z.string().optional(),
  page: z.number().int().min(1).default(1),
  page_size: z.number().int().min(1).max(100).default(20)
});
export type ListAgentsV2Query = z.infer<typeof listAgentsV2QuerySchema>;

// ─── 流程进度 ───

export const flowStepSchema = z.object({
  step_order: z.number().int().min(1).max(11),
  status: flowStepStatusSchema,
  output: z.record(z.unknown()).optional(),
  error: z.string().optional(),
  started_at: timestamp.optional().nullable(),
  finished_at: timestamp.optional().nullable()
});

export const flowProgressSchema = z.object({
  project_id: id,
  role_id: id,
  run_id: id.nullable(),
  status: flowProgressStatusSchema,
  current_step: z.number().int().nonnegative(),
  completed_steps: z.array(z.number().int().min(1).max(11)),
  steps: z.array(flowStepSchema),
  context: z.record(z.unknown()),
  last_error: z.string(),
  started_at: timestamp.optional().nullable(),
  updated_at: timestamp.optional().nullable()
});
export type FlowProgress = z.infer<typeof flowProgressSchema>;

// ─── 分组覆盖层 ───

export const groupOverrideSchema = z.object({
  key: z.string().min(1).max(80),
  name: z.string().max(80).optional(),
  sort_order: z.number().int().default(0),
  hidden: z.boolean().default(false)
});
export type GroupOverride = z.infer<typeof groupOverrideSchema>;

export const manualGroupSchema = z.object({
  id: z.string().startsWith('manual:'),
  parent_key: z.string().default('project:'),
  name: z.string().min(1).max(80),
  sort_order: z.number().int().default(0)
});
export type ManualGroup = z.infer<typeof manualGroupSchema>;

export const groupOverrideBundleSchema = z.object({
  project_id: id,
  schema_version: z.literal(1),
  overrides: z.array(groupOverrideSchema).default([]),
  manual_groups: z.array(manualGroupSchema).default([]),
  updated_at: timestamp.optional()
});

// ─── 工具 Agent 汇总 ───

export const toolAgentSummarySchema = z.object({
  tool_name: z.string(),
  agents: z.array(agentSummarySchema),
  default_agent_id: id.nullable()
});
export type ToolAgentSummary = z.infer<typeof toolAgentSummarySchema>;

// ─── 分组树节点（递归，z.lazy 需显式类型） ───

// 用 any 绕开 ZodType 对 input/output 的严格匹配（.default() 导致 optional）
// 运行时完全安全：output 类型由 schema.infer 正确推导
export const groupTreeNodeSchema: z.ZodType<GroupTreeNode> = z.object({
  key: z.string(),
  name: z.string(),
  sort_order: z.number().int(),
  hidden: z.boolean().default(false),
  is_manual: z.boolean().default(false),
  children: z.lazy(() => z.array(groupTreeNodeSchema)).default([]),
  agent_ids: z.array(id).default([])
}) as unknown as z.ZodType<GroupTreeNode>;

export interface GroupTreeNode {
  key: string;
  name: string;
  sort_order: number;
  hidden: boolean;
  is_manual: boolean;
  children: GroupTreeNode[];
  agent_ids: string[];
}
