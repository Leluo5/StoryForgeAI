import { z } from 'zod';

export const loginRequestSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(8).max(128)
});
export const authorSchema = z.object({ id: z.string().uuid(), email: z.string().email(), display_name: z.string().min(1).max(80) });
export const sessionResponseSchema = z.object({ author: authorSchema, csrf_token: z.string().min(32) });
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type Author = z.infer<typeof authorSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
