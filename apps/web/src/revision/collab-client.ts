import type {
  CreateCommentRequest,
  CreateCommentResponse,
  CreateTodoRequest,
  CreateTodoResponse,
  ListCommentsResponse,
  ListNotificationsResponse,
  ListTodosResponse,
  ReadAllNotificationsResponse,
  ReadNotificationResponse,
  ReplyCommentResponse,
  UnreadCountResponse,
  UpdateTodoStatusResponse
} from '@storyforge/contracts';
import {
  createCommentRequestSchema,
  createCommentResponseSchema,
  createTodoRequestSchema,
  createTodoResponseSchema,
  listCommentsResponseSchema,
  listNotificationsResponseSchema,
  listTodosResponseSchema,
  readAllNotificationsResponseSchema,
  readNotificationResponseSchema,
  replyCommentResponseSchema,
  unreadCountResponseSchema,
  updateTodoStatusResponseSchema
} from '@storyforge/contracts';
import { apiRequest } from '../api/client';

// 评论 / 待办 挂在 works/:workId 下；通知挂在 notifications（个人维度，无 workId）
const root = '/api/v1/works';
const part = encodeURIComponent;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

// ── 评论（3.3）──

export function createComment(workId: string, chapterId: string, input: CreateCommentRequest): Promise<CreateCommentResponse> {
  return apiRequest(
    `${root}/${part(workId)}/chapters/${part(chapterId)}/comments`,
    createCommentResponseSchema,
    json('POST', createCommentRequestSchema.parse(input))
  );
}

export function listComments(workId: string, chapterId: string): Promise<ListCommentsResponse> {
  return apiRequest(
    `${root}/${part(workId)}/chapters/${part(chapterId)}/comments`,
    listCommentsResponseSchema,
    { method: 'GET' }
  );
}

export function replyComment(workId: string, commentId: string, content: string): Promise<ReplyCommentResponse> {
  return apiRequest(
    `${root}/${part(workId)}/comments/${part(commentId)}/replies`,
    replyCommentResponseSchema,
    json('POST', { content })
  );
}

export function resolveComment(workId: string, commentId: string): Promise<{ comment: unknown }> {
  return apiRequest(
    `${root}/${part(workId)}/comments/${part(commentId)}/resolve`,
    createCommentResponseSchema,
    { method: 'POST' }
  );
}

export function reopenComment(workId: string, commentId: string): Promise<{ comment: unknown }> {
  return apiRequest(
    `${root}/${part(workId)}/comments/${part(commentId)}/reopen`,
    createCommentResponseSchema,
    { method: 'POST' }
  );
}

export function reAnchorComment(workId: string, commentId: string, anchor: { start: number; end: number; original_text: string; before_text: string; after_text: string; version: number }): Promise<{ comment: unknown }> {
  return apiRequest(
    `${root}/${part(workId)}/comments/${part(commentId)}/re-anchor`,
    createCommentResponseSchema,
    json('POST', { anchor })
  );
}

// ── 待办（3.4）──

export function createTodo(workId: string, input: CreateTodoRequest): Promise<CreateTodoResponse> {
  return apiRequest(
    `${root}/${part(workId)}/todos`,
    createTodoResponseSchema,
    json('POST', createTodoRequestSchema.parse(input))
  );
}

export function listTodos(workId: string): Promise<ListTodosResponse> {
  return apiRequest(
    `${root}/${part(workId)}/todos`,
    listTodosResponseSchema,
    { method: 'GET' }
  );
}

export function updateTodoStatus(workId: string, todoId: string, status: string): Promise<UpdateTodoStatusResponse> {
  return apiRequest(
    `${root}/${part(workId)}/todos/${part(todoId)}/status`,
    updateTodoStatusResponseSchema,
    json('PATCH', { status })
  );
}

// ── 通知（3.5，个人维度）──

export function listNotifications(): Promise<ListNotificationsResponse> {
  return apiRequest('/api/v1/notifications', listNotificationsResponseSchema, { method: 'GET' });
}

export function unreadCount(): Promise<UnreadCountResponse> {
  return apiRequest('/api/v1/notifications/unread-count', unreadCountResponseSchema, { method: 'GET' });
}

export function markRead(notificationId: string): Promise<ReadNotificationResponse> {
  return apiRequest(`/api/v1/notifications/${part(notificationId)}/read`, readNotificationResponseSchema, { method: 'POST' });
}

export function markAllRead(): Promise<ReadAllNotificationsResponse> {
  return apiRequest('/api/v1/notifications/read-all', readAllNotificationsResponseSchema, { method: 'POST' });
}
