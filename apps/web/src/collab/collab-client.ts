import type {
  CollabSettings,
  CollabReadiness,
  CollabTaskDetail,
  PutCollabSettingsRequest,
  CreateRoleProfileTaskRequest,
  CollabRoleField,
  CollabWriteback,
  RevertWritebackFieldRequest
} from '@storyforge/contracts';
import {
  putCollabSettingsRequestSchema,
  createRoleProfileTaskRequestSchema,
  revertWritebackFieldRequestSchema,
  collabSettingsSchema,
  collabReadinessSchema,
  collabTaskDetailSchema,
  collabWritebackListResponseSchema
} from '@storyforge/contracts';
import { apiRequest } from '../api/client';
import { characterClient } from '../character/character-client';
import { listAgents, type AgentListItem } from '../agent/agent-client';
import { subscribeTaskEvents, type TaskEventStream, type SubscribeOptions } from '../ai/ai-client';

// F11 多平台 Agent 协同 · 前端客户端（T18 定义接口与实现；T20 状态管理复用）

const root = '/api/v1/works';
const part = encodeURIComponent;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

/** 角色资料任务创建结果 */
export interface CreateRoleProfileTaskResult {
  task: { id: string; status: string; channel: string | null; error: Record<string, unknown> | null };
}

/** 撤销结果：成功返回字段行；冲突由 ApiError(409) 携带 details */
export interface RevertWritebackFieldResult {
  field_key: CollabRoleField;
  status: 'applied' | 'reverted';
  reverted_at: string | null;
  reverted_by: string | null;
}

// ───────────────────────────── 客户端接口 ─────────────────────────────

export interface CollabClient {
  getSettings(workId: string): Promise<CollabSettings | null>;
  putSettings(workId: string, input: PutCollabSettingsRequest): Promise<CollabSettings>;
  getReadiness(workId: string): Promise<CollabReadiness>;
  createRoleProfileTask(workId: string, input: CreateRoleProfileTaskRequest, idempotencyKey?: string): Promise<CreateRoleProfileTaskResult>;
  getTaskDetail(workId: string, taskId: string): Promise<CollabTaskDetail>;
  /** 按角色列写回历史 */
  listWritebacks(workId: string, characterId: string): Promise<CollabWriteback[]>;
  revertWritebackField(workId: string, writebackId: string, fieldKey: CollabRoleField, input?: RevertWritebackFieldRequest): Promise<RevertWritebackFieldResult>;
  /** 列可选的执行 Agent（仅 flowise/coze 通道，协同支持的两类） */
  listCollabAgents(): Promise<AgentListItem[]>;
  /** 列作品角色（用于测试角色下拉） */
  listCharacters(workId: string): Promise<{ items: { id: string; name: string }[] }>;
  /** 复用既有 AI 任务 SSE 事件流（F11 角色资料任务的事件帧格式一致） */
  subscribeTaskEvents(workId: string, taskId: string, options: SubscribeOptions): TaskEventStream;
}

// ───────────────────────────── 默认实现 ─────────────────────────────

export const collabClient: CollabClient = {
  getSettings(workId) {
    return apiRequest(`${root}/${part(workId)}/collab-settings`, collabSettingsSchema.nullable());
  },
  putSettings(workId, input) {
    return apiRequest(`${root}/${part(workId)}/collab-settings`, collabSettingsSchema,
      json('PUT', putCollabSettingsRequestSchema.parse(input)));
  },
  getReadiness(workId) {
    return apiRequest(`${root}/${part(workId)}/collab-readiness`, collabReadinessSchema);
  },
  createRoleProfileTask(workId, input, idempotencyKey) {
    const headers: Record<string, string> = {};
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    const init = json('POST', createRoleProfileTaskRequestSchema.parse(input));
    return apiRequest(`${root}/${part(workId)}/role-profile/tasks`,
      collabTaskCreateResultSchema,
      Object.keys(headers).length ? { ...init, headers } : init);
  },
  getTaskDetail(workId, taskId) {
    return apiRequest(`${root}/${part(workId)}/role-profile/tasks/${part(taskId)}`, collabTaskDetailSchema);
  },
  async listWritebacks(workId, characterId) {
    const result = await apiRequest(`${root}/${part(workId)}/role-profile/writebacks?character_id=${encodeURIComponent(characterId)}`, collabWritebackListResponseSchema);
    return result.items;
  },
  revertWritebackField(workId, writebackId, fieldKey, input) {
    const body = input ? json('POST', revertWritebackFieldRequestSchema.parse(input)) : { method: 'POST' };
    return apiRequest(`${root}/${part(workId)}/role-profile/writebacks/${part(writebackId)}/fields/${part(fieldKey)}/revert`,
      collabRevertResultSchema, body);
  },
  async listCollabAgents() {
    const result = await listAgents();
    return result.agents.filter((agent) => agent.platform === 'flowise' || agent.platform === 'coze');
  },
  async listCharacters(workId) {
    const result = await characterClient.listCharacters(workId, { limit: 200 });
    return { items: result.items.map((character) => ({ id: character.id, name: character.name })) };
  },
  subscribeTaskEvents(workId, taskId, options) {
    return subscribeTaskEvents(workId, taskId, options);
  }
};

// ───────────────────────────── 结果 Schema ─────────────────────────────

import { z } from 'zod';

const collabTaskCreateResultSchema = z.object({
  task: z.object({
    id: z.string().uuid(),
    status: z.string(),
    channel: z.string().nullable(),
    error: z.record(z.unknown()).nullable()
  })
});

const collabRevertResultSchema = z.object({
  field_key: z.enum(['identity', 'personality', 'experience']),
  status: z.enum(['applied', 'reverted']),
  reverted_at: z.string().nullable(),
  reverted_by: z.string().nullable()
});
