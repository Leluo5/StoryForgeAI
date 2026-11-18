import type { ExportPlotGroup, ExportPlotLink, ExportPlotNode, ExportPlotTree } from './plot-tree.service';

// 导入校验：全量校验通过后才允许写库，任一项失败即整批拒绝（不触碰现有树）

export class PlotImportError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'PlotImportError';
  }
}

export interface ImportNodeEntry {
  key: string;
  parentKey: string | null;
  groupKey: string | null;
  input: ExportPlotNode;
}

export interface ImportLinkEntry {
  sourceKey: string;
  targetKey: string;
  input: ExportPlotLink;
}

export interface ImportGroupEntry {
  key: string;
  input: ExportPlotGroup;
}

export interface ImportPlan {
  nodes: ImportNodeEntry[];
  links: ImportLinkEntry[];
  groups: ImportGroupEntry[];
}

/**
 * 校验顺序固定为：重复 id → 父引用 → 分组引用 → 关联引用 → 父链成环 → 线性成环。
 * 失败抛 PlotImportError(reason)，由服务层统一转 422。
 */
export function validateImportPayload(payload: ExportPlotTree): ImportPlan {
  const nodes: ImportNodeEntry[] = [];
  const nodeKeys = new Set<string>();
  for (const [index, node] of payload.nodes.entries()) {
    const key = node.id ?? `__node_${index}`;
    if (nodeKeys.has(key)) throw new PlotImportError('duplicate_id');
    nodeKeys.add(key);
    nodes.push({ key, parentKey: node.parent_id ?? null, groupKey: node.group_id ?? null, input: node });
  }

  const groups: ImportGroupEntry[] = [];
  const groupKeys = new Set<string>();
  for (const [index, group] of payload.groups.entries()) {
    const key = group.id ?? `__group_${index}`;
    if (groupKeys.has(key)) throw new PlotImportError('duplicate_id');
    groupKeys.add(key);
    groups.push({ key, input: group });
  }

  for (const node of nodes) {
    if (node.parentKey !== null && !nodeKeys.has(node.parentKey)) throw new PlotImportError('invalid_parent');
    if (node.groupKey !== null && !groupKeys.has(node.groupKey)) throw new PlotImportError('invalid_group');
  }

  const links: ImportLinkEntry[] = [];
  const linkKeys = new Set<string>();
  for (const link of payload.links) {
    if (
      !nodeKeys.has(link.source_id) ||
      !nodeKeys.has(link.target_id) ||
      link.source_id === link.target_id
    ) {
      throw new PlotImportError('invalid_link');
    }
    const key = `${link.type}:${link.source_id}->${link.target_id}`;
    if (linkKeys.has(key)) throw new PlotImportError('invalid_link');
    linkKeys.add(key);
    links.push({ sourceKey: link.source_id, targetKey: link.target_id, input: link });
  }

  assertParentKeysAcyclic(nodes);
  assertLinkKeysAcyclic(nodes, links);

  return { nodes, links, groups };
}

function assertParentKeysAcyclic(nodes: ImportNodeEntry[]): void {
  const parents = new Map(nodes.map((node) => [node.key, node.parentKey]));
  for (const node of nodes) {
    const seen = new Set<string>([node.key]);
    let cursor = node.parentKey;
    while (cursor) {
      if (seen.has(cursor)) throw new PlotImportError('parent_cycle');
      seen.add(cursor);
      cursor = parents.get(cursor) ?? null;
    }
  }
}

// 线性关联用 Kahn 拓扑排序检测环；非线性关联允许成环，不参与判定
function assertLinkKeysAcyclic(nodes: ImportNodeEntry[], links: ImportLinkEntry[]): void {
  const adjacency = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const node of nodes) {
    adjacency.set(node.key, new Set());
    indegree.set(node.key, 0);
  }
  for (const link of links) {
    if (link.input.type !== 'linear') continue;
    const targets = adjacency.get(link.sourceKey);
    if (!targets || targets.has(link.targetKey)) continue;
    targets.add(link.targetKey);
    indegree.set(link.targetKey, (indegree.get(link.targetKey) ?? 0) + 1);
  }
  const queue = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([key]) => key);
  let processed = 0;
  while (queue.length > 0) {
    const key = queue.pop()!;
    processed += 1;
    for (const next of adjacency.get(key) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (processed !== nodes.length) throw new PlotImportError('link_cycle');
}
