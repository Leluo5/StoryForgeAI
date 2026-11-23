import { z } from 'zod';
import {
  articleStructuredSchema,
  inspirationStructuredSchema,
  knowledgeConflictPolicySchema,
  knowledgeEntryTypeSchema,
  knowledgeLinkKindSchema,
  knowledgeOriginSchema,
  knowledgeOutlineSchema,
  knowledgeRefStatusSchema,
  knowledgeScopeSchema,
  knowledgeStructureStatusSchema,
  novelStructuredSchema,
  paperStructuredSchema,
  settingStructuredSchema
} from './knowledge';

// ============================================================================
// M3c-3 知识库导入导出与整库备份契约（F2 §3.1、§3.6、§3.7、§4.6、§4.7）
//
// 备份根对象 schema_version=1、kind='knowledge-backup'；数量上限：
//   条目 ≤2000、标签 ≤1000、关联 ≤5000、解压 ≤500 MB
// front matter 用 YAML 子集（字符串、字符串数组、布尔、ISO 时间），type 限五类。
// ============================================================================

const id = z.string().uuid();
const timestamp = z.string().datetime();

export const KNOWLEDGE_BACKUP_SCHEMA_VERSION = 1;
export const KNOWLEDGE_BACKUP_ENTRIES_MAX = 2000;
export const KNOWLEDGE_BACKUP_TAGS_MAX = 1000;
export const KNOWLEDGE_BACKUP_LINKS_MAX = 5000;
export const KNOWLEDGE_BACKUP_UNCOMPRESSED_BYTES_MAX = 500 * 1024 * 1024; // 500 MB

const localId = z.string().trim().min(1).max(40);

// ───────────────────────────── front matter（§3.6 YAML 子集） ─────────────────────────────

export const knowledgeFrontMatterTypeSchema = knowledgeEntryTypeSchema;

// YAML 子集：字符串、字符串数组、布尔、ISO 时间；未知字段拒绝
export const knowledgeFrontMatterSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    type: knowledgeFrontMatterTypeSchema,
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    favorite: z.boolean().default(false),
    pinned: z.boolean().default(false),
    created_at: timestamp.optional()
  })
  .strict();
export type KnowledgeFrontMatter = z.infer<typeof knowledgeFrontMatterSchema>;

// ───────────────────────────── 备份条目（§3.7） ─────────────────────────────

// 受控结构化：复用 knowledge.ts 的五类型 discriminated union，按 entry_type 校验
export const knowledgeBackupEntryStructuredSchema = z.discriminatedUnion('entry_type', [
  articleStructuredSchema.extend({ entry_type: z.literal('article') }).strict(),
  settingStructuredSchema.extend({ entry_type: z.literal('setting') }).strict(),
  paperStructuredSchema.extend({ entry_type: z.literal('paper') }).strict(),
  novelStructuredSchema.extend({ entry_type: z.literal('novel') }).strict(),
  inspirationStructuredSchema.extend({ entry_type: z.literal('inspiration') }).strict()
]);
export type KnowledgeBackupEntryStructured = z.infer<typeof knowledgeBackupEntryStructuredSchema>;

export const knowledgeBackupEntrySchema = z
  .object({
    local_id: localId,
    entry_type: knowledgeEntryTypeSchema,
    title: z.string().max(200),
    original_text: z.string().max(20_000_000),
    content_hash: z.string().trim().min(1).max(128),
    structured: knowledgeBackupEntryStructuredSchema.nullable(),
    outline: knowledgeOutlineSchema.nullable(),
    structure_status: knowledgeStructureStatusSchema,
    outline_status: z.enum(['pending', 'ready', 'failed']).nullable(),
    origin: knowledgeOriginSchema.default('manual'),
    favorite: z.boolean().default(false),
    pinned: z.boolean().default(false),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
    created_at: timestamp
  })
  .strict();
export type KnowledgeBackupEntry = z.infer<typeof knowledgeBackupEntrySchema>;

export const knowledgeBackupTagSchema = z
  .object({
    name: z.string().trim().min(1).max(40)
  })
  .strict();
export type KnowledgeBackupTag = z.infer<typeof knowledgeBackupTagSchema>;

export const knowledgeBackupLinkSchema = z
  .object({
    source_local_id: localId,
    target_local_id: localId,
    kind: knowledgeLinkKindSchema,
    score: z.number().finite().optional()
  })
  .strict();
export type KnowledgeBackupLink = z.infer<typeof knowledgeBackupLinkSchema>;

export const knowledgeBackupRefSchema = z
  .object({
    entry_content_hash: z.string().trim().min(1).max(128),
    snapshot_title: z.string().max(200),
    favorite: z.boolean().default(false),
    pinned: z.boolean().default(false)
  })
  .strict();
export type KnowledgeBackupRef = z.infer<typeof knowledgeBackupRefSchema>;

