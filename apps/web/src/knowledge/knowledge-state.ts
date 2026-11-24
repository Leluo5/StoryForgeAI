// ============================================================================
// M3c-3 知识库 · 前端状态层（受控 reducer + 事件幂等 + 列表缓存 + 乐观更新）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §6.3
//
// 职责：
//   - knowledgeReducer：单一受控 reducer，驱动列表/详情/作业/缓存状态
//   - mergeJobEvent：SSE 事件幂等合并（按 lastSeq 去重），重复事件返回原引用
//   - knowledgeCacheKey：列表缓存键，按库/作品隔离（scope + workId + 过滤条件）
//   - applyEntryOptimistic / revertEntryOptimistic：乐观更新与失败回滚
//   - knowledgeErrorMessage：统一错误文案，409 优先读 details.current_version
//   - createKnowledgeStore：极简 store（getState / dispatch / subscribe）
//
// 依赖：本文件只依赖 @storyforge/contracts 类型与 ../api/client 的 ApiError，
//       不触碰任何 UI 组件；列表缓存按 knowledgeCacheKey 键隔离。
// ============================================================================

import { ApiError } from '../api/client';
import type {
  KnowledgeEntrySummary,
  KnowledgeEntryDetail,
  KnowledgeJob,
  KnowledgeJobEvent,
  KnowledgeScope,
  KnowledgeEntryType,
  KnowledgeTimeField
} from '@storyforge/contracts';

// ───────────────────────────── 列表缓存 ─────────────────────────────

export interface KnowledgeCacheEntry {
  items: KnowledgeEntrySummary[];
  nextCursor: string | null;
  total: number;
  at: number;
}

// ───────────────────────────── 作业追踪 ─────────────────────────────

export interface KnowledgeJobState {
  /** 由 SSE 事件累积的作业快照（部分字段；完整 job 由 getJob/listJobs 提供后合并） */
  job: Partial<KnowledgeJob>;
  /** 已合并事件的最高 seq，用于幂等去重与断线重放 after_seq */
  lastSeq: number;
  /** SSE 连接状态 */
  connected: boolean;
  /** 失败原因（failed 事件 payload.message），成功/进行中为 undefined */
  error: string | undefined;
}

// ───────────────────────────── 状态 ─────────────────────────────

export interface KnowledgeState {
  // 当前检索上下文
  scope: KnowledgeScope;
  workId: string | undefined;
  keyword: string;
  types: KnowledgeEntryType[];
  tagIds: string[];
  timeField: KnowledgeTimeField;
  timeFrom: string | undefined;
  timeTo: string | undefined;
  favorite: boolean | undefined;
  pinned: boolean | undefined;
  deleted: boolean;

  // 列表（当前页）
  items: KnowledgeEntrySummary[];
  nextCursor: string | null;
  total: number;
  loading: boolean;

  // 详情
  detail: KnowledgeEntryDetail | null;
  detailLoading: boolean;
  detailError: unknown;
  /** 当前选中的条目 id（用于列表高亮与详情加载） */
  selectedEntryId: string | null;

  // 作业订阅追踪
  jobs: Record<string, KnowledgeJobState>;

  // 列表缓存（按库/作品隔离）
  listCache: Record<string, KnowledgeCacheEntry>;
  // 详情缓存
  detailCache: Record<string, KnowledgeEntryDetail>;
}

export const knowledgeInitialState: KnowledgeState = {
  scope: 'global',
  workId: undefined,
  keyword: '',
  types: [],
  tagIds: [],
  timeField: 'created_at',
  timeFrom: undefined,
  timeTo: undefined,
  favorite: undefined,
  pinned: undefined,
  deleted: false,

  items: [],
  nextCursor: null,
  total: 0,
  loading: false,

  detail: null,
  detailLoading: false,
  detailError: undefined,
  selectedEntryId: null,

  jobs: {},

  listCache: {},
  detailCache: {}
};

// ───────────────────────────── 动作 ─────────────────────────────

