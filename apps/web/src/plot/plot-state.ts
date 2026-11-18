import { createContext, useContext } from 'react';
import type {
  PlotGroup,
  PlotLink,
  PlotNode,
  PlotNodeAttributes,
  PlotNodeOrigin,
  PlotTree,
  PlotTreeResponse
} from '@storyforge/contracts';
import { ApiError } from '../api/client';
import type { PositionUpdate } from './plot-layout';

// 整树前端状态与纯查询函数（02-技术方案 §6.2）

export interface PlotData {
  tree: PlotTree | null;
  nodes: PlotNode[];
  links: PlotLink[];
  groups: PlotGroup[];
  /** 结构乐观锁版本 */
  version: number;
}

export interface PlotFilters {
  origin?: PlotNodeOrigin | 'all';
  groupId?: string | 'all' | 'ungrouped';
}

export interface PlotNodeDraft {
  title: string;
  summary?: string | null;
  content?: string;
  attributes?: PlotNodeAttributes;
  position?: { x: number; y: number };
  parent_id?: string | null;
  sibling_order?: number;
  group_id?: string | null;
  origin?: PlotNodeOrigin;
}

export interface PlotNodePatch {
  title?: string;
  summary?: string | null;
  content?: string;
  attributes?: PlotNodeAttributes;
}

export interface PlotStore {
  data: PlotData;
  loading: boolean;
  error: string;
  notice: string;
  busy: boolean;
  selectedNodeId: string | null;
  selectedLinkId: string | null;
  view: 'canvas' | 'list';
  lastLayoutSnapshot: PositionUpdate[] | null;
  setError(message: string): void;
  setNotice(message: string): void;
  selectNode(nodeId: string | null): void;
  selectLink(linkId: string | null): void;
  setView(view: 'canvas' | 'list'): void;
  reload(): Promise<void>;
  createTree(title?: string): Promise<boolean>;
  addNode(input: PlotNodeDraft): Promise<PlotNode | undefined>;
  patchNode(nodeId: string, patch: PlotNodePatch): Promise<boolean>;
  removeNode(nodeId: string): Promise<boolean>;
  moveNode(nodeId: string, parentId: string | null, siblingOrder?: number): Promise<boolean>;
  assignGroup(nodeId: string, groupId: string | null): Promise<boolean>;
  savePositions(updates: PositionUpdate[]): Promise<boolean>;
  applyLayout(positions: Record<string, { x: number; y: number }>): Promise<boolean>;
  undoLayout(): Promise<void>;
  addLink(sourceId: string, targetId: string, type: PlotLink['type'], label?: string | null): Promise<boolean>;
  removeLink(linkId: string): Promise<boolean>;
  addGroup(name: string, kind: PlotGroup['kind']): Promise<boolean>;
  renameGroup(groupId: string, name: string): Promise<boolean>;
  removeGroup(groupId: string): Promise<boolean>;
  exportJson(): Promise<string>;
  importJson(text: string): Promise<boolean>;
}

export const PlotStoreContext = createContext<PlotStore | null>(null);

export function usePlotStore(): PlotStore {
  const store = useContext(PlotStoreContext);
  if (!store) throw new Error('usePlotStore 必须在 PlotStoreProvider 内使用');
  return store;
}

export function emptyPlotData(): PlotData {
  return { tree: null, nodes: [], links: [], groups: [], version: 0 };
}

export function toPlotData(response: PlotTreeResponse): PlotData {
  return {
    tree: response.tree,
    nodes: response.nodes,
    links: response.links,
    groups: response.groups,
    version: response.tree?.version ?? 0
  };
}

/** 含根节点的子树 id 集合（用于删除前影响提示与本地级联清理） */
export function subtreeIds(nodes: PlotNode[], rootId: string): string[] {
  const children = new Map<string | null, string[]>();
  for (const node of nodes) {
    const list = children.get(node.parent_id) ?? [];
    list.push(node.id);
    children.set(node.parent_id, list);
  }
  const result: string[] = [];
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    result.push(id);
    stack.push(...(children.get(id) ?? []));
  }
  return result;
}

function compareBySibling(a: PlotNode, b: PlotNode): number {
  return a.sibling_order - b.sibling_order || a.title.localeCompare(b.title, 'zh') || a.id.localeCompare(b.id);
}

