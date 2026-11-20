import type { ArchivedOwnerNode, PlotNode, PlotNodeOwner } from '@storyforge/contracts';

// T40「显示归档角色剧情」：本地偏好、隐藏父级退化、单端隐藏连线 stub 与归属多选的纯函数
// 依据 02-技术方案 §6.5.1、§4.9、§2.2.14

/** 单节点归属角色上限（与服务端 setPlotNodeOwnersRequestSchema.max(10) 一致） */
export const MAX_NODE_OWNERS = 10;
/** 单端隐藏连线标签 */
export const ARCHIVED_EDGE_LABEL = '归档角色剧情';
/** 隐藏父节点下的子节点提示 */
export const ARCHIVED_PARENT_HINT = '父节点属于归档角色剧情';
/** 本地偏好键前缀：按作品隔离，不写服务端 */
export const ARCHIVED_OWNER_STORAGE_PREFIX = 'sf:plot:includeArchivedOwner:';
/** 归档节点无坐标时，stub 相对可见节点的固定偏移 */
export const ARCHIVED_STUB_OFFSET = 160;

export function archivedOwnerStorageKey(workId: string): string {
  return `${ARCHIVED_OWNER_STORAGE_PREFIX}${workId}`;
}

export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface IncludeArchivedResolution {
  value: boolean;
  /** 深链显式指定时需同步写回本地偏好 */
  fromUrl: boolean;
}

function parseBooleanParam(raw: string | null | undefined): boolean | null {
  if (raw === null || raw === undefined) return null;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return null;
}

function safeGet(storage: PreferenceStorage | null, workId: string): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(archivedOwnerStorageKey(workId));
  } catch {
    return null;
  }
}

function safeSet(storage: PreferenceStorage | null, workId: string, value: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(archivedOwnerStorageKey(workId), value ? '1' : '0');
  } catch {
    // 隐私模式等存储不可用时静默降级为会话内状态
  }
}

/**
 * 初始值优先级：URL `?includeArchivedOwner=1` > localStorage > 默认 false。
 * URL 显式指定时同步写回本地偏好（深链覆盖）。
 */
export function resolveIncludeArchivedOwner(
  workId: string,
  search: string,
  storage: PreferenceStorage | null
): IncludeArchivedResolution {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const fromUrl = parseBooleanParam(params.get('includeArchivedOwner'));
  if (fromUrl !== null) {
    safeSet(storage, workId, fromUrl);
    return { value: fromUrl, fromUrl: true };
  }
  const stored = parseBooleanParam(safeGet(storage, workId));
  return { value: stored ?? false, fromUrl: false };
}

function browserStorage(): PreferenceStorage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readIncludeArchivedOwner(workId: string): boolean {
  if (typeof window === 'undefined') return false;
  const search = typeof window.location?.search === 'string' ? window.location.search : '';
  return resolveIncludeArchivedOwner(workId, search, browserStorage()).value;
}

export function writeIncludeArchivedOwner(workId: string, value: boolean): void {
  safeSet(browserStorage(), workId, value);
}

/** 归档隐藏节点索引：node_id → 归档节点（含 stub 坐标） */
export function archivedNodeMap(archivedNodes: ArchivedOwnerNode[]): Map<string, ArchivedOwnerNode> {
  return new Map(archivedNodes.map((node) => [node.node_id, node]));
}

export function archivedNodeIds(archivedNodes: ArchivedOwnerNode[]): Set<string> {
  return new Set(archivedNodes.map((node) => node.node_id));
}

/** 父节点是否属于归档角色剧情（用于子节点退化为顶层并加提示） */
export function isArchivedParent(node: Pick<PlotNode, 'parent_id'>, ids: Set<string>): boolean {
  return node.parent_id !== null && ids.has(node.parent_id);
}

/** stub 坐标：优先后端提供的 archived_owner_nodes 坐标，缺失时按可见节点固定偏移 */
export function archivedStubPosition(
  archived: ArchivedOwnerNode | undefined,
  fallback: { x: number; y: number }
): { x: number; y: number } {
  if (archived) return { x: archived.position.x, y: archived.position.y };
  return { x: fallback.x + ARCHIVED_STUB_OFFSET, y: fallback.y };
}

// ───────────────────────────── 节点归属选择 ─────────────────────────────

export interface PlotOwnerDraft {
  character_id: string;
  is_exclusive: boolean;
}

/** 服务端归属 → 本地草稿（保持稳定顺序，便于比较与回滚） */
export function ownersFromServer(owners: PlotNodeOwner[]): PlotOwnerDraft[] {
  return owners
    .map((owner) => ({ character_id: owner.character_id, is_exclusive: owner.is_exclusive }))
    .sort((a, b) => a.character_id.localeCompare(b.character_id));
}

/** 稳定比较键：仅用于判断服务端归属是否变化，不参与渲染 */
export function ownerDraftKey(draft: PlotOwnerDraft[]): string {
  return [...draft]
    .sort((a, b) => a.character_id.localeCompare(b.character_id))
    .map((owner) => `${owner.character_id}:${owner.is_exclusive ? 1 : 0}`)
    .join('|');
}

/** 勾选/取消归属；已存在则移除，达到上限时拒绝新增（UI 同时禁用未选项） */
export function toggleOwnerDraft(draft: PlotOwnerDraft[], characterId: string): PlotOwnerDraft[] {
  if (draft.some((owner) => owner.character_id === characterId)) {
    return draft.filter((owner) => owner.character_id !== characterId);
  }
  if (draft.length >= MAX_NODE_OWNERS) return draft;
  return [...draft, { character_id: characterId, is_exclusive: false }];
}

/** 切换「专属」标记（未选中角色不产生条目） */
export function setOwnerExclusive(
  draft: PlotOwnerDraft[],
  characterId: string,
  isExclusive: boolean
): PlotOwnerDraft[] {
  return draft.map((owner) =>
    owner.character_id === characterId ? { ...owner, is_exclusive: isExclusive } : owner
  );
}
