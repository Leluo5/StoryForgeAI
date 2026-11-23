import { z } from 'zod';

// 复用基础 schema（对齐 agent-config.ts 风格）
const id = z.string().uuid();
const timestamp = z.string().datetime();

// ───────────────────────────── 枚举 ─────────────────────────────

// 知识条目类型（对齐旧 F5 §2.1）
export const knowledgeTypeSchema = z.enum(['article', 'paper', 'novel', 'inspiration']);
export type KnowledgeType = z.infer<typeof knowledgeTypeSchema>;

// 录入来源
export const knowledgeSourceSchema = z.enum(['paste', 'manual', 'upload', 'ocr', 'import']);
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;

// 录入时允许的类型：auto 表示由 LLM 自动识别，其余为手动指定
export const knowledgeEntryTypeInputSchema = z.enum(['auto', 'article', 'paper', 'novel', 'inspiration']);
export type KnowledgeEntryTypeInput = z.infer<typeof knowledgeEntryTypeInputSchema>;

// 关联类型
export const knowledgeLinkTypeSchema = z.enum(['reference', 'inspiration', 'conflict']);
export type KnowledgeLinkType = z.infer<typeof knowledgeLinkTypeSchema>;

// Markdown 导出模式
export const knowledgeExportModeSchema = z.enum(['single', 'batch', 'by_type', 'by_tag']);
export type KnowledgeExportMode = z.infer<typeof knowledgeExportModeSchema>;

// Markdown 导入冲突策略
export const knowledgeConflictStrategySchema = z.enum(['overwrite', 'rename', 'skip']);
export type KnowledgeConflictStrategy = z.infer<typeof knowledgeConflictStrategySchema>;

// ───────────────────────────── 结构化结果（按类型异构，jsonb 语义） ─────────────────────────────

// article：段落 + 要点 + 摘要 + 标签
export const articleStructuredSchema = z.object({
  paragraphs: z.array(z.string()),
  key_points: z.array(z.string()),
  summary: z.string(),
  tag_list: z.array(z.string())
});
export type ArticleStructured = z.infer<typeof articleStructuredSchema>;

// paper：五要素卡片
export const paperStructuredSchema = z.object({
  research_question: z.string(),
  research_method: z.string(),
  core_conclusion: z.string(),
  limitation: z.string(),
  design_insight: z.string()
});
export type PaperStructured = z.infer<typeof paperStructuredSchema>;

// novel 四维度大纲
export const outlineChaptersSchema = z.object({
  title: z.string(),
  summary: z.string(),
  order: z.number().int().positive()
});
export const outlinePlotNodesSchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.enum(['main', 'branch', 'turn'])
});
export const outlineCharacterRelationsSchema = z.object({
  a: z.string(),
  b: z.string(),
  relation: z.string(),
  camp: z.string().optional()
});
export const outlineCoreStorylinesSchema = z.object({
  main: z.string(),
  branches: z.array(z.string()),
  hidden: z.array(z.string())
});
export const novelOutlineSchema = z.object({
  chapters: z.array(outlineChaptersSchema),
  plot_nodes: z.array(outlinePlotNodesSchema),
  character_relations: z.array(outlineCharacterRelationsSchema),
  core_storylines: outlineCoreStorylinesSchema
});
export type NovelOutline = z.infer<typeof novelOutlineSchema>;

// novel：拆文四要素 + 大纲
export const novelStructuredSchema = z.object({
  characters: z.array(z.string()),
  plot_lines: z.array(z.string()),
  narrative_style: z.array(z.string()),
  world_setting: z.string(),
  outline: novelOutlineSchema.optional()
});
export type NovelStructured = z.infer<typeof novelStructuredSchema>;

// inspiration：原始 + 补充 + 关联
export const inspirationStructuredSchema = z.object({
  raw_text: z.string(),
  enriched_text: z.string(),
  related_ids: z.array(id)
});
export type InspirationStructured = z.infer<typeof inspirationStructuredSchema>;

// 结构化结果整体：按类型异构。业务层在 commit 时按 type 精确校验，
// 此处允许 record 以便承载任意 type 的 structured（jsonb 语义）。
export const knowledgeStructuredSchema = z.record(z.unknown());
export type KnowledgeStructured = z.infer<typeof knowledgeStructuredSchema>;

// ───────────────────────────── 核心实体 ─────────────────────────────

// 知识条目（对齐 database/knowledge-entry.entity.ts）
export const knowledgeEntrySchema = z.object({
  id,
  author_id: id,
  type: knowledgeTypeSchema,
  title: z.string().min(1).max(200),
  source: knowledgeSourceSchema,
  raw_content: z.string(),
  structured: knowledgeStructuredSchema,
  tags: z.array(z.string().min(1).max(40)).max(20),
  links: z.array(id),
  content_hash: z.string().length(64),
  created_at: timestamp,
  updated_at: timestamp
});
export type KnowledgeEntry = z.infer<typeof knowledgeEntrySchema>;

// 列表项（检索结果精简）
export const knowledgeEntryListItemSchema = z.object({
  id,
  type: knowledgeTypeSchema,
  title: z.string().min(1).max(200),
  tags: z.array(z.string().min(1).max(40)).max(20),
  created_at: timestamp
});
export type KnowledgeEntryListItem = z.infer<typeof knowledgeEntryListItemSchema>;

// ───────────────────────────── 请求 Schema ─────────────────────────────

