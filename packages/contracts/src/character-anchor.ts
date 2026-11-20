import { z } from 'zod';

// M3c-2 段落级归档锚点与扫描契约（F2 §3.3、§4.7、§5.5）

const id = z.string().uuid();
const timestamp = z.string().datetime();

// ───────────────────────────── 枚举 ─────────────────────────────

// 与 M2 修订评论的 anchorStatusSchema 区分，前缀 character
export const characterAnchorStatusSchema = z.enum(['active', 'dismissed', 'invalid']);
export const anchorInvalidReasonSchema = z.enum(['pid_missing', 'text_changed', 'character_restored']);
export const chapterMarkReasonSchema = z.enum(['pid_missing', 'text_changed', 'scan_pending', 'scan_failed']);
export const archiveScanStatusSchema = z.enum(['pending', 'running', 'succeeded', 'failed']);

export type CharacterAnchorStatus = z.infer<typeof characterAnchorStatusSchema>;
export type AnchorInvalidReason = z.infer<typeof anchorInvalidReasonSchema>;
export type ChapterMarkReason = z.infer<typeof chapterMarkReasonSchema>;
export type ArchiveScanStatus = z.infer<typeof archiveScanStatusSchema>;

// ───────────────────────────── 实体 ─────────────────────────────

// 不返回 excerpt_hash：漂移判定只在服务端使用
export const characterTextAnchorSchema = z.object({
  id,
  character_id: id,
  chapter_id: id,
  paragraph_pid: z.string().uuid(),
  matched_name: z.string().trim().min(1).max(60),
  excerpt: z.string().max(120),
  status: characterAnchorStatusSchema,
  invalid_reason: anchorInvalidReasonSchema.nullable().optional(),
  created_at: timestamp
});

export const chapterParagraphMarkSchema = z.object({
  id,
  character_id: id,
  character_name: z.string().trim().min(1).max(60),
  paragraph_pid: z.string().uuid(),
  matched_name: z.string().trim().min(1).max(60),
  status: characterAnchorStatusSchema,
  excerpt: z.string().max(120)
});

// 整章兜底：失效锚点不进入 paragraph_marks，聚合为章节级提示
export const chapterMarkSchema = z.object({
  character_id: id,
  character_name: z.string().trim().min(1).max(60),
  reason: chapterMarkReasonSchema,
  label: z.string().trim().min(1).max(80)
});

export const chapterRoleMarksScanSchema = z.object({
  scan_id: id.nullable().optional(),
  status: archiveScanStatusSchema,
  scanned_chapters: z.number().int().nonnegative(),
  total_chapters: z.number().int().nonnegative()
});

export const chapterRoleMarksSchema = z.object({
  paragraph_marks: z.array(chapterParagraphMarkSchema),
  chapter_marks: z.array(chapterMarkSchema),
  scan: chapterRoleMarksScanSchema
});

export const archiveScanSchema = z.object({
  id,
  character_id: id,
  status: archiveScanStatusSchema,
  total_chapters: z.number().int().nonnegative(),
  scanned_chapters: z.number().int().nonnegative(),
  matched_paragraphs: z.number().int().nonnegative(),
  error: z.record(z.unknown()).nullable(),
  created_at: timestamp
});

// ───────────────────────────── 请求 ─────────────────────────────

export const dismissAnchorRequestSchema = z.object({
  reason: z.string().trim().max(200).optional()
});

export const dismissAnchorsRequestSchema = z.object({
  anchor_ids: z.array(id).min(1).max(100)
});

// ───────────────────────────── 类型导出 ─────────────────────────────

export type CharacterTextAnchor = z.infer<typeof characterTextAnchorSchema>;
export type ChapterParagraphMark = z.infer<typeof chapterParagraphMarkSchema>;
export type ChapterMark = z.infer<typeof chapterMarkSchema>;
export type ChapterRoleMarks = z.infer<typeof chapterRoleMarksSchema>;
export type ArchiveScan = z.infer<typeof archiveScanSchema>;
