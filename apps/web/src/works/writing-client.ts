import { z } from 'zod';
import {
  chapterInputSchema,
  chapterSchema,
  chapterSummarySchema,
  createWorkRequestSchema,
  createWorkResponseSchema,
  reorderRequestSchema,
  saveChangeRequestSchema,
  saveChangeResponseSchema,
  treeResponseSchema,
  updateWorkRequestSchema,
  volumeInputSchema,
  volumeSchema,
  workSchema,
  type Chapter,
  type ChapterSummary,
  type CreateWorkRequest,
  type CreateWorkResponse,
  type SaveChangeRequest,
  type SaveChangeResponse,
  type TreeResponse,
  type UpdateWorkRequest,
  type Volume,
  type Work
} from '@storyforge/contracts';
import { apiRequest } from '../api/client';

const root = '/api/v1/works';
const part = encodeURIComponent;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export function listWorks(query = ''): Promise<Work[]> {
  return apiRequest(`${root}?q=${encodeURIComponent(query)}`, z.array(workSchema));
}
export function createWork(input: CreateWorkRequest): Promise<CreateWorkResponse> {
  return apiRequest(root, createWorkResponseSchema, json('POST', createWorkRequestSchema.parse(input)));
}
export function updateWork(workId: string, input: UpdateWorkRequest): Promise<Work> {
  return apiRequest(`${root}/${part(workId)}`, workSchema, json('PATCH', updateWorkRequestSchema.parse(input)));
}
export function getTree(workId: string): Promise<TreeResponse> {
  return apiRequest(`${root}/${part(workId)}/tree`, treeResponseSchema);
}
export function createVolume(workId: string, input: { title: string }): Promise<Volume> {
  return apiRequest(`${root}/${part(workId)}/volumes`, volumeSchema, json('POST', volumeInputSchema.parse(input)));
}
export function renameVolume(workId: string, volumeId: string, input: { title: string }): Promise<Volume> {
  return apiRequest(`${root}/${part(workId)}/volumes/${part(volumeId)}`, volumeSchema, json('PATCH', volumeInputSchema.parse(input)));
}
export function reorderVolumes(workId: string, orderedIds: string[]): Promise<Volume[]> {
  return apiRequest(`${root}/${part(workId)}/volumes/order`, z.array(volumeSchema),
    json('PUT', reorderRequestSchema.parse({ ordered_ids: orderedIds })));
}
export function createChapter(workId: string, volumeId: string, input: { title: string }): Promise<Chapter> {
  return apiRequest(`${root}/${part(workId)}/volumes/${part(volumeId)}/chapters`, chapterSchema,
    json('POST', chapterInputSchema.parse(input)));
}
export function renameChapter(workId: string, chapterId: string, input: { title: string }): Promise<ChapterSummary> {
  return apiRequest(`${root}/${part(workId)}/chapters/${part(chapterId)}`, chapterSummarySchema,
    json('PATCH', chapterInputSchema.parse(input)));
}
export function reorderChapters(workId: string, volumeId: string, orderedIds: string[]): Promise<ChapterSummary[]> {
  return apiRequest(`${root}/${part(workId)}/volumes/${part(volumeId)}/chapters/order`, z.array(chapterSummarySchema),
    json('PUT', reorderRequestSchema.parse({ ordered_ids: orderedIds })));
}
export function getChapter(workId: string, chapterId: string): Promise<Chapter> {
  return apiRequest(`${root}/${part(workId)}/chapters/${part(chapterId)}`, chapterSchema);
}
export function saveChange(workId: string, chapterId: string, input: SaveChangeRequest): Promise<SaveChangeResponse> {
  return apiRequest(`${root}/${part(workId)}/chapters/${part(chapterId)}/changes`, saveChangeResponseSchema,
    json('POST', saveChangeRequestSchema.parse(input)));
}
