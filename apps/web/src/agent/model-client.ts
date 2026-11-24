import {
  createModelRequestSchema,
  deleteModelResponseSchema,
  listModelsResponseSchema,
  modelResponseSchema,
  updateModelRequestSchema,
  type CreateModelInput,
  type Model,
  type ModelListItem,
  type UpdateModelRequest
} from '@storyforge/contracts';
import { apiRequest } from '../api/client';

const root = '/api/v1';
const part = encodeURIComponent;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

// ───────────────────────────── 模型管理 ─────────────────────────────

/** 列出当前作者全部模型（keyword / status 过滤 + 分页） */
export function listModels(query?: { keyword?: string; status?: string; page?: number; page_size?: number }) {
  const params = new URLSearchParams();
  if (query?.keyword) params.set('keyword', query.keyword);
  if (query?.status) params.set('status', query.status);
  if (query?.page) params.set('page', String(query.page));
  if (query?.page_size) params.set('page_size', String(query.page_size));
  const qs = params.toString();
  return apiRequest(`${root}/ai-models${qs ? `?${qs}` : ''}`, listModelsResponseSchema);
}

/** 创建模型 */
export function createModel(input: CreateModelInput) {
  return apiRequest(`${root}/ai-models`, modelResponseSchema, json('POST', createModelRequestSchema.parse(input)));
}

/** 获取模型详情 */
export function getModel(modelId: string) {
  return apiRequest(`${root}/ai-models/${part(modelId)}`, modelResponseSchema);
}

/** 更新模型（白名单字段；status 仅 active/disabled） */
export function updateModel(modelId: string, input: UpdateModelRequest) {
  return apiRequest(`${root}/ai-models/${part(modelId)}`, modelResponseSchema, json('PATCH', updateModelRequestSchema.parse(input)));
}

/** 删除模型（直接硬删） */
export function deleteModel(modelId: string) {
  return apiRequest(`${root}/ai-models/${part(modelId)}`, deleteModelResponseSchema, { method: 'DELETE' });
}

export type { Model, ModelListItem };
