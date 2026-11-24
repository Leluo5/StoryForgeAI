import { z } from 'zod';

// F4 作者级站点设置契约（站点信息 / LLM 配置 / 平台凭据）。
// 用户明确选择「完整入库含 api_key/pat」——打破新架构「敏感凭据禁止入库」约束，对齐旧架构完整功能，风险由用户权衡接受。
// 作用域为作者级：每个作者一条 site_config，作者登录即可访问自己的后台，无独立认证。

// ───────────────────────────── LLM 配置（完整含 api_key） ─────────────────────────────

export const llmConfigSchema = z
  .object({
    base_url: z.string().trim().min(1).max(500).optional(),
    api_key: z.string().trim().min(1).max(500).optional(),
    model: z.string().trim().min(1).max(200).optional()
  })
  .default({});
export type LlmConfig = z.infer<typeof llmConfigSchema>;

// ───────────────────────────── 平台凭据（作者级，消费方优先读取） ─────────────────────────────

export const cozeCredentialsSchema = z
  .object({
    base_url: z.string().trim().min(1).max(500).optional(),
    pat: z.string().trim().min(1).max(1000).optional()
  })
  .default({});
export const flowiseCredentialsSchema = z
  .object({
    base_url: z.string().trim().min(1).max(500).optional(),
    api_key: z.string().trim().min(1).max(1000).optional()
  })
  .default({});
export const fastgptCredentialsSchema = z
  .object({
    base_url: z.string().trim().min(1).max(500).optional(),
    api_key: z.string().trim().min(1).max(1000).optional(),
    dataset_id: z.string().trim().min(1).max(200).optional()
  })
  .default({});
export const n8nCredentialsSchema = z
  .object({
    webhook_url: z.string().trim().min(1).max(500).optional(),
    token: z.string().trim().min(1).max(1000).optional()
  })
  .default({});

export const platformCredentialsSchema = z
  .object({
    coze: cozeCredentialsSchema.optional(),
    flowise: flowiseCredentialsSchema.optional(),
    fastgpt: fastgptCredentialsSchema.optional(),
    n8n: n8nCredentialsSchema.optional()
  })
  .default({});
export type PlatformCredentials = z.infer<typeof platformCredentialsSchema>;

// ───────────────────────────── 站点设置响应（完整含 api_key/pat） ─────────────────────────────

export const siteConfigResponseSchema = z.object({
  site_name: z.string().trim().min(1).max(120),
  site_description: z.string().max(2000),
  theme: z.enum(['light', 'dark']),
  llm_config: llmConfigSchema,
  platform_credentials: platformCredentialsSchema
});
export type SiteConfigResponse = z.infer<typeof siteConfigResponseSchema>;

export const getSiteConfigResponseSchema = z.object({
  config: siteConfigResponseSchema
});
export type GetSiteConfigResponse = z.infer<typeof getSiteConfigResponseSchema>;

// ───────────────────────────── 站点设置更新请求（各字段可选，至少一项；嵌套对象允许部分更新） ─────────────────────────────

// 更新用嵌套 schema：对「对象形状」做 .partial()（在 .default() 之前的纯对象上），允许部分字段更新
const llmConfigShape = z.object({
  base_url: z.string().trim().min(1).max(500).optional(),
  api_key: z.string().trim().min(1).max(500).optional(),
  model: z.string().trim().min(1).max(200).optional()
});
const cozeCredentialsShape = z.object({
  base_url: z.string().trim().min(1).max(500).optional(),
  pat: z.string().trim().min(1).max(1000).optional()
});
const flowiseCredentialsShape = z.object({
  base_url: z.string().trim().min(1).max(500).optional(),
  api_key: z.string().trim().min(1).max(1000).optional()
});
const fastgptCredentialsShape = z.object({
  base_url: z.string().trim().min(1).max(500).optional(),
  api_key: z.string().trim().min(1).max(1000).optional(),
  dataset_id: z.string().trim().min(1).max(200).optional()
});
const n8nCredentialsShape = z.object({
  webhook_url: z.string().trim().min(1).max(500).optional(),
  token: z.string().trim().min(1).max(1000).optional()
});
const platformCredentialsShape = z.object({
  coze: cozeCredentialsShape.optional(),
  flowise: flowiseCredentialsShape.optional(),
  fastgpt: fastgptCredentialsShape.optional(),
  n8n: n8nCredentialsShape.optional()
});

export const updateSiteConfigRequestSchema = z
  .object({
    site_name: z.string().trim().min(1).max(120).optional(),
    site_description: z.string().max(2000).optional(),
    theme: z.enum(['light', 'dark']).optional(),
    llm_config: llmConfigShape.partial().optional(),
    platform_credentials: platformCredentialsShape.partial().optional()
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一项待更新字段' });
export type UpdateSiteConfigRequest = z.infer<typeof updateSiteConfigRequestSchema>;
