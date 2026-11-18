import type { PlotNodeEntity } from '../database/plot-node.entity';
import type { PlotLinkEntity } from '../database/plot-link.entity';

// 环检测：父子链与线性关联均禁止成环（非线性不做限制）

interface NodeLike {
  id: string;
  parent_id: string | null;
}

interface LinkLike {
  source_id: string;
  target_id: string;
}

/**
 * 父子链检测：把 nodeId 挂到 parentId 下是否成环。
 * 从 parentId 沿 parent_id 上溯，遇到 nodeId 即成环；parentId === nodeId 直接拒绝。
 */
export function assertParentAcyclic(nodes: NodeLike[], nodeId: string, parentId: string): void {
  if (nodeId === parentId) {
    throw new Error('PLOT_PARENT_CYCLE');
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  let cursor: string | null = parentId;
  while (cursor) {
    if (cursor === nodeId) {
      throw new Error('PLOT_PARENT_CYCLE');
    }
    if (seen.has(cursor)) break; // 已有脏数据成环时避免死循环
    seen.add(cursor);
    cursor = byId.get(cursor)?.parent_id ?? null;
  }
}

/**
 * 线性关联 DAG 检测：加入 source -> target 后是否成环。
 * 若从 target 沿现有线性边可达 source，则新增边会成环。
 */
export function assertLinearAcyclic(links: LinkLike[], sourceId: string, targetId: string): void {
  const adjacency = new Map<string, string[]>();
  for (const link of links) {
    const list = adjacency.get(link.source_id) ?? [];
    list.push(link.target_id);
    adjacency.set(link.source_id, list);
  }
  const stack = [targetId];
  const visited = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === sourceId) {
      throw new Error('PLOT_LINK_CYCLE');
    }
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
}

export type PlotNodeEntityLike = Pick<PlotNodeEntity, 'id' | 'parent_id'>;
export type PlotLinkEntityLike = Pick<PlotLinkEntity, 'source_id' | 'target_id'>;
