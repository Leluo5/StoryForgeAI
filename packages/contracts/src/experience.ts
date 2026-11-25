import { z } from 'zod';

const id = z.string().uuid();
const timestamp = z.string().datetime();

/**
 * F3 在线体验：公开作品视图（隐藏 pat_token / access_code 等敏感字段）。
 * 旧架构 get_work_public 的公开字段子集；coze 绑定元信息用于前端渲染体验聊天。
 */
export const publicWorkSchema = z.object({
  id,
  name: z.string().min(1).max(120),
  description: z.string().max(2000),
  icon_url: z.string().nullable(),
  coze_bot_id: z.string().nullable(),
  interaction_type: z.string(),
  system_prompt: z.string().nullable(),
  prologue: z.string().nullable(),
  suggested_questions: z.array(z.string()).default([]),
  parameters: z.array(z.record(z.unknown())).default([]),
  model_name: z.string().nullable(),
  response_format: z.string().nullable(),
  /** 访问码是否已设置（不返回码本身，仅用于前端提示「需验证」） */
  requires_access_code: z.boolean(),
  created_at: timestamp,
  updated_at: timestamp
});

/** 公开作品列表响应 */
export const listPublicWorksResponseSchema = z.object({
  works: z.array(publicWorkSchema)
});

/** 访问码验证请求 */
export const verifyWorkAccessRequestSchema = z.object({
  access_code: z.string().trim().max(64)
});

/** 访问码验证响应：granted=true 时返回访问令牌，后续聊天请求头携带 X-Access-Token */
export const verifyWorkAccessResponseSchema = z.object({
  granted: z.boolean(),
  /** 访问令牌（仅 granted=true 且作品设了访问码时返回）；未设访问码的作品 granted=true 且 token=null */
  token: z.string().nullable()
});

/** 体验聊天请求：无登录态，user_id 为访客 ID（旧前端 visitor_ 前缀）；conversation_id 可空（首轮 Coze 会自动创建） */
export const chatExperienceRequestSchema = z.object({
  user_id: z.string().min(1).max(128),
  conversation_id: z.string().nullable().default(null),
  message: z.string().min(1).max(8000)
});

/**
 * 体验聊天 SSE 事件（旧架构 F3-R3 统一契约 delta/done/error）。
 * - delta: 增量文本 content
 * - done: 对话完成，返回 conversation_id 供续聊
 * - error: 失败信息
 */
export const chatExperienceEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), content: z.string() }),
  z.object({ type: z.literal('done'), conversation_id: z.string().nullable() }),
  z.object({ type: z.literal('error'), message: z.string() })
]);

export type PublicWork = z.infer<typeof publicWorkSchema>;
export type ListPublicWorksResponse = z.infer<typeof listPublicWorksResponseSchema>;
export type VerifyWorkAccessRequest = z.infer<typeof verifyWorkAccessRequestSchema>;
export type VerifyWorkAccessResponse = z.infer<typeof verifyWorkAccessResponseSchema>;
export type ChatExperienceRequest = z.infer<typeof chatExperienceRequestSchema>;
export type ChatExperienceEvent = z.infer<typeof chatExperienceEventSchema>;
