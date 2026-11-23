import { z } from 'zod';

// ============================================================================
// M3c-3 知识库契约（v1.1 双层库口径）
//
// 本文件对应 F2 §3.1~§3.5、§4.8、§5.6：
//   - 枚举与关键结构（§3.2）
//   - 实体与受控字段（§3.3）
//   - 请求 Schema（§3.4）
//   - 结构化结果 discriminated union（§3.5）
//   - 错误码约定（§4.8，T04）
//   - 游标编码纯函数（§5.6，T04）
//
// 兼容性说明：旧一代单表口径（12 端点、preview/commit 两段式）的导出符号被
// 旧前端（apps/web/src/knowledge/knowledge-client.ts）与旧 service
// （apps/api/src/knowledge/knowledge.controller.ts）引用。按用户决策保留旧
// 端点为兼容别名一个版本——契约层旧符号与新符号语义冲突的，保留旧符号并以
// `@deprecated` 标注、导出名不变，同时新增 v1.1 符号。
// ============================================================================

// ───────────────────────────── 基础复用 ─────────────────────────────

const id = z.string().uuid();
const timestamp = z.string().datetime();

// 字段长度上限（与 DB 一致，前端计数器保持一致，见 §3.5）
export const KNOWLEDGE_TITLE_MAX = 200;
export const KNOWLEDGE_SECTION_CONTENT_MAX = 20_000;
export const KNOWLEDGE_POINT_MAX = 200;
export const KNOWLEDGE_TAG_NAME_MAX = 40;
export const KNOWLEDGE_TAG_COUNT_MAX = 20;
export const KNOWLEDGE_EXCERPT_MAX = 160;
export const KNOWLEDGE_KEYWORD_MAX = 80;
export const KNOWLEDGE_TEXT_MAX_CHARS = 20_000_000; // 创建 text 上限 20 MB 字符
export const KNOWLEDGE_REF_TARGET_MAX = 50; // 批量引用上限
export const KNOWLEDGE_LINK_MAX = 50; // 关联列表上限

// ───────────────────────────── 枚举（§3.2） ─────────────────────────────

// 库作用域：全局库 / 作品库
export const knowledgeScopeSchema = z.enum(['global', 'work']);
export type KnowledgeScope = z.infer<typeof knowledgeScopeSchema>;

// 条目类型：article | paper | novel | inspiration | setting（五类，含 setting）
export const knowledgeEntryTypeSchema = z.enum(['article', 'paper', 'novel', 'inspiration', 'setting']);
export type KnowledgeEntryType = z.infer<typeof knowledgeEntryTypeSchema>;

// 结构化状态：pending | structuring | ready | failed
export const knowledgeStructureStatusSchema = z.enum(['pending', 'structuring', 'ready', 'failed']);
export type KnowledgeStructureStatus = z.infer<typeof knowledgeStructureStatusSchema>;

// 大纲状态：pending | ready | failed
export const knowledgeOutlineStatusSchema = z.enum(['pending', 'ready', 'failed']);
export type KnowledgeOutlineStatus = z.infer<typeof knowledgeOutlineStatusSchema>;

// 录入来源：manual | upload | markdown_import | backup | ref_copy
export const knowledgeOriginSchema = z.enum(['manual', 'upload', 'markdown_import', 'backup', 'ref_copy']);
export type KnowledgeOrigin = z.infer<typeof knowledgeOriginSchema>;

// 引用状态：active | source_deleted | invalid
export const knowledgeRefStatusSchema = z.enum(['active', 'source_deleted', 'invalid']);
export type KnowledgeRefStatus = z.infer<typeof knowledgeRefStatusSchema>;

// 关联类型：manual | inspiration_auto
export const knowledgeLinkKindSchema = z.enum(['manual', 'inspiration_auto']);
export type KnowledgeLinkKind = z.infer<typeof knowledgeLinkKindSchema>;

// 冲突策略：overwrite | rename | skip
export const knowledgeConflictPolicySchema = z.enum(['overwrite', 'rename', 'skip']);
export type KnowledgeConflictPolicy = z.infer<typeof knowledgeConflictPolicySchema>;

// 检索时间字段：created_at | updated_at
export const knowledgeTimeFieldSchema = z.enum(['created_at', 'updated_at']);
export type KnowledgeTimeField = z.infer<typeof knowledgeTimeFieldSchema>;

// 条目视图：entry（全局/作品自有条目）| reference（作品库引用）
export const knowledgeEntryViewSchema = z.enum(['entry', 'reference']);
export type KnowledgeEntryView = z.infer<typeof knowledgeEntryViewSchema>;

// ───────────────────────────── 结构化结果（§3.5） ─────────────────────────────
// 全部 `.strict()`，未知字段拒绝；文本长度上限与 DB 一致。

