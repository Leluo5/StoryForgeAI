import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────
// F1 · Coze 资源拉取与批量导入契约
// 旧架构（Python）F1：从 Coze 拉取 bot/dataset 列表并批量导入。
// 新架构落点：Coze 智能体 → AgentEntity（platform='coze'），
//             Coze 知识库 → KnowledgeEntryEntity（origin='coze_import'）。
// Coze 工作流本次不做（工作流模块独立，留待后续）。
// ─────────────────────────────────────────────────────────────────────────

export const cozeResourceTypeSchema = z.enum(['bot', 'dataset']);
export type CozeResourceType = z.infer<typeof cozeResourceTypeSchema>;

// 拉取返回的单个资源（列表项，不含正文）
export const cozeResourceItemSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(200),
    description: z.string().max(1000).default(''),
    icon_url: z.string().url().max(500).nullable().default(null),
    type: cozeResourceTypeSchema
  })
  .strict();
export type CozeResourceItem = z.infer<typeof cozeResourceItemSchema>;

// 拉取请求：PAT 可由请求体显式传入（优先），否则回退 site_config/env
export const cozeListResourcesRequestSchema = z.object({
  pat_token: z.string().trim().min(1).max(1000),
  workspace_id: z.string().trim().min(1).max(100).optional()
});
export type CozeListResourcesRequest = z.infer<typeof cozeListResourcesRequestSchema>;

export const cozeListResourcesResponseSchema = z.object({
  resources: z.array(cozeResourceItemSchema)
});
export type CozeListResourcesResponse = z.infer<typeof cozeListResourcesResponseSchema>;

// 导入请求：选中若干资源（id + type），可选作品级（work_id 非空则挂 project_id）
export const cozeImportRequestSchema = z
  .object({
    pat_token: z.string().trim().min(1).max(1000),
    items: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            type: cozeResourceTypeSchema
          })
          .strict()
      )
      .min(1)
      .max(200),
    work_id: z.string().uuid().optional()
  })
  .strict();
export type CozeImportRequest = z.infer<typeof cozeImportRequestSchema>;

// 导入结果：逐项成败 + 汇总
export const cozeImportResultItemSchema = z
  .object({
    success: z.boolean(),
    id: z.string(),
    name: z.string(),
    type: cozeResourceTypeSchema,
    error: z.string().nullable().default(null)
  })
  .strict();
export type CozeImportResultItem = z.infer<typeof cozeImportResultItemSchema>;

export const cozeImportResponseSchema = z.object({
  total: z.number().int().nonnegative(),
  imported: z.number().int().nonnegative(),
  results: z.array(cozeImportResultItemSchema)
});
export type CozeImportResponse = z.infer<typeof cozeImportResponseSchema>;
