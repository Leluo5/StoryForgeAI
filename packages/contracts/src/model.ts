import { z } from 'zod';

// ───────────────────────────── 模型管理契约 ─────────────────────────────
// 模型是「作者级 AI 模型选型目录」（静态注册表资源），供 Agent（model_id）与
// 工作流（llm_config.model）选型引用。与 workflow 不同，模型非版本化：
// 采用两态（active/disabled）+ 直接硬删，无归档/版本快照/回滚。

/** 模型状态：两态（静态资源，无 archived） */
export const modelStatusSchema = z.enum(['active', 'disabled']);

/** 模型厂商 */
export const modelProviderSchema = z.enum([
  'openai',
  'anthropic',
  'deepseek',
  'mock',
  'coze',
  'flowise',
  'other'
]);

/** 模型标识格式：字母/数字/点/下划线/连字符，1-80 位 */
export const modelIdSchema = z
  .string()
  .min(1, '模型标识不能为空')
  .max(80, '模型标识不能超过 80 字符')
  .regex(/^[A-Za-z0-9._-]+$/, '模型标识只能包含字母、数字、点、下划线、连字符');

/** 货币代码：3-8 位大写字母 */
export const currencySchema = z
  .string()
  .regex(/^[A-Z]{3,8}$/, '货币代码应为 3-8 位大写字母（如 USD）')
  .default('USD');

/** 价格（元/1K tokens）≥ 0 */
const priceSchema = z.number().nonnegative('价格不能为负数');

/** 模型实体 */
export const modelSchema = z.object({
  id: z.string().uuid(),
  author_id: z.string().uuid(),
  name: z.string().min(1).max(80),
  provider: modelProviderSchema,
  model_id: modelIdSchema,
  context_window: z.number().int().nonnegative(),
  supports_tools: z.boolean(),
  supports_vision: z.boolean(),
  input_price: z.number().nonnegative(),
  output_price: z.number().nonnegative(),
  currency: z.string().regex(/^[A-Z]{3,8}$/),
  status: modelStatusSchema,
  sort_order: z.number().int(),
  created_at: z.string(),
  updated_at: z.string()
});

/** 列表项（无需要 omit 的字段，与实体一致） */
export const modelListItemSchema = modelSchema;

/** 创建模型请求（默认字段可选，parse 后必填） */
export const createModelRequestSchema = z.object({
  name: z.string().min(1, '名称不能为空').max(80, '名称不能超过 80 字符'),
  provider: modelProviderSchema.default('other'),
  model_id: modelIdSchema,
  context_window: z.number().int().nonnegative().default(0),
  supports_tools: z.boolean().default(false),
  supports_vision: z.boolean().default(false),
  input_price: priceSchema.default(0),
  output_price: priceSchema.default(0),
  currency: currencySchema,
  status: modelStatusSchema.default('active'),
  sort_order: z.number().int().default(0)
});

/** 更新模型请求：至少一项，且 status 仅 active/disabled */
export const updateModelRequestSchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    provider: modelProviderSchema.optional(),
    model_id: modelIdSchema.optional(),
    context_window: z.number().int().nonnegative().optional(),
    supports_tools: z.boolean().optional(),
    supports_vision: z.boolean().optional(),
    input_price: priceSchema.optional(),
    output_price: priceSchema.optional(),
    currency: z.string().regex(/^[A-Z]{3,8}$/).optional(),
    status: modelStatusSchema.optional(),
    sort_order: z.number().int().optional()
  })
  .refine((data) => Object.keys(data).length > 0, { message: '至少提供一个要更新的字段' });

/** 列表响应 */
export const listModelsResponseSchema = z.object({
  models: z.array(modelListItemSchema),
  total: z.number().int().nonnegative()
});

/** 单项响应 */
export const modelResponseSchema = z.object({
  model: modelSchema
});

/** 删除响应 */
export const deleteModelResponseSchema = z.object({
  deleted: z.boolean(),
  id: z.string().uuid()
});

// ───────────────────────────── 类型导出 ─────────────────────────────

export type ModelStatus = z.infer<typeof modelStatusSchema>;
export type ModelProvider = z.infer<typeof modelProviderSchema>;
export type Model = z.infer<typeof modelSchema>;
export type ModelListItem = z.infer<typeof modelListItemSchema>;
export type CreateModelInput = z.input<typeof createModelRequestSchema>;
export type CreateModelRequest = z.infer<typeof createModelRequestSchema>;
export type UpdateModelInput = z.input<typeof updateModelRequestSchema>;
export type UpdateModelRequest = z.infer<typeof updateModelRequestSchema>;
export type ListModelsResponse = z.infer<typeof listModelsResponseSchema>;
export type ModelResponse = z.infer<typeof modelResponseSchema>;
export type DeleteModelResponse = z.infer<typeof deleteModelResponseSchema>;
