import { z } from 'zod';

export const arkClawChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(4000)
}).strict();

export const arkClawChatResponseSchema = z.object({
  answer: z.string().refine((value) => value.trim().length > 0)
}).strict();

export type ArkClawChatRequest = z.infer<typeof arkClawChatRequestSchema>;
export type ArkClawChatResponse = z.infer<typeof arkClawChatResponseSchema>;
