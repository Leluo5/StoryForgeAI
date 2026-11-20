import type { PlotGroup, PlotNode } from '@storyforge/contracts';

// 画布布局纯函数：无副作用，便于单测与「撤销布局」快照复用（02-技术方案 §5.4）

export const NODE_WIDTH = 200;
export const NODE_HEIGHT = 88;
/** 层级（父子深度）横向间距 */
export const COL_GAP = 260;
/** 同层兄弟纵向间距 */
export const ROW_GAP = 120;
/** 泳道/分组之间的横向间隔 */
export const LANE_GAP = 100;
/** 画布逻辑坐标钳制范围（与契约 plotPositionSchema 一致） */
export const POSITION_LIMIT = 1_000_000;

export interface PlotPoint {
  x: number;
  y: number;
}

export interface PositionUpdate {
  node_id: string;
  x: number;
  y: number;
}

export function clampPosition(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-POSITION_LIMIT, Math.min(POSITION_LIMIT, Math.round(value)));
}

/** 沿 parent_id 上溯计算深度；遇到环或缺失父节点即停止，保证有界 */
export function nodeDepths(nodes: PlotNode[]): Map<string, number> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const depths = new Map<string, number>();
  for (const node of nodes) {
    const seen = new Set<string>([node.id]);
    let depth = 0;
    let parentId = node.parent_id;
    while (parentId && byId.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      depth += 1;
      parentId = byId.get(parentId)!.parent_id;
    }
    depths.set(node.id, depth);
  }
  return depths;
}

function compareNodes(a: PlotNode, b: PlotNode): number {
  return (
    a.sibling_order - b.sibling_order ||
    a.title.localeCompare(b.title, 'zh') ||
    a.id.localeCompare(b.id)
  );
}

/**
 * 自动布局：分组/泳道按 order_index 横向分区，每个分区内按深度向右、兄弟顺序向下排布。
 * 未分组节点放入最后一个默认分区。
 */
export function autoLayout(nodes: PlotNode[], groups: PlotGroup[]): Record<string, PlotPoint> {
  const depths = nodeDepths(nodes);
  const groupIds = new Set(groups.map((group) => group.id));
  const orderedGroups = [...groups].sort(
    (a, b) => a.order_index - b.order_index || a.name.localeCompare(b.name, 'zh') || a.id.localeCompare(b.id)
  );

  const lanes: Array<{ nodes: PlotNode[] }> = orderedGroups.map((group) => ({
    nodes: nodes.filter((node) => node.group_id === group.id)
  }));
  const ungrouped = nodes.filter((node) => !node.group_id || !groupIds.has(node.group_id));
  if (ungrouped.length > 0) lanes.push({ nodes: ungrouped });

  const positions: Record<string, PlotPoint> = {};
  let laneX = 0;
  for (const lane of lanes) {
    if (lane.nodes.length === 0) continue;
    const byDepth = new Map<number, PlotNode[]>();
    for (const node of lane.nodes) {
      const depth = depths.get(node.id) ?? 0;
      const bucket = byDepth.get(depth) ?? [];
      bucket.push(node);
      byDepth.set(depth, bucket);
    }
    const maxDepth = Math.max(...byDepth.keys());
    for (const [depth, bucket] of byDepth) {
      bucket.sort(compareNodes);
      bucket.forEach((node, index) => {
        positions[node.id] = {
          x: clampPosition(laneX + depth * COL_GAP),
          y: clampPosition(index * ROW_GAP)
        };
      });
    }
    laneX += (maxDepth + 1) * COL_GAP + LANE_GAP;
  }
  return positions;
}

/** 记录当前坐标，供「撤销布局」回退 */
export function positionSnapshot(nodes: PlotNode[]): PositionUpdate[] {
  return nodes.map((node) => ({ node_id: node.id, x: node.position.x, y: node.position.y }));
}

/** 只提交真正变化的坐标，减少无效写入 */
export function diffPositions(nodes: PlotNode[], next: Record<string, PlotPoint>): PositionUpdate[] {
  const updates: PositionUpdate[] = [];
  for (const node of nodes) {
    const point = next[node.id];
    if (!point) continue;
    const x = clampPosition(point.x);
    const y = clampPosition(point.y);
    if (x !== node.position.x || y !== node.position.y) updates.push({ node_id: node.id, x, y });
  }
  return updates;
}