const knowledgeSectionSchema = z
  .object({
    heading: z.string().trim().min(1).max(KNOWLEDGE_TITLE_MAX),
    content: z.string().max(KNOWLEDGE_SECTION_CONTENT_MAX)
  })
  .strict();

// article：分段 + 核心观点 + 标签清单
export const articleStructuredSchema = z
  .object({
    sections: z.array(knowledgeSectionSchema).max(100).default([]),
    key_points: z.array(z.string().trim().max(KNOWLEDGE_POINT_MAX)).max(50).default([]),
    tags: z.array(z.string().trim().max(KNOWLEDGE_TAG_NAME_MAX)).max(KNOWLEDGE_TAG_COUNT_MAX).default([])
  })
  .strict();
// v1.1 类型名带 `Knowledge` 前缀：旧一代 `ArticleStructured` 等类型名保留旧形状（@deprecated），
// 避免与旧前端 / 旧 service 的 `import type { ArticleStructured }` 冲突。
export type KnowledgeArticleStructured = z.infer<typeof articleStructuredSchema>;

// setting：设定集复用文章结构（D05）
export const settingStructuredSchema = articleStructuredSchema;
export type SettingStructured = z.infer<typeof settingStructuredSchema>;

// paper：五要素卡片 + 关键词
export const paperStructuredSchema = z
  .object({
    research_question: z.string().max(KNOWLEDGE_SECTION_CONTENT_MAX),
    method: z.string().max(KNOWLEDGE_SECTION_CONTENT_MAX),
    findings: z.string().max(KNOWLEDGE_SECTION_CONTENT_MAX),
    contributions: z.string().max(KNOWLEDGE_SECTION_CONTENT_MAX),
    limitations: z.string().max(KNOWLEDGE_SECTION_CONTENT_MAX),
    keywords: z.array(z.string().trim().max(KNOWLEDGE_POINT_MAX)).max(KNOWLEDGE_TAG_COUNT_MAX).default([])
  })
  .strict();
export type KnowledgePaperStructured = z.infer<typeof paperStructuredSchema>;

const novelCharacterSchema = z
  .object({
    name: z.string().trim().min(1).max(KNOWLEDGE_TITLE_MAX),
    role: z.string().trim().max(KNOWLEDGE_TITLE_MAX),
    description: z.string().max(KNOWLEDGE_SECTION_CONTENT_MAX)
  })
  .strict();

// novel：角色、情节、叙事风格、世界观
export const novelStructuredSchema = z
  .object({
    characters: z.array(novelCharacterSchema).max(200).default([]),
    plot_summary: z.string().max(KNOWLEDGE_SECTION_CONTENT_MAX),
    narrative_style: z.string().max(KNOWLEDGE_TITLE_MAX),
    worldview: z.string().max(KNOWLEDGE_SECTION_CONTENT_MAX)
  })
  .strict();
export type KnowledgeNovelStructured = z.infer<typeof novelStructuredSchema>;

// inspiration：原文 + 上下文补全 + 匹配结果
export const inspirationStructuredSchema = z
  .object({
    completion: z.string().max(KNOWLEDGE_SECTION_CONTENT_MAX),
    matched_entry_ids: z.array(id).max(3).default([]),
    independent: z.boolean()
  })
  .strict();
export type KnowledgeInspirationStructured = z.infer<typeof inspirationStructuredSchema>;

// 结构化结果整体：按 entry_type 判别（§3.5「用 z.discriminatedUnion('entry_type', [...])」）。
// 每个分支在纯结构基础上追加 `entry_type` 判别字段，全部 `.strict()`。
export const knowledgeStructuredSchema = z.discriminatedUnion('entry_type', [
  articleStructuredSchema.extend({ entry_type: z.literal('article') }).strict(),
  settingStructuredSchema.extend({ entry_type: z.literal('setting') }).strict(),
  paperStructuredSchema.extend({ entry_type: z.literal('paper') }).strict(),
  novelStructuredSchema.extend({ entry_type: z.literal('novel') }).strict(),
  inspirationStructuredSchema.extend({ entry_type: z.literal('inspiration') }).strict()
]);
export type KnowledgeEntryStructured = z.infer<typeof knowledgeStructuredSchema>;

// ───────────────────────────── 大纲（§3.5 末，独立于 structured） ─────────────────────────────

export const knowledgeOutlineChapterSchema = z
  .object({
    title: z.string().trim().min(1).max(KNOWLEDGE_TITLE_MAX),
    summary: z.string().max(KNOWLEDGE_SECTION_CONTENT_MAX)
  })
  .strict();

export const knowledgeOutlinePlotNodeSchema = z
  .object({
    title: z.string().trim().min(1).max(KNOWLEDGE_TITLE_MAX),
    summary: z.string().max(KNOWLEDGE_SECTION_CONTENT_MAX),
    chapter_index: z.number().int().nonnegative()
  })
  .strict();