// ───────────────────────────── 备份根对象（§3.7，schema_version=1） ─────────────────────────────

export const knowledgeBackupSchema = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal('knowledge-backup'),
    exported_at: timestamp,
    library: z
      .object({
        scope: knowledgeScopeSchema,
        work_id: id.nullable(),
        work_title: z.string().max(200).nullable()
      })
      .strict(),
    entries: z.array(knowledgeBackupEntrySchema).max(KNOWLEDGE_BACKUP_ENTRIES_MAX),
    tags: z.array(knowledgeBackupTagSchema).max(KNOWLEDGE_BACKUP_TAGS_MAX),
    links: z.array(knowledgeBackupLinkSchema).max(KNOWLEDGE_BACKUP_LINKS_MAX),
    refs: z.array(knowledgeBackupRefSchema)
  })
  .strict()
  .superRefine((value, ctx) => {
    // local_id 全局唯一
    const localIds = new Set<string>();
    for (const [index, entry] of value.entries.entries()) {
      if (localIds.has(entry.local_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `local_id 重复：${entry.local_id}`,
          path: ['entries', index, 'local_id']
        });
      }
      localIds.add(entry.local_id);
    }

    // 关联两端必须引用已存在的 local_id（悬空引用拒绝）
    value.links.forEach((link, index) => {
      if (!localIds.has(link.source_local_id) || !localIds.has(link.target_local_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'KNOWLEDGE_BACKUP_DANGLING_LINK',
          path: ['links', index]
        });
      }
      if (link.source_local_id === link.target_local_id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '关联两端不能是同一条目',
          path: ['links', index]
        });
      }
    });
  });
export type KnowledgeBackup = z.infer<typeof knowledgeBackupSchema>;

// 导出固定写 schema_version=1
export const knowledgeBackupExportSchema = knowledgeBackupSchema;
export type KnowledgeBackupExport = KnowledgeBackup;

// ───────────────────────────── 恢复 preview / commit（§4.7） ─────────────────────────────

export const knowledgeRestoreConflictTypeSchema = z.enum(['same_content', 'same_title_diff_content', 'new']);
export type KnowledgeRestoreConflictType = z.infer<typeof knowledgeRestoreConflictTypeSchema>;

export const knowledgeRestoreConflictSchema = z
  .object({
    entry_index: z.number().int().nonnegative(),
    local_id: localId.optional(),
    title: z.string().max(200),
    type: knowledgeRestoreConflictTypeSchema,
    existing_entry_id: id.optional(),
    existing_title: z.string().max(200).optional()
  })
  .strict();
export type KnowledgeRestoreConflict = z.infer<typeof knowledgeRestoreConflictSchema>;

export const knowledgeRestoreSummarySchema = z
  .object({
    total: z.number().int().nonnegative(),
    same_content: z.number().int().nonnegative(),
    same_title_diff_content: z.number().int().nonnegative(),
    new: z.number().int().nonnegative()
  })
  .strict();
export type KnowledgeRestoreSummary = z.infer<typeof knowledgeRestoreSummarySchema>;

export const knowledgeRestorePreviewResponseSchema = z
  .object({
    preview_id: id,
    file_name: z.string().trim().min(1).max(255),
    uncompressed_bytes: z.number().int().nonnegative(),
    summary: knowledgeRestoreSummarySchema,
    conflicts: z.array(knowledgeRestoreConflictSchema)
  })
  .strict();
export type KnowledgeRestorePreviewResponse = z.infer<typeof knowledgeRestorePreviewResponseSchema>;

export const knowledgeRestoreResolutionSchema = z
  .object({
    entry_index: z.number().int().nonnegative(),
    action: knowledgeConflictPolicySchema
  })
  .strict();
export type KnowledgeRestoreResolution = z.infer<typeof knowledgeRestoreResolutionSchema>;

export const knowledgeRestoreCommitRequestSchema = z
  .object({
    preview_id: id,
    policy: knowledgeConflictPolicySchema,
    resolutions: z.array(knowledgeRestoreResolutionSchema).optional(),
    idempotency_key: z.string().trim().min(1).max(128).optional()
  })
  .strict();
export type KnowledgeRestoreCommitRequest = z.infer<typeof knowledgeRestoreCommitRequestSchema>;

// ───────────────────────────── 恢复统计 / 备份请求（§4.7） ─────────────────────────────

export const knowledgeBackupCreateRequestSchema = z
  .object({
    scope: knowledgeScopeSchema,
    work_id: id.optional()
  })
  .strict();
export type KnowledgeBackupCreateRequest = z.infer<typeof knowledgeBackupCreateRequestSchema>;

export const knowledgeRestoreResultSchema = z
  .object({
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative()
  })
  .strict();
export type KnowledgeRestoreResult = z.infer<typeof knowledgeRestoreResultSchema>;
