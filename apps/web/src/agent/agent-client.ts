import {
  createAgentRequestSchema,
  createAgentResponseSchema,
  deleteAgentResponseSchema,
  getAgentDetailResponseSchema,
  listAgentsResponseSchema,
  listToolsResponseSchema,
  updateAgentRequestSchema,
  updateAgentResponseSchema,
  updateToolRequestSchema,
  updateToolResponseSchema,
  type Agent,
  type AgentListItem,
  type AiToolListItem,
  type CreateAgentRequest,
  type GetAgentDetailResponse,
  type ModelConfig,
  type UpdateAgentRequest,
  type UpdateToolRequest
} from '@storyforge/contracts';
import { apiRequest } from '../api/client';

const root = '/api/v1';
const part = encodeURIComponent;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

// ───────────────────────────── Agent 管理 ─────────────────────────────

/**
 * 完整默认模型配置（M4-T6：契约 modelConfigSchema 缺省字段由 default 补齐）。
 * web 端表单仅编辑 temperature/max_tokens，提交时合并完整字段，避免触发契约层 422。
 */
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  temperature: 0.7,
  top_p: 1.0,
  max_tokens: 2048,
  system_prompt: '',
  stream: false,
  frequency_penalty: 0,
  presence_penalty: 0,
  response_format: 'text',
  stop: []
};

/** 列出当前作者全部 Agent（含绑定工具数） */
export function listAgents() {
  return apiRequest(`${root}/ai-agents`, listAgentsResponseSchema);
}

/** 创建 Agent（默认互斥：is_default=true 时清掉其他默认） */
export function createAgent(input: CreateAgentRequest) {
  return apiRequest(`${root}/ai-agents`, createAgentResponseSchema, json('POST', createAgentRequestSchema.parse(input)));
}

/** 更新 Agent（名称 / 模型参数 / 状态 / 设默认） */
export function updateAgent(agentId: string, input: UpdateAgentRequest) {
  return apiRequest(`${root}/ai-agents/${part(agentId)}`, updateAgentResponseSchema, json('PATCH', updateAgentRequestSchema.parse(input)));
}

/** 软删 Agent（status='disabled' + 解绑工具） */
export function deleteAgent(agentId: string) {
  return apiRequest(`${root}/ai-agents/${part(agentId)}`, deleteAgentResponseSchema, { method: 'DELETE' });
}

/** 获取 Agent 详情（含已绑定工具列表） */
export function getAgentDetail(agentId: string) {
  return apiRequest(`${root}/ai-agents/${part(agentId)}`, getAgentDetailResponseSchema);
}

// ───────────────────────────── 工具管理 ─────────────────────────────

/** 列出全部创作工具（含绑定 Agent 概要） */
export function listTools() {
  return apiRequest(`${root}/ai-tools`, listToolsResponseSchema);
}

/** 更新工具（绑定 Agent / 启停 / 改名）；停用附「进行中任务不受影响」提示 */
export function updateTool(toolId: string, input: UpdateToolRequest) {
  return apiRequest(`${root}/ai-tools/${part(toolId)}`, updateToolResponseSchema, json('PATCH', updateToolRequestSchema.parse(input)));
}

export type { Agent, AgentListItem, AiToolListItem, GetAgentDetailResponse };