/** 列表视图行：先序展开，父节点缺失的节点视为根 */
export function buildTreeRows(nodes: PlotNode[]): Array<{ node: PlotNode; depth: number }> {
  const ids = new Set(nodes.map((node) => node.id));
  const children = new Map<string | null, PlotNode[]>();
  for (const node of nodes) {
    const parent = node.parent_id && ids.has(node.parent_id) ? node.parent_id : null;
    const list = children.get(parent) ?? [];
    list.push(node);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort(compareBySibling);

  const rows: Array<{ node: PlotNode; depth: number }> = [];
  const stack: Array<{ node: PlotNode; depth: number }> = (children.get(null) ?? [])
    .map((node) => ({ node, depth: 0 }))
    .reverse();
  while (stack.length > 0) {
    const entry = stack.pop()!;
    rows.push(entry);
    const kids = children.get(entry.node.id) ?? [];
    for (let index = kids.length - 1; index >= 0; index -= 1) {
      stack.push({ node: kids[index]!, depth: entry.depth + 1 });
    }
  }
  return rows;
}

/** 关键词（标题/概要/正文/受控属性）+ 来源 + 分组过滤，大小写不敏感 */
export function filterPlotNodes(nodes: PlotNode[], search: string, filters: PlotFilters = {}): PlotNode[] {
  const keyword = search.trim().toLowerCase();
  return nodes.filter((node) => {
    if (filters.origin && filters.origin !== 'all' && node.origin !== filters.origin) return false;
    if (filters.groupId && filters.groupId !== 'all') {
      if (filters.groupId === 'ungrouped' ? node.group_id !== null : node.group_id !== filters.groupId) return false;
    }
    if (!keyword) return true;
    const haystack = [
      node.title,
      node.summary ?? '',
      node.content,
      node.attributes.time_point ?? '',
      node.attributes.place ?? '',
      node.attributes.status ?? ''
    ]
      .join('\n')
      .toLowerCase();
    return haystack.includes(keyword);
  });
}

export function nextSiblingOrder(nodes: PlotNode[], parentId: string | null): number {
  const siblings = nodes.filter((node) => node.parent_id === parentId);
  return siblings.reduce((max, node) => Math.max(max, node.sibling_order + 1), 0);
}

const IMPORT_REASON_LABEL: Record<string, string> = {
  duplicate_id: '节点 id 重复',
  invalid_parent: '父节点引用缺失',
  parent_cycle: '父子层级形成循环',
  invalid_link: '关联引用缺失',
  link_cycle: '线性关联形成循环',
  invalid_group: '分组引用缺失',
  schema_version: 'schema 版本不匹配',
  node_limit: '节点数量超出上限'
};

const ERROR_LABEL: Record<string, string> = {
  PLOT_VERSION_CONFLICT: '剧情结构已被更新，请刷新后重试',
  PLOT_TREE_EXISTS: '该作品已存在剧情树',
  PLOT_PARENT_CYCLE: '不能形成循环层级',
  PLOT_LINK_CYCLE: '该关联会形成循环，请调整',
  PLOT_LINK_SELF: '关联两端不能是同一节点',
  PLOT_LINK_EXISTS: '该关联已存在',
  PLOT_GROUP_NAME_EXISTS: '分组名称已存在',
  PLOT_START_NODE_MISSING: '起点节点已被删除，请重新选择挂接位置',
  PLOT_SESSION_RUNNING: '推衍会话正在生成中，请稍后',
  PLOT_STEP_RUNNING: '当前步骤仍在生成中，请稍后',
  PLOT_SESSION_FINISHED: '推衍会话已结束',
  PLOT_SESSION_NOT_READY: '推衍会话尚未就绪',
  PLOT_CANDIDATE_CONFIRMED: '该候选已完成回写',
  PLOT_CANDIDATE_REJECTED: '该候选已被拒绝',
  PLOT_BRANCH_UNKNOWN: '所选分支不存在',
  PLOT_NO_STEPS: '尚无推衍步骤',
  AI_TOOL_DISABLED: '剧情推衍工具已停用，请在 Agent 管理中开启'
};

/** 把接口错误码翻译成可操作的中文提示 */
export function plotErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.code === 'PLOT_IMPORT_INVALID') {
      const reason = (cause.details as { reason?: string } | undefined)?.reason;
      const label = reason ? IMPORT_REASON_LABEL[reason] : undefined;
      return label ? `导入失败：${label}，现有剧情树未改动` : '导入失败：结构校验未通过，现有剧情树未改动';
    }
    return ERROR_LABEL[cause.code] ?? cause.message ?? '剧情操作失败';
  }
  if (cause instanceof Error && cause.message) return cause.message;
  return '剧情操作失败';
}

export const ORIGIN_LABEL: Record<PlotNodeOrigin, string> = {
  manual: '手动',
  derivation: '推衍',
  outline: '大纲',
  novel_text: '章节文本',
  import: '导入'
};

export const LINK_TYPE_LABEL: Record<PlotLink['type'], string> = {
  linear: '线性关联（必须先发生）',
  non_linear: '非线性关联（呼应）'
};
