import {
  createAgentRequestSchema,
  createAgentResponseSchema,
  deleteAgentResponseSchema,
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
  type UpdateAgentRequest,
  type UpdateToolRequest
} from '@storyforge/contracts';
import { apiRequest } from '../api/client';

const root = '/api/v1';
const part = encodeURIComponent;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

// ───────────────────────────── Agent 管理 ─────────────────────────────

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

// ───────────────────────────── 工具管理 ─────────────────────────────

/** 列出全部创作工具（含绑定 Agent 概要） */
export function listTools() {
  return apiRequest(`${root}/ai-tools`, listToolsResponseSchema);
}

/** 更新工具（绑定 Agent / 启停 / 改名）；停用附「进行中任务不受影响」提示 */
export function updateTool(toolId: string, input: UpdateToolRequest) {
  return apiRequest(`${root}/ai-tools/${part(toolId)}`, updateToolResponseSchema, json('PATCH', updateToolRequestSchema.parse(input)));
}

export type { Agent, AgentListItem, AiToolListItem };
