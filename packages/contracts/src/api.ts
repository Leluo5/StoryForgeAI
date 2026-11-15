import { z } from 'zod';

export const requestIdSchema = z.string().uuid();
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(['BAD_REQUEST', 'UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'VALIDATION_ERROR', 'RATE_LIMITED', 'INTERNAL_ERROR', 'UPSTREAM_ERROR']),
    message: z.string().min(1),
    details: z.record(z.unknown()).optional()
  }),
  request_id: requestIdSchema
});

export function apiSuccessSchema<T extends z.ZodType>(data: T) {
  return z.object({ data, request_id: requestIdSchema });
}

export type ApiError = z.infer<typeof apiErrorSchema>;