export const knowledgeOutlineCharacterRelationSchema = z
  .object({
    source: z.string().trim().min(1).max(KNOWLEDGE_TITLE_MAX),
    target: z.string().trim().min(1).max(KNOWLEDGE_TITLE_MAX),
    relation: z.string().trim().max(KNOWLEDGE_TITLE_MAX)
  })
  .strict();

export const knowledgeOutlineStoryLineSchema = z
  .object({
    name: z.string().trim().min(1).max(KNOWLEDGE_TITLE_MAX),
    description: z.string().max(KNOWLEDGE_SECTION_CONTENT_MAX),
    chapter_indexes: z.array(z.number().int().nonnegative()).max(200).default([])
  })
  .strict();

// 四维大纲：章节、情节节点、人物关系、故事线
export const knowledgeOutlineSchema = z
  .object({
    chapters: z.array(knowledgeOutlineChapterSchema).max(500).default([]),
    plot_nodes: z.array(knowledgeOutlinePlotNodeSchema).max(500).default([]),
    character_relations: z.array(knowledgeOutlineCharacterRelationSchema).max(500).default([]),
    story_lines: z.array(knowledgeOutlineStoryLineSchema).max(20).default([])
  })
  .strict();
export type KnowledgeEntryOutline = z.infer<typeof knowledgeOutlineSchema>;

// ───────────────────────────── 实体（§3.3） ─────────────────────────────

const knowledgeTagNameSchema = z.string().trim().min(1).max(KNOWLEDGE_TAG_NAME_MAX);
const knowledgeTagsSchema = z.array(knowledgeTagNameSchema).max(KNOWLEDGE_TAG_COUNT_MAX);

// 条目摘要（列表 / 检索结果）
export const knowledgeEntrySummarySchema = z
  .object({
    kind: knowledgeEntryViewSchema,
    id,
    ref_id: id.optional(),
    entry_type: knowledgeEntryTypeSchema,
    title: z.string().max(KNOWLEDGE_TITLE_MAX),
    excerpt: z.string().max(KNOWLEDGE_EXCERPT_MAX),
    tags: z.array(knowledgeTagNameSchema).max(KNOWLEDGE_TAG_COUNT_MAX),
    structure_status: knowledgeStructureStatusSchema,
    outline_status: knowledgeOutlineStatusSchema.optional(),
    favorite: z.boolean(),
    pinned: z.boolean(),
    ref_status: knowledgeRefStatusSchema.optional(),
    created_at: timestamp,
    updated_at: timestamp
  })
  .strict();
export type KnowledgeEntrySummary = z.infer<typeof knowledgeEntrySummarySchema>;

// 条目详情（含原文、结构化、大纲、版本；详情接口才返回 original_text）
export const knowledgeEntryDetailSchema = knowledgeEntrySummarySchema
  .extend({
    original_text: z.string(),
    structured: knowledgeStructuredSchema.nullable(),
    outline: knowledgeOutlineSchema.nullable(),
    version: z.number().int().nonnegative(),
    content_hash: z.string(),
    source_entry_id: id.optional()
  })
  .strict();
export type KnowledgeEntryDetail = z.infer<typeof knowledgeEntryDetailSchema>;

// 标签
export const knowledgeTagSchema = z
  .object({
    id,
    name: knowledgeTagNameSchema,
    entry_count: z.number().int().nonnegative()
  })
  .strict();
export type KnowledgeTag = z.infer<typeof knowledgeTagSchema>;

// 跨条目关联
export const knowledgeLinkSchema = z
  .object({
    id,
    source_entry_id: id,
    target_entry_id: id,
    kind: knowledgeLinkKindSchema,
    score: z.number().finite().optional(),
    source_title: z.string().max(KNOWLEDGE_TITLE_MAX),
    target_title: z.string().max(KNOWLEDGE_TITLE_MAX),
    created_at: timestamp
  })
  .strict();
export type KnowledgeLink = z.infer<typeof knowledgeLinkSchema>;

// 作品引用（快照）
export const knowledgeRefSchema = z
  .object({
    id,
    entry_id: id.optional(),
    title: z.string().max(KNOWLEDGE_TITLE_MAX),
    entry_type: knowledgeEntryTypeSchema,
    tags: z.array(knowledgeTagNameSchema).max(KNOWLEDGE_TAG_COUNT_MAX),
    excerpt: z.string().max(KNOWLEDGE_EXCERPT_MAX),
    status: knowledgeRefStatusSchema,
    favorite: z.boolean(),
    pinned: z.boolean(),
    created_at: timestamp
  })
  .strict();
export type KnowledgeRef = z.infer<typeof knowledgeRefSchema>;

