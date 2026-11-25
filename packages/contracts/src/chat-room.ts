import { z } from 'zod';

const id = z.string().uuid();
const timestamp = z.string().datetime();

/** 聊天室容量上限（DoD #10 硬约束：单作品同时最多 10 个房间） */
export const CHAT_ROOM_MAX_PER_WORK = 10;

export const chatRoomStatusSchema = z.enum(['idle', 'running', 'paused', 'done', 'failed']);
export type ChatRoomStatus = z.infer<typeof chatRoomStatusSchema>;

export const chatRoomHistoryStepSchema = z.object({
  step_no: z.number().int().positive(),
  content: z.string().default(''),
  speaker: z.string().optional(),
  prompt: z.string().optional()
});
export type ChatRoomHistoryStep = z.infer<typeof chatRoomHistoryStepSchema>;

/** 创建房间入参。room_key 为客户端幂等键（作品内唯一，防并发重复创建）；random_seed 可选，缺省由服务端确定性派生 */
export const createChatRoomRequestSchema = z.object({
  name: z.string().trim().min(1, '房间名不能为空').max(120),
  room_key: z.string().trim().min(1).max(64),
  roles: z.array(id).max(20).default([]),
  random_seed: z
    .number({ invalid_type_error: 'random_seed 须为整数' })
    .int('random_seed 须为整数')
    .min(0)
    .max(2147483647)
    .optional()
});
export type CreateChatRoomRequest = z.infer<typeof createChatRoomRequestSchema>;
/** 入参侧类型：`roles` / `random_seed` 可省略（服务端补默认值） */
export type CreateChatRoomInput = z.input<typeof createChatRoomRequestSchema>;

/** 推衍一步入参：context_node_ids 供 plot sync-room 联动注入上下文 */
export const chatRoomStepRequestSchema = z.object({
  prompt: z.string().trim().min(1, '推衍提示词不能为空').max(2000).optional(),
  context_node_ids: z.array(id).max(50).default([]),
  parent_node_id: id.optional()
});
export type ChatRoomStepRequest = z.infer<typeof chatRoomStepRequestSchema>;
export type ChatRoomStepInput = z.input<typeof chatRoomStepRequestSchema>;

export const chatRoomContinueRequestSchema = z.object({
  prompt: z.string().trim().min(1).max(2000).optional(),
  context_node_ids: z.array(id).max(50).default([])
});
export type ChatRoomContinueRequest = z.infer<typeof chatRoomContinueRequestSchema>;
export type ChatRoomContinueInput = z.input<typeof chatRoomContinueRequestSchema>;

export const chatRoomEventTypeSchema = z.enum(['step', 'status', 'snapshot']);
export type ChatRoomEventType = z.infer<typeof chatRoomEventTypeSchema>;

export const chatRoomEventSchema = z.object({
  id,
  room_id: id,
  event_seq: z.number().int().nonnegative(),
  type: chatRoomEventTypeSchema,
  payload: z.record(z.unknown()),
  created_at: timestamp
});
export type ChatRoomEvent = z.infer<typeof chatRoomEventSchema>;

export const chatRoomSchema = z.object({
  id,
  work_id: id,
  room_key: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  roles: z.array(id),
  random_seed: z.number().int().nonnegative().nullable(),
  step_index: z.number().int().nonnegative(),
  branch: z.array(z.record(z.unknown())),
  context: z.record(z.unknown()),
  status: chatRoomStatusSchema,
  history: z.array(chatRoomHistoryStepSchema),
  created_at: timestamp,
  updated_at: timestamp
});
export type ChatRoom = z.infer<typeof chatRoomSchema>;

/** 列表摘要：不含 history / context 大字段，减少带宽 */
export const chatRoomSummarySchema = chatRoomSchema.pick({
  id: true,
  work_id: true,
  name: true,
  step_index: true,
  status: true,
  created_at: true,
  updated_at: true
});
export type ChatRoomSummary = z.infer<typeof chatRoomSummarySchema>;

export const createChatRoomResponseSchema = z.object({ room: chatRoomSchema });
export type CreateChatRoomResponse = z.infer<typeof createChatRoomResponseSchema>;

export const chatRoomResponseSchema = z.object({ room: chatRoomSchema });
export type ChatRoomResponse = z.infer<typeof chatRoomResponseSchema>;

export const listChatRoomsResponseSchema = z.object({
  rooms: z.array(chatRoomSummarySchema),
  total: z.number().int().nonnegative()
});
export type ListChatRoomsResponse = z.infer<typeof listChatRoomsResponseSchema>;

export const chatRoomStepResponseSchema = z.object({
  room: chatRoomSchema,
  event: chatRoomEventSchema
});
export type ChatRoomStepResponse = z.infer<typeof chatRoomStepResponseSchema>;

export const chatRoomEventQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().optional()
});
export type ChatRoomEventQuery = z.infer<typeof chatRoomEventQuerySchema>;