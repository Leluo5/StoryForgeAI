import { z } from 'zod';

// 复用 M1/M2/M3a 基础 schema
const id = z.string().uuid();
const timestamp = z.string().datetime();

// ───────────────────────────── 枚举 ─────────────────────────────

export const agentStatusSchema = z.enum(['active', 'disabled']);
export const agentPlatformSchema = z.enum(['mock', 'coze']);

export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type AgentPlatform = z.infer<typeof agentPlatformSchema>;

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
  model_id: z.string().min(1).max(80),
  model_config: modelConfigSchema,
  status: agentStatusSchema,
  is_default: z.boolean(),
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
  model_id: z.string().min(1).max(80),
  model_config: modelConfigSchema,
  is_default: z.boolean().optional()
});

// 更新 Agent（部分字段）
export const updateAgentRequestSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
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

export type CreateAgentResponse = z.infer<typeof createAgentResponseSchema>;
export type UpdateAgentResponse = z.infer<typeof updateAgentResponseSchema>;
export type DeleteAgentResponse = z.infer<typeof deleteAgentResponseSchema>;
export type ListAgentsResponse = z.infer<typeof listAgentsResponseSchema>;
export type ListToolsResponse = z.infer<typeof listToolsResponseSchema>;
export type UpdateToolResponse = z.infer<typeof updateToolResponseSchema>;