// 统一录入（生成预览，不落库）
export const createKnowledgeEntryRequestSchema = z.object({
  source: knowledgeSourceSchema,
  type: knowledgeEntryTypeInputSchema,
  title: z.string().min(1).max(200).optional(),
  raw_content: z.string().min(1).max(200000)
});
export type CreateKnowledgeEntryRequest = z.infer<typeof createKnowledgeEntryRequestSchema>;

// 确认入库（预览编辑后提交结构化结果）
// 前端在 createPreview 拿到 preview 后，把 preview 骨架（type/title/source/raw_content）
// 连同编辑后的 structured/tags/links 一起提交，保证无状态、幂等入库。
export const commitKnowledgeEntryRequestSchema = z.object({
  type: knowledgeTypeSchema,
  title: z.string().min(1).max(200),
  source: knowledgeSourceSchema,
  raw_content: z.string().min(1).max(200000),
  structured: knowledgeStructuredSchema,
  tags: z.array(z.string().min(1).max(40)).max(20),
  links: z.array(id).max(50)
});
export type CommitKnowledgeEntryRequest = z.infer<typeof commitKnowledgeEntryRequestSchema>;

// 编辑条目
export const updateKnowledgeEntryRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  structured: knowledgeStructuredSchema.optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  links: z.array(id).max(50).optional()
});
export type UpdateKnowledgeEntryRequest = z.infer<typeof updateKnowledgeEntryRequestSchema>;

// 建立关联
export const linkKnowledgeRequestSchema = z.object({
  target_id: id,
  type: knowledgeLinkTypeSchema
});
export type LinkKnowledgeRequest = z.infer<typeof linkKnowledgeRequestSchema>;

// 大纲自动提取
export const extractOutlineRequestSchema = z.object({
  novel_id: id
});
export type ExtractOutlineRequest = z.infer<typeof extractOutlineRequestSchema>;

// 统一检索
export const searchKnowledgeRequestSchema = z.object({
  keyword: z.string().max(200).optional(),
  type: knowledgeTypeSchema.optional(),
  tag: z.string().max(40).optional(),
  start_time: timestamp.optional(),
  end_time: timestamp.optional(),
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().positive().max(100).default(20)
});
export type SearchKnowledgeRequest = z.infer<typeof searchKnowledgeRequestSchema>;

// 检索响应
export const searchKnowledgeResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  items: z.array(knowledgeEntryListItemSchema)
});
export type SearchKnowledgeResponse = z.infer<typeof searchKnowledgeResponseSchema>;

// ───────────────────────────── Markdown 导入导出 ─────────────────────────────

// 导出请求
export const exportKnowledgeMarkdownRequestSchema = z.object({
  mode: knowledgeExportModeSchema,
  entry_ids: z.array(id).max(100).optional(),
  type: knowledgeTypeSchema.optional(),
  tag: z.string().max(40).optional()
});
export type ExportKnowledgeMarkdownRequest = z.infer<typeof exportKnowledgeMarkdownRequestSchema>;

// 导出响应（single：单文件内容；batch/by_type/by_tag：ZIP base64 + 统计）
export const exportKnowledgeMarkdownResponseSchema = z.object({
  mode: knowledgeExportModeSchema,
  file_name: z.string().optional(),
  content: z.string().optional(),
  zip_base64: z.string().optional(),
  total: z.number().int().nonnegative(),
  summary: z.array(z.string()).optional()
});
export type ExportKnowledgeMarkdownResponse = z.infer<typeof exportKnowledgeMarkdownResponseSchema>;

// 导入预览条目
export const importPreviewItemSchema = z.object({
  file_name: z.string(),
  title: z.string(),
  type: knowledgeTypeSchema,
  content: z.string(),
  conflict: z.enum(['identical', 'name_collision', 'new'])
});
export type ImportPreviewItem = z.infer<typeof importPreviewItemSchema>;

// 导入预览请求
export const importKnowledgePreviewRequestSchema = z.object({
  files: z.array(z.object({ file_name: z.string(), content: z.string() })).min(1).max(50),
  target_type: knowledgeTypeSchema
});
export type ImportKnowledgePreviewRequest = z.infer<typeof importKnowledgePreviewRequestSchema>;

// 导入预览响应
export const importKnowledgePreviewResponseSchema = z.object({
  items: z.array(importPreviewItemSchema)
});
export type ImportKnowledgePreviewResponse = z.infer<typeof importKnowledgePreviewResponseSchema>;

// 确认导入
export const importKnowledgeRequestSchema = z.object({
  items: z.array(z.object({ file_name: z.string(), title: z.string(), type: knowledgeTypeSchema, content: z.string() })).min(1).max(50),
  target_type: knowledgeTypeSchema,
  conflict_strategy: knowledgeConflictStrategySchema
});
export type ImportKnowledgeRequest = z.infer<typeof importKnowledgeRequestSchema>;

// 导入结果
export const importKnowledgeResultSchema = z.object({
  total: z.number().int().nonnegative(),
  success: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  failed_items: z.array(z.object({ file_name: z.string(), reason: z.string() })),
  created: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative()
});
export type ImportKnowledgeResult = z.infer<typeof importKnowledgeResultSchema>;

// 单文件格式校验
export const validateKnowledgeMarkdownRequestSchema = z.object({
  file_name: z.string(),
  content: z.string()
});
export type ValidateKnowledgeMarkdownRequest = z.infer<typeof validateKnowledgeMarkdownRequestSchema>;

export const validateKnowledgeMarkdownResponseSchema = z.object({
  valid: z.boolean(),
  reason: z.string().optional()
});
export type ValidateKnowledgeMarkdownResponse = z.infer<typeof validateKnowledgeMarkdownResponseSchema>;
