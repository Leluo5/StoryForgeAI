import {
  cozeImportRequestSchema,
  cozeImportResponseSchema,
  cozeListResourcesRequestSchema,
  cozeListResourcesResponseSchema,
  type CozeImportRequest,
  type CozeImportResponse,
  type CozeListResourcesResponse
} from '@storyforge/contracts';
import { z } from 'zod';
import { apiRequest } from '../api/client';

const root = '/api/v1/admin/coze';
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

// 测试连接返回体（data 为 { ok: boolean }）
const testCozeResponseSchema = z.object({ ok: z.boolean() });

// ───────────────────────── F1 Coze 资源拉取与批量导入 ─────────────────────────

/** 测试 Coze 连接（PAT 可显式传入，未传走 site_config/env 兜底） */
export function testCoze(patToken: string): Promise<{ ok: boolean }> {
  return apiRequest(`${root}/test`, testCozeResponseSchema, json('POST', cozeListResourcesRequestSchema.parse({ pat_token: patToken })));
}

/** 拉取 bot+dataset 资源列表 */
export function listCozeResources(patToken: string, workspaceId?: string): Promise<CozeListResourcesResponse> {
  return apiRequest(
    `${root}/list`,
    cozeListResourcesResponseSchema,
    json('POST', cozeListResourcesRequestSchema.parse({ pat_token: patToken, ...(workspaceId ? { workspace_id: workspaceId } : {}) }))
  );
}

/** 批量导入所选资源（可选作品级） */
export function importCozeResources(input: CozeImportRequest): Promise<CozeImportResponse> {
  return apiRequest(`${root}/import`, cozeImportResponseSchema, json('POST', cozeImportRequestSchema.parse(input)));
}
