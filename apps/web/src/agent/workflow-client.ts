import {
  archiveWorkflowRequestSchema,
  createWorkflowRequestSchema,
  deleteWorkflowResponseSchema,
  listWorkflowsResponseSchema,
  rollbackWorkflowRequestSchema,
  updateWorkflowRequestSchema,
  workflowResponseSchema,
  workflowVersionsResponseSchema,
  type CreateWorkflowInput,
  type UpdateWorkflowRequest,
  type Workflow,
  type WorkflowListItem,
  type WorkflowVersionSummary
} from '@storyforge/contracts';
import { apiRequest } from '../api/client';

const root = '/api/v1';
const part = encodeURIComponent;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

// ───────────────────────────── 工作流管理 ─────────────────────────────

/** 列出当前作者全部工作流（keyword / status 过滤 + 分页） */
export function listWorkflows(query?: { keyword?: string; status?: string; page?: number; page_size?: number }) {
  const params = new URLSearchParams();
  if (query?.keyword) params.set('keyword', query.keyword);
  if (query?.status) params.set('status', query.status);
  if (query?.page) params.set('page', String(query.page));
  if (query?.page_size) params.set('page_size', String(query.page_size));
  const qs = params.toString();
  return apiRequest(`${root}/ai-workflows${qs ? `?${qs}` : ''}`, listWorkflowsResponseSchema);
}

/** 创建工作流 */
export function createWorkflow(input: CreateWorkflowInput) {
  return apiRequest(`${root}/ai-workflows`, workflowResponseSchema, json('POST', createWorkflowRequestSchema.parse(input)));
}

/** 获取工作流详情（含版本快照） */
export function getWorkflow(workflowId: string) {
  return apiRequest(`${root}/ai-workflows/${part(workflowId)}`, workflowResponseSchema);
}

/** 更新工作流（名称/描述/平台配置/LLM 配置/启停；archived 需走归档接口） */
export function updateWorkflow(workflowId: string, input: UpdateWorkflowRequest) {
  return apiRequest(`${root}/ai-workflows/${part(workflowId)}`, workflowResponseSchema, json('PATCH', updateWorkflowRequestSchema.parse(input)));
}

/** 归档工作流（status=archived） */
export function archiveWorkflow(workflowId: string, input: { note?: string } = {}) {
  return apiRequest(`${root}/ai-workflows/${part(workflowId)}/archive`, workflowResponseSchema, json('POST', archiveWorkflowRequestSchema.parse(input)));
}

/** 恢复工作流（status=active） */
export function restoreWorkflow(workflowId: string) {
  return apiRequest(`${root}/ai-workflows/${part(workflowId)}/restore`, workflowResponseSchema, json('POST', {}));
}

/** 删除工作流（已归档硬删；未归档需 force=true） */
export function deleteWorkflow(workflowId: string, force = false) {
  return apiRequest(`${root}/ai-workflows/${part(workflowId)}${force ? '?force=true' : ''}`, deleteWorkflowResponseSchema, { method: 'DELETE' });
}

/** 列出工作流版本历史（摘要，降序，不含 snapshot 内容） */
export function listWorkflowVersions(workflowId: string) {
  return apiRequest(`${root}/ai-workflows/${part(workflowId)}/versions`, workflowVersionsResponseSchema);
}

/** 回滚工作流到指定版本 */
export function rollbackWorkflow(workflowId: string, versionNo: number, input: { note?: string } = {}) {
  return apiRequest(`${root}/ai-workflows/${part(workflowId)}/versions/${versionNo}/rollback`, workflowResponseSchema, json('POST', rollbackWorkflowRequestSchema.parse(input)));
}

export type { Workflow, WorkflowListItem, WorkflowVersionSummary };