// ───────────────────────────── 请求 Schema（§3.3 / §3.4） ─────────────────────────────

// 乐观锁版本号
export const knowledgeExpectedVersionSchema = z.number().int().nonnegative().optional();

// 创建条目（粘贴录入，同步建条目 + 入队结构化）
export const knowledgeEntryCreateRequestSchema = z
  .object({
    scope: knowledgeScopeSchema,
    work_id: id.optional(),
    entry_type: knowledgeEntryTypeSchema.optional(),
    title: z.string().max(KNOWLEDGE_TITLE_MAX).optional(),
    text: z.string().min(1).max(KNOWLEDGE_TEXT_MAX_CHARS),
    tags: knowledgeTagsSchema.optional(),
    allow_structure: z.boolean().optional()
  })
  .strict();
export type KnowledgeEntryCreateRequest = z.infer<typeof knowledgeEntryCreateRequestSchema>;

// 修改条目（乐观锁；structured / outline 为受控结构）
export const knowledgeEntryPatchRequestSchema = z
  .object({
    title: z.string().max(KNOWLEDGE_TITLE_MAX).optional(),
    original_text: z.string().optional(),
    structured: knowledgeStructuredSchema.optional(),
    outline: knowledgeOutlineSchema.optional(),
    entry_type: knowledgeEntryTypeSchema.optional(),
    tags: knowledgeTagsSchema.optional(),
    expected_version: knowledgeExpectedVersionSchema,
    context_work_id: id.optional()
  })
  .strict();
export type KnowledgeEntryPatchRequest = z.infer<typeof knowledgeEntryPatchRequestSchema>;

// 检索 / 列表（四维 + 时间字段切换 + 收藏置顶 + 回收站 + 游标分页）
export const knowledgeSearchQuerySchema = z
  .object({
    scope: knowledgeScopeSchema,
    work_id: id.optional(),
    keyword: z.string().max(KNOWLEDGE_KEYWORD_MAX).optional(),
    types: z.array(knowledgeEntryTypeSchema).optional(),
    tag_ids: z.array(id).max(KNOWLEDGE_TAG_COUNT_MAX).optional(),
    time_field: knowledgeTimeFieldSchema.default('created_at'),
    time_from: timestamp.optional(),
    time_to: timestamp.optional(),
    favorite: z.boolean().optional(),
    pinned: z.boolean().optional(),
    deleted: z.boolean().optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50)
  })
  .strict();
export type KnowledgeSearchQuery = z.infer<typeof knowledgeSearchQuerySchema>;

// 检索响应（游标分页；空结果 total=0、next_cursor=null）
export const knowledgeSearchResponseSchema = z
  .object({
    items: z.array(knowledgeEntrySummarySchema),
    total: z.number().int().nonnegative(),
    next_cursor: z.string().nullable()
  })
  .strict();
export type KnowledgeSearchResponse = z.infer<typeof knowledgeSearchResponseSchema>;

// 标签操作：新建 / 重命名
export const knowledgeTagRequestSchema = z
  .object({
    scope: knowledgeScopeSchema,
    work_id: id.optional(),
    name: knowledgeTagNameSchema
  })
  .strict();
export type KnowledgeTagRequest = z.infer<typeof knowledgeTagRequestSchema>;

// 收藏 / 置顶
export const knowledgeFlagsRequestSchema = z
  .object({
    favorite: z.boolean().optional(),
    pinned: z.boolean().optional()
  })
  .strict();
export type KnowledgeFlagsRequest = z.infer<typeof knowledgeFlagsRequestSchema>;

// 手动关联
export const knowledgeLinkCreateRequestSchema = z
  .object({
    source_entry_id: id,
    target_entry_id: id
  })
  .strict();
export type KnowledgeLinkCreateRequest = z.infer<typeof knowledgeLinkCreateRequestSchema>;

// 批量引用全局条目
export const knowledgeRefCreateRequestSchema = z
  .object({
    entry_ids: z.array(id).min(1).max(KNOWLEDGE_REF_TARGET_MAX)
  })
  .strict();
export type KnowledgeRefCreateRequest = z.infer<typeof knowledgeRefCreateRequestSchema>;

// 另存为作品副本
export const knowledgeRefCopyRequestSchema = z
  .object({
    keep_ref: z.boolean().optional(),
    title: z.string().max(KNOWLEDGE_TITLE_MAX).optional()
  })
  .strict();
export type KnowledgeRefCopyRequest = z.infer<typeof knowledgeRefCopyRequestSchema>;

// 彻底删除
export const knowledgeEntryPurgeRequestSchema = z
  .object({
    confirm: z.literal(true)
  })
  .strict();
export type KnowledgeEntryPurgeRequest = z.infer<typeof knowledgeEntryPurgeRequestSchema>;

