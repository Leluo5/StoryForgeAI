import {
  cancelAiTaskResponseSchema,
  createAiTaskRequestSchema,
  createAiTaskResponseSchema,
  getAiTaskResponseSchema,
  listAiTasksQuerySchema,
  listAiTasksResponseSchema,
  retryAiTaskResponseSchema,
  type AiTask,
  type AiTaskEvent,
  type AiTaskEventType,
  type CreateAiTaskRequest,
  type ListAiTasksQuery,
  type ListAiTasksResponse
} from '@storyforge/contracts';
import { apiRequest } from '../api/client';

const root = '/api/v1/works';
const part = encodeURIComponent;
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

// ───────────────────────────── 任务 CRUD ─────────────────────────────

/** 发起 AI 创作任务（后端幂等：同 idempotency_key 返回既有任务） */
export function createAiTask(
  workId: string,
  chapterId: string,
  input: CreateAiTaskRequest
): Promise<{ task: AiTask }> {
  return apiRequest(
    `${root}/${part(workId)}/chapters/${part(chapterId)}/ai-tasks`,
    createAiTaskResponseSchema,
    json('POST', createAiTaskRequestSchema.parse(input))
  );
}

export function listAiTasks(
  workId: string,
  chapterId: string,
  query: ListAiTasksQuery = {}
): Promise<ListAiTasksResponse> {
  const q = new URLSearchParams();
  const parsed = listAiTasksQuerySchema.parse(query);
  if (parsed.status) q.set('status', parsed.status);
  if (parsed.page) q.set('page', String(parsed.page));
  if (parsed.page_size) q.set('page_size', String(parsed.page_size));
  const suffix = q.size ? `?${q.toString()}` : '';
  return apiRequest(
    `${root}/${part(workId)}/chapters/${part(chapterId)}/ai-tasks${suffix}`,
    listAiTasksResponseSchema
  );
}

export function getAiTask(workId: string, taskId: string): Promise<{ task: AiTask }> {
  return apiRequest(
    `${root}/${part(workId)}/ai-tasks/${part(taskId)}`,
    getAiTaskResponseSchema
  );
}

export function retryAiTask(workId: string, taskId: string): Promise<{ task: AiTask }> {
  return apiRequest(
    `${root}/${part(workId)}/ai-tasks/${part(taskId)}/retry`,
    retryAiTaskResponseSchema,
    json('POST', {})
  );
}

export function cancelAiTask(workId: string, taskId: string): Promise<{ task: AiTask }> {
  return apiRequest(
    `${root}/${part(workId)}/ai-tasks/${part(taskId)}/cancel`,
    cancelAiTaskResponseSchema,
    json('POST', {})
  );
}

// ───────────────────────────── SSE 订阅 ─────────────────────────────

export interface TaskEvent {
  /** SSE 帧 id（event_seq），用于 Last-Event-ID 断线续传 */
  seq: number;
  type: AiTaskEventType;
  payload: Record<string, unknown>;
}

export type StreamState = 'connecting' | 'open' | 'closed';

export interface TaskEventStream {
  close: () => void;
  /** 当前连接状态（便于 UI 展示「已连接 / 重连中」） */
  getState: () => StreamState;
}

export interface SubscribeOptions {
  /** 断线重连时先补取历史事件的游标（Last-Event-ID），缺省从当前帧起 */
  since?: number;
  onEvent: (event: TaskEvent) => void;
  onError?: (cause: Error) => void;
  onStateChange?: (state: 'connecting' | 'open' | 'closed') => void;
}

/**
 * 订阅某任务的事件流（SSE）。
 * - 同源开发走 vite 代理，生产同域，均带 cookie（credentials: 'include'）。
 * - EventSource 内置自动重连；重连时携带 Last-Event-ID，服务端据此补发历史事件。
 * - 帧格式：`event: <type>\nid: <event_seq>\ndata: <json>\n\n`。
 *   其中 `event: snapshot` 为传输层包装帧（data 为 { seq, payload }），
 *   `data` 为普通类型帧的 payload。统一归一化为 TaskEvent 回调。
 */
export function subscribeTaskEvents(
  workId: string,
  taskId: string,
  options: SubscribeOptions
): TaskEventStream {
  const url = `${root}/${part(workId)}/ai-tasks/${part(taskId)}/events`;
  const source = new EventSource(url, { withCredentials: true });
  let closed = false;
  let state: StreamState = 'connecting';

  function setState(next: StreamState): void {
    if (closed || state === next) return;
    state = next;
    options.onStateChange?.(next);
  }

  function dispatch(rawType: string, rawId: string | null, data: string): void {
    // 后端帧格式：event: <type>\nid: <event_seq>\ndata: <完整事件对象 JSON>\n\n
    // data 为 { id, task_id, event_seq, type, payload, created_at }，payload 是嵌套字段。
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(data) as Record<string, unknown>; } catch { return; }
    const type = rawType as AiTaskEventType;
    // 帧 id 数字（snapshot 帧 id 为 "snapshot-<taskId>" 字符串，用 payload 的 event_seq 兜底）
    let seq = rawId === null ? Number.NaN : Number(rawId);
    if (!Number.isFinite(seq)) {
      const objSeq = typeof obj.event_seq === 'number' ? obj.event_seq : typeof obj.seq === 'number' ? obj.seq : Number.NaN;
      seq = objSeq;
    }
    const payload = (obj.payload ?? {}) as Record<string, unknown>;
    options.onEvent({ seq: Number.isFinite(seq) ? seq : 0, type, payload });
  }

  source.onopen = () => setState('open');
  source.onerror = () => setState('connecting');
  source.onmessage = (event) => dispatch('message', event.lastEventId || null, event.data);
  // 具名事件帧：'snapshot' / 'queued' / 'running' / 'progress' / 'succeeded' / 'failed' / 'cancelled'
  const namedTypes: AiTaskEventType[] = ['snapshot', 'queued', 'running', 'progress', 'succeeded', 'failed', 'cancelled'];
  for (const type of namedTypes) {
    source.addEventListener(type, (event) => {
      const messageEvent = event as MessageEvent<string>;
      dispatch(type, messageEvent.lastEventId || null, messageEvent.data);
    });
  }

  return {
    close: () => {
      // 先于 setState 置 closed 会使 setState 提前返回，必须显式推进状态
      if (closed) return;
      closed = true;
      source.close();
      state = 'closed';
      options.onStateChange?.('closed');
    },
    getState: () => state
  };
}
