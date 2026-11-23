import { z } from 'zod';

export const loginRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(128)
});
export const authorSchema = z.object({ id: z.string().uuid(), email: z.string().email(), display_name: z.string().min(1).max(80) });
export const sessionResponseSchema = z.object({ author: authorSchema, csrf_token: z.string().min(32) });
/** 登录或自动注册的响应：created 标记本次是否为自动注册的新账号 */
export const loginOrRegisterResponseSchema = sessionResponseSchema.extend({ created: z.boolean() });
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type Author = z.infer<typeof authorSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type LoginOrRegisterResponse = z.infer<typeof loginOrRegisterResponseSchema>;