// ───────────────────────────── 错误码约定（§4.8，T04） ─────────────────────────────

export const knowledgeErrorCode = {
  // 409 业务冲突
  KNOWLEDGE_ENTRY_DUPLICATE: 'KNOWLEDGE_ENTRY_DUPLICATE',
  KNOWLEDGE_VERSION_CONFLICT: 'KNOWLEDGE_VERSION_CONFLICT',
  KNOWLEDGE_JOB_RUNNING: 'KNOWLEDGE_JOB_RUNNING',
  KNOWLEDGE_REF_READONLY: 'KNOWLEDGE_REF_READONLY',
  KNOWLEDGE_REF_EXISTS: 'KNOWLEDGE_REF_EXISTS',
  KNOWLEDGE_LINK_EXISTS: 'KNOWLEDGE_LINK_EXISTS',
  KNOWLEDGE_LINK_SELF: 'KNOWLEDGE_LINK_SELF',
  KNOWLEDGE_LINK_CROSS_LIBRARY: 'KNOWLEDGE_LINK_CROSS_LIBRARY',
  KNOWLEDGE_TAG_NAME_EXISTS: 'KNOWLEDGE_TAG_NAME_EXISTS',
  KNOWLEDGE_ENTRY_DELETED: 'KNOWLEDGE_ENTRY_DELETED',
  KNOWLEDGE_ENTRY_NOT_DELETED: 'KNOWLEDGE_ENTRY_NOT_DELETED',
  KNOWLEDGE_ENTRY_REFERENCED: 'KNOWLEDGE_ENTRY_REFERENCED',
  KNOWLEDGE_RESTORE_NEEDS_RESOLUTION: 'KNOWLEDGE_RESTORE_NEEDS_RESOLUTION',
  KNOWLEDGE_BACKUP_VERSION_UNSUPPORTED: 'KNOWLEDGE_BACKUP_VERSION_UNSUPPORTED',
  // 413 文件过大
  KNOWLEDGE_FILE_TOO_LARGE: 'KNOWLEDGE_FILE_TOO_LARGE',
  // 415 文件类型不支持
  KNOWLEDGE_FILE_TYPE_UNSUPPORTED: 'KNOWLEDGE_FILE_TYPE_UNSUPPORTED',
  // 422 校验 / 解析失败
  KNOWLEDGE_TEXT_EMPTY: 'KNOWLEDGE_TEXT_EMPTY',
  KNOWLEDGE_TEXT_TOO_LARGE: 'KNOWLEDGE_TEXT_TOO_LARGE',
  KNOWLEDGE_PARSE_FAILED: 'KNOWLEDGE_PARSE_FAILED',
  KNOWLEDGE_MARKDOWN_INVALID: 'KNOWLEDGE_MARKDOWN_INVALID',
  KNOWLEDGE_BACKUP_INVALID: 'KNOWLEDGE_BACKUP_INVALID',
  KNOWLEDGE_IMPORT_INVALID: 'KNOWLEDGE_IMPORT_INVALID'
} as const;
export type KnowledgeErrorCode = (typeof knowledgeErrorCode)[keyof typeof knowledgeErrorCode];

// ───────────────────────────── 游标编码（§5.6，T04） ─────────────────────────────
// 游标编码 `updated_at + id`，base64url 编码，往返可逆；非法输入返回 `null` 而非抛错。
// 不暴露 SQL 内部格式（`updated_at|id` 分隔符仅内部实现细节）。

const CURSOR_SEP = '|';

function isValidCursorPayload(updatedAt: string, entryId: string): boolean {
  if (typeof updatedAt !== 'string' || typeof entryId !== 'string') return false;
  if (updatedAt.length === 0 || entryId.length === 0) return false;
  // 时间必须是合法 ISO datetime，id 必须是 uuid
  return z.string().datetime().safeParse(updatedAt).success && id.safeParse(entryId).success;
}

/**
 * 编码游标：`encodeCursor(updatedAt, id) -> base64url("updatedAt|id")`。
 * 非法输入返回 `null`。
 */
