import { z } from 'zod';

const id = z.string().uuid();
const timestamp = z.string().datetime();
const contentHash = z.string().regex(/^[0-9a-f]{64}$/);

export interface ProseMirrorNode {
  type: string;
  text?: string | undefined;
  attrs?: Record<string, unknown> | undefined;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> | undefined }> | undefined;
  content?: ProseMirrorNode[] | undefined;
}

export const proseMirrorNodeSchema: z.ZodType<ProseMirrorNode> = z.lazy(() => z.object({
  type: z.string().min(1),
  text: z.string().optional(),
  attrs: z.record(z.unknown()).optional(),
  marks: z.array(z.object({
    type: z.string(),
    attrs: z.record(z.unknown()).optional()
  })).optional(),
  content: z.array(proseMirrorNodeSchema).optional()
}).strict());

export const proseMirrorDocumentSchema = proseMirrorNodeSchema.refine((node) => node.type === 'doc', {
  message: 'Root node must be doc'
});

export const workSchema = z.object({
  id,
  author_id: id,
  title: z.string().min(1).max(120),
  description: z.string().max(2000),
  status: z.enum(['active', 'archived']),
  /** 全作品正文字数（不含空白）。可选：旧接口/旧缓存可能缺失，前端用 0 兜底。 */
  word_count: z.number().int().nonnegative().optional(),
  /** 是否公开（在线体验可访问）。默认 true。 */
  is_public: z.boolean().default(true),
  /** 访问码；空字符串表示无需验证。默认 ''。 */
  access_code: z.string().max(64).default(''),
  created_at: timestamp,
  updated_at: timestamp
});
export const volumeSchema = z.object({
  id,
  work_id: id,
  title: z.string().min(1).max(120),
  position: z.number().int().nonnegative()
});
export const chapterSummarySchema = z.object({
  id,
  work_id: id,
  volume_id: id,
  title: z.string().min(1).max(200),
  position: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  content_hash: contentHash,
  /** 本章正文非空白字数。旧接口/旧缓存可能缺失，前端用 0 兜底。 */
  word_count: z.number().int().nonnegative().optional()
});
export const chapterSchema = chapterSummarySchema.extend({ document: proseMirrorDocumentSchema });
export const createWorkRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000),
  /** 可选：默认公开（true）。 */
  is_public: z.boolean().optional(),
  /** 可选：默认空字符串（无需访问码）。 */
  access_code: z.string().trim().max(64).optional()
});
export const createWorkResponseSchema = z.object({ work: workSchema, first_chapter_id: id });
export const updateWorkRequestSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).optional(),
  status: z.enum(['active', 'archived']).optional(),
  is_public: z.boolean().optional(),
  access_code: z.string().trim().max(64).optional()
}).refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const treeResponseSchema = z.object({
  work: workSchema,
  volumes: z.array(volumeSchema),
  chapters: z.array(chapterSummarySchema)
});
export const volumeInputSchema = z.object({ title: z.string().trim().min(1).max(120) });
export const chapterInputSchema = z.object({ title: z.string().trim().min(1).max(200) });
export const reorderRequestSchema = z.object({
  ordered_ids: z.array(id).min(1).max(5000)
}).refine((value) => new Set(value.ordered_ids).size === value.ordered_ids.length, 'IDs must be unique');
export const saveChangeRequestSchema = z.object({
  change_id: id,
  client_id: id,
  sequence: z.number().int().positive(),
  base_version: z.number().int().nonnegative(),
  operations: z.array(z.record(z.unknown())).min(1).max(100)
});
export const saveChangeResponseSchema = z.object({
  change_id: id,
  server_version: z.number().int().positive(),
  content_hash: contentHash
});
export const versionConflictDetailsSchema = z.object({
  server_version: z.number().int().nonnegative(),
  server_document: proseMirrorDocumentSchema,
  server_content_hash: contentHash
});

export type Work = z.infer<typeof workSchema>;
export type Volume = z.infer<typeof volumeSchema>;
export type ChapterSummary = z.infer<typeof chapterSummarySchema>;
export type Chapter = z.infer<typeof chapterSchema>;
export type TreeResponse = z.infer<typeof treeResponseSchema>;
export type CreateWorkRequest = z.infer<typeof createWorkRequestSchema>;
export type CreateWorkResponse = z.infer<typeof createWorkResponseSchema>;
export type UpdateWorkRequest = z.infer<typeof updateWorkRequestSchema>;
export type SaveChangeRequest = z.infer<typeof saveChangeRequestSchema>;
export type SaveChangeResponse = z.infer<typeof saveChangeResponseSchema>;
export type VersionConflictDetails = z.infer<typeof versionConflictDetailsSchema>;
