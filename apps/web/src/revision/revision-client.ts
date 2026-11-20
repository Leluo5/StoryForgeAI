import {
  compareVersionsRequestSchema,
  compareVersionsResponseSchema,
  confirmRollbackResponseSchema,
  createRevisionSetRequestSchema,
  createRevisionSetResponseSchema,
  createVersionRequestSchema,
  createVersionResponseSchema,
  getVersionResponseSchema,
  listRevisionSetsQuerySchema,
  listRevisionSetsResponseSchema,
  listVersionsQuerySchema,
  listVersionsResponseSchema,
  resolveOperationResponseSchema,
  rollbackResponseSchema,
  type CompareVersionsRequest,
  type CompareVersionsResponse,
  type ConfirmRollbackResponse,
  type CreateRevisionSetRequest,
  type CreateRevisionSetResponse,
  type CreateVersionRequest,
  type CreateVersionResponse,
  type GetVersionResponse,
  type ListRevisionSetsQuery,
  type ListRevisionSetsResponse,
  type ListVersionsQuery,
  type ListVersionsResponse,
  type ResolveOperationResponse,
  type RollbackResponse
} from '@storyforge/contracts';
import { apiRequest } from '../api/client';

const root = '/api/v1/works';
const part = encodeURIComponent;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

// 3.1 修订集
export function createRevisionSet(
  workId: string, chapterId: string, input: CreateRevisionSetRequest
): Promise<CreateRevisionSetResponse> {
  return apiRequest(`${root}/${part(workId)}/chapters/${part(chapterId)}/revision-sets`,
    createRevisionSetResponseSchema, json('POST', createRevisionSetRequestSchema.parse(input)));
}
export function listRevisionSets(
  workId: string, chapterId: string, query: ListRevisionSetsQuery = {}
): Promise<ListRevisionSetsResponse> {
  const q = new URLSearchParams();
  if (query.status) q.set('status', query.status);
  if (query.page) q.set('page', String(query.page));
  if (query.page_size) q.set('page_size', String(query.page_size));
  const suffix = q.size ? `?${q.toString()}` : '';
  return apiRequest(`${root}/${part(workId)}/chapters/${part(chapterId)}/revision-sets${suffix}`,
    listRevisionSetsResponseSchema);
}
export function acceptOperation(
  workId: string, revisionSetId: string, opIndex: number
): Promise<ResolveOperationResponse> {
  return apiRequest(`${root}/${part(workId)}/revision-sets/${part(revisionSetId)}/operations/${opIndex}/accept`,
    resolveOperationResponseSchema, json('POST', { decision: 'accept' }));
}
export function rejectOperation(
  workId: string, revisionSetId: string, opIndex: number
): Promise<ResolveOperationResponse> {
  return apiRequest(`${root}/${part(workId)}/revision-sets/${part(revisionSetId)}/operations/${opIndex}/reject`,
    resolveOperationResponseSchema, json('POST', { decision: 'reject' }));
}

// 3.2 版本快照与回滚
export function createVersion(
  workId: string, chapterId: string, input: CreateVersionRequest
): Promise<CreateVersionResponse> {
  return apiRequest(`${root}/${part(workId)}/chapters/${part(chapterId)}/versions`,
    createVersionResponseSchema, json('POST', createVersionRequestSchema.parse(input)));
}
export function listVersions(
  workId: string, chapterId: string, query: ListVersionsQuery = {}
): Promise<ListVersionsResponse> {
  const q = new URLSearchParams();
  if (query.page) q.set('page', String(query.page));
  if (query.page_size) q.set('page_size', String(query.page_size));
  const suffix = q.size ? `?${q.toString()}` : '';
  return apiRequest(`${root}/${part(workId)}/chapters/${part(chapterId)}/versions${suffix}`,
    listVersionsResponseSchema);
}
export function getVersion(
  workId: string, chapterId: string, versionNo: number
): Promise<GetVersionResponse> {
  return apiRequest(`${root}/${part(workId)}/chapters/${part(chapterId)}/versions/${versionNo}`,
    getVersionResponseSchema);
}
export function compareVersions(
  workId: string, chapterId: string, input: CompareVersionsRequest
): Promise<CompareVersionsResponse> {
  return apiRequest(`${root}/${part(workId)}/chapters/${part(chapterId)}/versions/${input.from_version_no}/compare`,
    compareVersionsResponseSchema, json('POST', compareVersionsRequestSchema.parse(input)));
}
export function rollback(
  workId: string, chapterId: string, versionNo: number
): Promise<RollbackResponse> {
  return apiRequest(`${root}/${part(workId)}/chapters/${part(chapterId)}/versions/${versionNo}/rollback`,
    rollbackResponseSchema, json('POST', {}));
}
export function confirmRollback(
  workId: string, revisionSetId: string
): Promise<ConfirmRollbackResponse> {
  return apiRequest(`${root}/${part(workId)}/revision-sets/${part(revisionSetId)}/confirm-rollback`,
    confirmRollbackResponseSchema, json('POST', {}));
}