export function encodeCursor(updatedAt: string, entryId: string): string | null {
  if (!isValidCursorPayload(updatedAt, entryId)) return null;
  const payload = `${updatedAt}${CURSOR_SEP}${entryId}`;
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * 解码游标：`decodeCursor(cursor) -> { updatedAt, id } | null`。
 * 非法 / 格式错误返回 `null` 而非抛错。
 */
export function decodeCursor(cursor: string): { updatedAt: string; id: string } | null {
  if (typeof cursor !== 'string' || cursor.length === 0) return null;
  let payload: string;
  try {
    payload = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const sepIndex = payload.indexOf(CURSOR_SEP);
  if (sepIndex < 0) return null;
  const updatedAt = payload.slice(0, sepIndex);
  const entryId = payload.slice(sepIndex + CURSOR_SEP.length);
  if (!isValidCursorPayload(updatedAt, entryId)) return null;
  return { updatedAt, id: entryId };
}

// ═══════════════════════════════════════════════════════════════════════
// 兼容层：旧一代单表口径符号（被旧前端 / 旧 service 引用）。
// 一个版本后移除。新旧语义冲突的，保留旧符号并 `@deprecated`，新增 v1.1 符号。
// ═══════════════════════════════════════════════════════════════════════

/** @deprecated 旧一代条目类型（4 类）。v1.1 使用 {@link knowledgeEntryTypeSchema}（5 类）。 */
export const knowledgeTypeSchema = z.enum(['article', 'paper', 'novel', 'inspiration']);
/** @deprecated */
export type KnowledgeType = z.infer<typeof knowledgeTypeSchema>;

/** @deprecated 旧一代录入来源。v1.1 使用 {@link knowledgeOriginSchema}。 */
export const knowledgeSourceSchema = z.enum(['paste', 'manual', 'upload', 'ocr', 'import']);
/** @deprecated */
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;

/** @deprecated 旧一代录入类型输入（auto + 4 类）。 */
export const knowledgeEntryTypeInputSchema = z.enum(['auto', 'article', 'paper', 'novel', 'inspiration']);
/** @deprecated */
export type KnowledgeEntryTypeInput = z.infer<typeof knowledgeEntryTypeInputSchema>;

/** @deprecated 旧一代关联类型。v1.1 使用 {@link knowledgeLinkKindSchema}。 */
export const knowledgeLinkTypeSchema = z.enum(['reference', 'inspiration', 'conflict']);
/** @deprecated */
export type KnowledgeLinkType = z.infer<typeof knowledgeLinkTypeSchema>;

/** @deprecated 旧一代 Markdown 导出模式。 */
export const knowledgeExportModeSchema = z.enum(['single', 'batch', 'by_type', 'by_tag']);
/** @deprecated */
export type KnowledgeExportMode = z.infer<typeof knowledgeExportModeSchema>;

/** @deprecated 旧一代冲突策略。语义与 {@link knowledgeConflictPolicySchema} 一致，复用。 */
export const knowledgeConflictStrategySchema = knowledgeConflictPolicySchema;
/** @deprecated */
export type KnowledgeConflictStrategy = z.infer<typeof knowledgeConflictStrategySchema>;

// ───────────────────────────── 旧一代结构化类型（@deprecated，旧形状） ─────────────────────────────
// v1.1 用 `KnowledgeArticleStructured` 等新类型名；旧前端 / 旧 service 以 `import type {
// ArticleStructured, PaperStructured, ... }` 引用，必须保留旧形状一个版本。

/** @deprecated 旧一代 article 结构化。v1.1 使用 {@link KnowledgeArticleStructured}。 */
export type ArticleStructured = {
  paragraphs: string[];
  key_points: string[];
  summary: string;
  tag_list: string[];
};
/** @deprecated 旧一代 paper 结构化。v1.1 使用 {@link KnowledgePaperStructured}。 */
export type PaperStructured = {
  research_question: string;
  research_method: string;
  core_conclusion: string;
  limitation: string;
  design_insight: string;
};
/** @deprecated 旧一代 novel 结构化（含大纲）。v1.1 使用 {@link KnowledgeNovelStructured}。 */
export type NovelStructured = {
  characters: string[];
  plot_lines: string[];
  narrative_style: string[];
  world_setting: string;
  outline?: NovelOutline;
};
/** @deprecated 旧一代 inspiration 结构化。v1.1 使用 {@link KnowledgeInspirationStructured}。 */
export type InspirationStructured = {
  raw_text: string;
  enriched_text: string;
  related_ids: string[];
};
/** @deprecated 旧一代结构化整体（jsonb record 语义）。v1.1 使用 {@link KnowledgeEntryStructured}。 */
export type KnowledgeStructured = Record<string, unknown>;

// ───────────────────────────── 旧一代大纲符号（@deprecated，旧四维形状） ─────────────────────────────

/** @deprecated 旧一代章节节点。v1.1 使用 {@link knowledgeOutlineChapterSchema}。 */
export const outlineChaptersSchema = z.object({
  title: z.string(),
  summary: z.string(),
  order: z.number().int().positive()
});
/** @deprecated 旧一代情节节点。 */
export const outlinePlotNodesSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(['main', 'branch', 'turn'])
});
/** @deprecated 旧一代人物关系。 */
export const outlineCharacterRelationsSchema = z.object({
  a: z.string(),
  b: z.string(),
  relation: z.string(),
  camp: z.string().optional()
});
/** @deprecated 旧一代核心故事线。 */
export const outlineCoreStorylinesSchema = z.object({
  main: z.string(),
  branches: z.array(z.string()),
  hidden: z.array(z.string())
});
/** @deprecated 旧一代 novel 大纲。v1.1 使用 {@link knowledgeOutlineSchema}。 */
export const novelOutlineSchema = z.object({
  chapters: z.array(outlineChaptersSchema),
  plot_nodes: z.array(outlinePlotNodesSchema),
  character_relations: z.array(outlineCharacterRelationsSchema),
  core_storylines: outlineCoreStorylinesSchema
});
/** @deprecated */
export type NovelOutline = z.infer<typeof novelOutlineSchema>;