export type KnowledgeAction =
  | { type: 'SCOPE_SET'; scope: KnowledgeScope; workId?: string }
  | { type: 'FILTER_SET'; keyword?: string; types?: KnowledgeEntryType[]; tagIds?: string[] }
  | { type: 'LIST_LOADING' }
  | { type: 'LIST_LOADED'; items: KnowledgeEntrySummary[]; nextCursor: string | null; total: number; cacheKey: string }
  | { type: 'LIST_ERROR'; message: string }
  | { type: 'DETAIL_LOADING' }
  | { type: 'DETAIL_LOADED'; detail: KnowledgeEntryDetail }
  | { type: 'DETAIL_ERROR'; message: string; cause?: unknown }
  | { type: 'JOB_EVENT'; event: KnowledgeJobEvent }
  | { type: 'JOB_CLEAR'; jobId: string }
  | { type: 'ENTRY_UPSERT'; entry: KnowledgeEntrySummary }
  | { type: 'ENTRY_REMOVE'; entryId: string }
  | { type: 'ENTRY_RESTORE'; entryId: string }
  | { type: 'CACHE_INVALIDATE'; cacheKey?: string };

// ───────────────────────────── 缓存键 ─────────────────────────────

/** 列表缓存键：scope + workId + 过滤条件，保证库/作品隔离且稳定 */
export function knowledgeCacheKey(query: {
  scope: KnowledgeScope;
  workId?: string;
  keyword?: string;
  types?: KnowledgeEntryType[];
  tagIds?: string[];
}): string {
  return [
    query.scope,
    query.workId ?? '',
    query.keyword ?? '',
    (query.types ?? []).join(','),
    (query.tagIds ?? []).join(',')
  ].join('|');
}

// ───────────────────────────── 事件幂等合并 ─────────────────────────────

/** SSE 事件幂等合并：seq 不递增则原样返回（保持引用），否则更新作业快照 */
export function mergeJobEvent(state: KnowledgeState, event: KnowledgeJobEvent): KnowledgeState {
  const current = state.jobs[event.job_id];
  if (current && event.seq <= current.lastSeq) return state;

  const job: Partial<KnowledgeJob> = { ...(current?.job ?? {}) };
  if (event.type !== 'progress') {
    job.status = event.type as NonNullable<KnowledgeJob['status']>;
  }
  if (event.progress !== undefined) job.progress = event.progress;

  let error: string | undefined = current?.error;
  if (event.type === 'failed' && event.payload) {
    const message = event.payload.message;
    if (typeof message === 'string') error = message;
  }

  return {
    ...state,
    jobs: {
      ...state.jobs,
      [event.job_id]: {
        job,
        lastSeq: event.seq,
        connected: current?.connected ?? true,
        error
      }
    }
  };
}

// ───────────────────────────── 乐观更新 ─────────────────────────────

/** 乐观更新列表条目；返回新状态与可回滚快照（条目不存在时快照为 undefined） */
export function applyEntryOptimistic(
  state: KnowledgeState,
  entryId: string,
  patch: Partial<KnowledgeEntrySummary>
): { state: KnowledgeState; snapshot: Partial<KnowledgeEntrySummary> | undefined } {
  const items = state.items;
  const index = items.findIndex((item) => item.id === entryId);
  if (index < 0) return { state, snapshot: undefined };

  const item = items[index] as KnowledgeEntrySummary;
  const snapshot: Partial<KnowledgeEntrySummary> = {};
  for (const key of Object.keys(patch) as Array<keyof KnowledgeEntrySummary>) {
    (snapshot as Record<string, unknown>)[key] = item[key];
  }

  const nextItems = items.slice();
  nextItems[index] = { ...item, ...patch };
  return { state: { ...state, items: nextItems }, snapshot };
}

/** 回滚乐观更新到快照 */
export function revertEntryOptimistic(
  state: KnowledgeState,
  entryId: string,
  snapshot: Partial<KnowledgeEntrySummary> | undefined
): KnowledgeState {
  if (!snapshot) return state;
  const items = state.items;
  const index = items.findIndex((item) => item.id === entryId);
  if (index < 0) return state;

  const item = items[index] as KnowledgeEntrySummary;
  const nextItems = items.slice();
  nextItems[index] = { ...item, ...snapshot };
  return { ...state, items: nextItems };
}

