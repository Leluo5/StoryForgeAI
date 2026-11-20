import { describe, expect, it } from 'vitest';
import type { PlotGroup, PlotNode } from '@storyforge/contracts';
import {
  COL_GAP,
  ROW_GAP,
  autoLayout,
  clampPosition,
  diffPositions,
  nodeDepths,
  positionSnapshot
} from './plot-layout';

const now = new Date().toISOString();

function node(overrides: Partial<PlotNode> & Pick<PlotNode, 'id' | 'title'>): PlotNode {
  return {
    tree_id: 'tree-1',
    parent_id: null,
    sibling_order: 0,
    summary: null,
    content: '',
    attributes: {},
    position: { x: 0, y: 0 },
    group_id: null,
    origin: 'manual',
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

function group(id: string, orderIndex: number, kind: PlotGroup['kind'] = 'swimlane'): PlotGroup {
  return {
    id,
    tree_id: 'tree-1',
    name: id,
    kind,
    order_index: orderIndex,
    created_at: now,
    updated_at: now
  };
}

describe('nodeDepths', () => {
  it('computes depth from parent chain and guards cycles', () => {
    const nodes = [
      node({ id: 'a', title: 'A' }),
      node({ id: 'b', title: 'B', parent_id: 'a' }),
      node({ id: 'c', title: 'C', parent_id: 'b' }),
      node({ id: 'x', title: 'X', parent_id: 'y' }),
      node({ id: 'y', title: 'Y', parent_id: 'x' })
    ];
    const depths = nodeDepths(nodes);
    expect(depths.get('a')).toBe(0);
    expect(depths.get('b')).toBe(1);
    expect(depths.get('c')).toBe(2);
    // 环内节点不会无限上溯
    expect(depths.get('x')).toBeLessThan(10);
  });
});

describe('autoLayout', () => {
  it('lays out tree depth on x and sibling order on y', () => {
    const nodes = [
      node({ id: 'b', title: 'B', parent_id: 'a', sibling_order: 1 }),
      node({ id: 'a', title: 'A' }),
      node({ id: 'c', title: 'C', parent_id: 'a', sibling_order: 0 }),
      node({ id: 'd', title: 'D', parent_id: 'c' })
    ];
    const positions = autoLayout(nodes, []);
    expect(positions.a).toEqual({ x: 0, y: 0 });
    expect(positions.c).toEqual({ x: COL_GAP, y: 0 });
    expect(positions.b).toEqual({ x: COL_GAP, y: ROW_GAP });
    expect(positions.d).toEqual({ x: COL_GAP * 2, y: 0 });
  });

  it('allocates a horizontal lane per group ordered by order_index, ungrouped last', () => {
    const groups = [group('lane-b', 1), group('lane-a', 0)];
    const nodes = [
      node({ id: 'free', title: '未分组' }),
      node({ id: 'in-b', title: 'B 泳道', group_id: 'lane-b' }),
      node({ id: 'in-a', title: 'A 泳道', group_id: 'lane-a' })
    ];
    const positions = autoLayout(nodes, groups);
    expect(positions['in-a']!.x).toBe(0);
    expect(positions['in-b']!.x).toBeGreaterThan(positions['in-a']!.x);
    expect(positions.free!.x).toBeGreaterThan(positions['in-b']!.x);
  });

  it('is deterministic regardless of node input order', () => {
    const nodes = [
      node({ id: 'a', title: 'A' }),
      node({ id: 'b', title: 'B', parent_id: 'a', sibling_order: 1 }),
      node({ id: 'c', title: 'C', parent_id: 'a', sibling_order: 0 })
    ];
    expect(autoLayout(nodes, [])).toEqual(autoLayout([...nodes].reverse(), []));
  });

  it('returns integer coordinates within contract bounds', () => {
    const nodes = [node({ id: 'a', title: 'A' })];
    const positions = autoLayout(nodes, []);
    for (const point of Object.values(positions)) {
      expect(Number.isInteger(point.x)).toBe(true);
      expect(Number.isInteger(point.y)).toBe(true);
      expect(clampPosition(point.x)).toBe(point.x);
    }
  });
});

describe('positions', () => {
  it('snapshots current coordinates and diffs only changed nodes', () => {
    const nodes = [
      node({ id: 'a', title: 'A', position: { x: 0, y: 0 } }),
      node({ id: 'b', title: 'B', position: { x: 10, y: 20 } })
    ];
    expect(positionSnapshot(nodes)).toEqual([
      { node_id: 'a', x: 0, y: 0 },
      { node_id: 'b', x: 10, y: 20 }
    ]);
    expect(diffPositions(nodes, { a: { x: 5, y: 5 }, b: { x: 10, y: 20 } })).toEqual([
      { node_id: 'a', x: 5, y: 5 }
    ]);
  });

  it('clamps coordinates into the logical canvas range', () => {
    expect(clampPosition(2_000_000)).toBe(1_000_000);
    expect(clampPosition(-2_000_000)).toBe(-1_000_000);
  });
});