/** @deprecated 旧一代单表条目（预览/commit 两段式）。v1.1 使用 {@link knowledgeEntryDetailSchema}。 */
export const knowledgeEntrySchema = z.object({
  id,
  author_id: id,
  type: knowledgeTypeSchema,
  title: z.string().min(1).max(KNOWLEDGE_TITLE_MAX),
  source: knowledgeSourceSchema,
  raw_content: z.string(),
  structured: z.record(z.unknown()),
  tags: z.array(z.string().min(1).max(KNOWLEDGE_TAG_NAME_MAX)).max(KNOWLEDGE_TAG_COUNT_MAX),
  links: z.array(id),
  content_hash: z.string().length(64),
  created_at: timestamp,
  updated_at: timestamp
});
/** @deprecated */
export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema>;

/** @deprecated 旧一代列表项。 */
export const knowledgeEntryListItemSchema = z.object({
  id,
  type: knowledgeTypeSchema,
  title: z.string().min(1).max(KNOWLEDGE_TITLE_MAX),
  tags: z.array(z.string().min(1).max(KNOWLEDGE_TAG_NAME_MAX)).max(KNOWLEDGE_TAG_COUNT_MAX),
  created_at: timestamp
});
/** @deprecated */
export type KnowledgeEntryListItem = z.infer<typeof knowledgeEntryListItemSchema>;

/** @deprecated 旧一代统一录入（生成预览，不落库）。v1.1 使用 {@link knowledgeEntryCreateRequestSchema}。 */
export const createKnowledgeEntryRequestSchema = z.object({
  source: knowledgeSourceSchema,
  type: knowledgeEntryTypeInputSchema,
  title: z.string().min(1).max(KNOWLEDGE_TITLE_MAX).optional(),
  raw_content: z.string().min(1).max(200000)
});
/** @deprecated */
export type CreateKnowledgeEntryRequest = z.infer<typeof createKnowledgeEntryRequestSchema>;

/** @deprecated 旧一代确认入库（预览编辑后提交结构化结果）。 */
export const commitKnowledgeEntryRequestSchema = z.object({
  type: knowledgeTypeSchema,
  title: z.string().min(1).max(KNOWLEDGE_TITLE_MAX),
  source: knowledgeSourceSchema,
  raw_content: z.string().min(1).max(200000),
  structured: z.record(z.unknown()),
  tags: z.array(z.string().min(1).max(KNOWLEDGE_TAG_NAME_MAX)).max(KNOWLEDGE_TAG_COUNT_MAX),
  links: z.array(id).max(KNOWLEDGE_LINK_MAX)
});
/** @deprecated */
export type CommitKnowledgeEntryRequest = z.infer<typeof commitKnowledgeEntryRequestSchema>;

/** @deprecated 旧一代编辑条目。 */
export const updateKnowledgeEntryRequestSchema = z.object({
  title: z.string().min(1).max(KNOWLEDGE_TITLE_MAX).optional(),
  structured: z.record(z.unknown()).optional(),
  tags: z.array(z.string().min(1).max(KNOWLEDGE_TAG_NAME_MAX)).max(KNOWLEDGE_TAG_COUNT_MAX).optional(),
  links: z.array(id).max(KNOWLEDGE_LINK_MAX).optional()
});
/** @deprecated */
export type UpdateKnowledgeEntryRequest = z.infer<typeof updateKnowledgeEntryRequestSchema>;

/** @deprecated 旧一代建立关联。 */
export const linkKnowledgeRequestSchema = z.object({
  target_id: id,
  type: knowledgeLinkTypeSchema
});
/** @deprecated */
export type LinkKnowledgeRequest = z.infer<typeof linkKnowledgeRequestSchema>;

/** @deprecated 旧一代大纲自动提取。 */
export const extractOutlineRequestSchema = z.object({
  novel_id: id
});
/** @deprecated */
export type ExtractOutlineRequest = z.infer<typeof extractOutlineRequestSchema>;