// ───────────────────────────── 错误映射 ─────────────────────────────

/** 统一错误文案：409 优先读 details.current_version，其余用 ApiError.message */
export function knowledgeErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    const details = cause.details as { current_version?: unknown } | undefined;
    if (cause.status === 409 && details && 'current_version' in details) {
      return `版本冲突：当前服务器版本为 ${String(details.current_version)}，请刷新后重试。`;
    }
    return cause.message;
  }
  if (cause instanceof Error) return cause.message;
  return '操作失败，请稍后重试。';
}

// ───────────────────────────── reducer ─────────────────────────────

export function knowledgeReducer(state: KnowledgeState, action: KnowledgeAction): KnowledgeState {
  switch (action.type) {
    case 'JOB_EVENT':
      return mergeJobEvent(state, action.event);

    case 'SCOPE_SET':
      return {
        ...state,
        scope: action.scope,
        workId: action.workId,
        items: [],
        nextCursor: null,
        total: 0,
        selectedEntryId: null,
        detail: null,
        detailError: undefined
      };

    case 'FILTER_SET':
      return {
        ...state,
        keyword: action.keyword ?? state.keyword,
        types: action.types ?? state.types,
        tagIds: action.tagIds ?? state.tagIds
      };

    case 'LIST_LOADING':
      return { ...state, loading: true };

    case 'LIST_LOADED': {
      const cacheEntry: KnowledgeCacheEntry = {
        items: action.items,
        nextCursor: action.nextCursor,
        total: action.total,
        at: Date.now()
      };
      return {
        ...state,
        items: action.items,
        nextCursor: action.nextCursor,
        total: action.total,
        loading: false,
        listCache: { ...state.listCache, [action.cacheKey]: cacheEntry }
      };
    }

    case 'LIST_ERROR':
      return { ...state, loading: false };

    case 'DETAIL_LOADING':
      return { ...state, detailLoading: true, detailError: undefined };

    case 'DETAIL_LOADED':
      return {
        ...state,
        detail: action.detail,
        detailLoading: false,
        detailError: undefined,
        selectedEntryId: action.detail.id,
        detailCache: { ...state.detailCache, [action.detail.id]: action.detail }
      };

    case 'DETAIL_ERROR':
      return { ...state, detailLoading: false, detailError: action.cause ?? new Error(action.message) };

    case 'JOB_CLEAR': {
      const jobs = { ...state.jobs };
      delete jobs[action.jobId];
      return { ...state, jobs };
    }

    case 'ENTRY_UPSERT': {
      const index = state.items.findIndex((item) => item.id === action.entry.id);
      const items = index < 0 ? [action.entry, ...state.items] : state.items.slice();
      if (index >= 0) items[index] = action.entry;
      return { ...state, items };
    }

    case 'ENTRY_REMOVE':
      return { ...state, items: state.items.filter((item) => item.id !== action.entryId) };

    case 'ENTRY_RESTORE': {
      if (state.items.some((item) => item.id === action.entryId)) return state;
      let restored: KnowledgeEntrySummary | undefined;
      for (const cacheEntry of Object.values(state.listCache)) {
        const found = cacheEntry.items.find((item) => item.id === action.entryId);
        if (found) {
          restored = found;
          break;
        }
      }
      if (!restored) return state;
      return { ...state, items: [...state.items, restored] };
    }

    case 'CACHE_INVALIDATE': {
      if (action.cacheKey !== undefined) {
        const listCache = { ...state.listCache };
        delete listCache[action.cacheKey];
        return { ...state, listCache };
      }
      return { ...state, listCache: {} };
    }

    default:
      return state;
  }
}

// ───────────────────────────── store ─────────────────────────────

export interface KnowledgeStore {
  getState: () => KnowledgeState;
  dispatch: (action: KnowledgeAction) => void;
  subscribe: (listener: () => void) => () => void;
}

/** 极简受控 store：reducer 驱动，subscribe 返回退订函数 */
export function createKnowledgeStore(initial: KnowledgeState = knowledgeInitialState): KnowledgeStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch: (action) => {
      state = knowledgeReducer(state, action);
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
}
