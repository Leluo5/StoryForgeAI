import {
  createKnowledgeEntryRequestSchema,
  commitKnowledgeEntryRequestSchema,
  updateKnowledgeEntryRequestSchema,
  linkKnowledgeRequestSchema,
  extractOutlineRequestSchema,
  searchKnowledgeRequestSchema,
  searchKnowledgeResponseSchema,
  exportKnowledgeMarkdownRequestSchema,
  exportKnowledgeMarkdownResponseSchema,
  importKnowledgePreviewRequestSchema,
  importKnowledgePreviewResponseSchema,
  importKnowledgeRequestSchema,
  importKnowledgeResultSchema,
  validateKnowledgeMarkdownRequestSchema,
  validateKnowledgeMarkdownResponseSchema,
  knowledgeEntrySchema,
  type CreateKnowledgeEntryRequest,
  type CommitKnowledgeEntryRequest,
  type UpdateKnowledgeEntryRequest,
  type LinkKnowledgeRequest,
  type ExtractOutlineRequest,
  type SearchKnowledgeRequest,
  type SearchKnowledgeResponse,
  type ExportKnowledgeMarkdownRequest,
  type ExportKnowledgeMarkdownResponse,
  type ImportKnowledgePreviewRequest,
  type ImportKnowledgePreviewResponse,
  type ImportKnowledgeRequest,
  type ImportKnowledgeResult,
  type ValidateKnowledgeMarkdownRequest,
  type ValidateKnowledgeMarkdownResponse,
  type KnowledgeEntry
} from '@storyforge/contracts';
import { z } from 'zod';
import { apiRequest } from '../api/client';

const root = '/api/v1/knowledge';
const part = encodeURIComponent;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

// 简单操作响应（delete/link/outline）内联 schema
const deleteResponseSchema = z.object({ ok: z.boolean() });
const linkResponseSchema = z.object({ id: z.string(), links: z.array(z.string()) });
const outlineResponseSchema = z.object({
  novel_id: z.string(),
  outline: z.unknown().optional(),
  error: z.string().optional()
});

// 3.1 统一录入：生成预览（不落库）。type='auto' 时由后端 LLM 识别。
export interface CreateEntryResult {
  status: 'preview' | 'saved' | 'type_uncertain';
  id?: string;
  type?: string;
  title?: string;
  structured?: Record<string, unknown>;
  tags?: string[];
  degraded?: boolean;
}

export async function createEntryPreview(input: CreateKnowledgeEntryRequest): Promise<CreateEntryResult> {
  const data = await apiRequest(`${root}/entries`, z.unknown(), json('POST', createKnowledgeEntryRequestSchema.parse(input)));
  return data as unknown as CreateEntryResult;
}

// 3.2 确认入库（幂等）
export function commitEntry(id: string, input: CommitKnowledgeEntryRequest) {
  return apiRequest(`${root}/entries/${part(id)}/commit`, knowledgeEntrySchema, json('POST', commitKnowledgeEntryRequestSchema.parse(input)));
}

// 3.3 统一检索（四维过滤 + 分页）
export function searchEntries(query: SearchKnowledgeRequest) {
  const params = new URLSearchParams();
  if (query.keyword) params.set('keyword', query.keyword);
  if (query.type) params.set('type', query.type);
  if (query.tag) params.set('tag', query.tag);
  if (query.start_time) params.set('start_time', query.start_time);
  if (query.end_time) params.set('end_time', query.end_time);
  params.set('page', String(query.page ?? 1));
  params.set('page_size', String(query.page_size ?? 20));
  return apiRequest<SearchKnowledgeResponse>(`${root}/entries?${params.toString()}`, searchKnowledgeResponseSchema);
}

// 3.4 详情
export function getEntry(id: string) {
  return apiRequest(`${root}/entries/${part(id)}`, knowledgeEntrySchema);
}

// 3.5 编辑
export function updateEntry(id: string, input: UpdateKnowledgeEntryRequest) {
  return apiRequest(`${root}/entries/${part(id)}`, knowledgeEntrySchema, json('PUT', updateKnowledgeEntryRequestSchema.parse(input)));
}

// 3.6 删除
export function deleteEntry(id: string) {
  return apiRequest(`${root}/entries/${part(id)}`, deleteResponseSchema, { method: 'DELETE' });
}

// 3.7 建立关联
export function linkEntry(id: string, input: LinkKnowledgeRequest) {
  return apiRequest(`${root}/entries/${part(id)}/link`, linkResponseSchema, json('POST', linkKnowledgeRequestSchema.parse(input)));
}

// 3.8 大纲自动提取
export function extractOutline(input: ExtractOutlineRequest) {
  return apiRequest(`${root}/outline/extract`, outlineResponseSchema, json('POST', extractOutlineRequestSchema.parse(input)));
}

// 3.9a Markdown 导出
export function exportMarkdown(input: ExportKnowledgeMarkdownRequest) {
  return apiRequest<ExportKnowledgeMarkdownResponse>(`${root}/markdown/export`, exportKnowledgeMarkdownResponseSchema, json('POST', exportKnowledgeMarkdownRequestSchema.parse(input)));
}

// 3.9b 导入预览
export function importPreview(input: ImportKnowledgePreviewRequest) {
  return apiRequest<ImportKnowledgePreviewResponse>(`${root}/markdown/import/preview`, importKnowledgePreviewResponseSchema, json('POST', importKnowledgePreviewRequestSchema.parse(input)));
}

// 3.9c 确认导入
export function importMarkdown(input: ImportKnowledgeRequest) {
  return apiRequest<ImportKnowledgeResult>(`${root}/markdown/import`, importKnowledgeResultSchema, json('POST', importKnowledgeRequestSchema.parse(input)));
}

// 3.9d 单文件格式校验
export function validateMarkdown(input: ValidateKnowledgeMarkdownRequest) {
  return apiRequest<ValidateKnowledgeMarkdownResponse>(`${root}/markdown/import/validate`, validateKnowledgeMarkdownResponseSchema, json('POST', validateKnowledgeMarkdownRequestSchema.parse(input)));
}

export type { KnowledgeEntry, SearchKnowledgeResponse };