/** @deprecated 旧一代统一检索。 */
export const searchKnowledgeRequestSchema = z.object({
  keyword: z.string().max(KNOWLEDGE_TITLE_MAX).optional(),
  type: knowledgeTypeSchema.optional(),
  tag: z.string().max(KNOWLEDGE_TAG_NAME_MAX).optional(),
  start_time: timestamp.optional(),
  end_time: timestamp.optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(100).default(20)
});
/** @deprecated */
export type SearchKnowledgeRequest = z.infer<typeof searchKnowledgeRequestSchema>;

/** @deprecated 旧一代检索响应。 */
export const searchKnowledgeResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(knowledgeEntryListItemSchema)
});
/** @deprecated */
export type SearchKnowledgeResponse = z.infer<typeof searchKnowledgeResponseSchema>;

/** @deprecated 旧一代 Markdown 导出请求。 */
export const exportKnowledgeMarkdownRequestSchema = z.object({
  mode: knowledgeExportModeSchema,
  entry_ids: z.array(id).max(100).optional(),
  type: knowledgeTypeSchema.optional(),
  tag: z.string().max(KNOWLEDGE_TAG_NAME_MAX).optional()
});
/** @deprecated */
export type ExportKnowledgeMarkdownRequest = z.infer<typeof exportKnowledgeMarkdownRequestSchema>;

/** @deprecated 旧一代 Markdown 导出响应。 */
export const exportKnowledgeMarkdownResponseSchema = z.object({
  mode: knowledgeExportModeSchema,
  file_name: z.string().optional(),
  content: z.string().optional(),
  zip_base64: z.string().optional(),
  total: z.number().int().nonnegative(),
  summary: z.array(z.string()).optional()
});
/** @deprecated */
export type ExportKnowledgeMarkdownResponse = z.infer<typeof exportKnowledgeMarkdownResponseSchema>;

/** @deprecated 旧一代导入预览条目。 */
export const importPreviewItemSchema = z.object({
  file_name: z.string(),
  title: z.string(),
  type: knowledgeTypeSchema,
  content: z.string(),
  conflict: z.enum(['identical', 'name_collision', 'new'])
});
/** @deprecated */
export type ImportPreviewItem = z.infer<typeof importPreviewItemSchema>;

/** @deprecated 旧一代导入预览请求。 */
export const importKnowledgePreviewRequestSchema = z.object({
  files: z.array(z.object({ file_name: z.string(), content: z.string() })).min(1).max(50),
  target_type: knowledgeTypeSchema
});
/** @deprecated */
export type ImportKnowledgePreviewRequest = z.infer<typeof importKnowledgePreviewRequestSchema>;

/** @deprecated 旧一代导入预览响应。 */
export const importKnowledgePreviewResponseSchema = z.object({
  items: z.array(importPreviewItemSchema)
});
/** @deprecated */
export type ImportKnowledgePreviewResponse = z.infer<typeof importKnowledgePreviewResponseSchema>;

/** @deprecated 旧一代确认导入。 */
export const importKnowledgeRequestSchema = z.object({
  items: z
    .array(
      z.object({ file_name: z.string(), title: z.string(), type: knowledgeTypeSchema, content: z.string() })
    )
    .min(1)
    .max(50),
  target_type: knowledgeTypeSchema,
  conflict_strategy: knowledgeConflictStrategySchema
});
/** @deprecated */
export type ImportKnowledgeRequest = z.infer<typeof importKnowledgeRequestSchema>;

/** @deprecated 旧一代导入结果。 */
export const importKnowledgeResultSchema = z.object({
  total: z.number().int().nonnegative(),
  success: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failed_items: z.array(z.object({ file_name: z.string(), reason: z.string() })),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative()
});
/** @deprecated */
export type ImportKnowledgeResult = z.infer<typeof importKnowledgeResultSchema>;

/** @deprecated 旧一代单文件格式校验请求。 */
export const validateKnowledgeMarkdownRequestSchema = z.object({
  file_name: z.string(),
  content: z.string()
});
/** @deprecated */
export type ValidateKnowledgeMarkdownRequest = z.infer<typeof validateKnowledgeMarkdownRequestSchema>;

/** @deprecated 旧一代单文件格式校验响应。 */
export const validateKnowledgeMarkdownResponseSchema = z.object({
  valid: z.boolean(),
  reason: z.string().optional()
});
/** @deprecated */
export type ValidateKnowledgeMarkdownResponse = z.infer<typeof validateKnowledgeMarkdownResponseSchema>;

// 旧一代结构化结果（jsonb 语义）—— 保留为 `@deprecated`，与 v1.1 同名符号语义不同。
// 说明：旧一代 `articleStructuredSchema` / `paperStructuredSchema` / `novelStructuredSchema` /
// `inspirationStructuredSchema` / `novelOutlineSchema` 等仅被旧一代 `knowledge.ts` 内部使用，
// 未被外部引用，v1.1 已按 §3.5 重定义为新语义（同名）。此处不再重复导出旧定义。
