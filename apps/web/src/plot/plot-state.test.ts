import { describe, expect, it } from 'vitest';
import type { PlotGroup, PlotLink, PlotNode, PlotTree, PlotTreeResponse } from '@storyforge/contracts';
import { ApiError } from '../api/client';
import {
  buildTreeRows,
  emptyPlotData,
  filterPlotNodes,
  nextSiblingOrder,
  plotErrorMessage,
  subtreeIds,
  toPlotData
} from './plot-state';

const now = new Date().toISOString();
const treeId = 'tree-1';

function node(overrides: Partial<PlotNode> & Pick<PlotNode, 'id' | 'title'>): PlotNode {
  return {
    tree_id: treeId,
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

function tree(): PlotTree {
  return {
    id: treeId,
    work_id: 'work-1',
    title: '主线',
    source: 'manual',
    schema_version: 1,
    version: 3,
    created_at: now,
    updated_at: now
  };
}

describe('toPlotData', () => {
  it('takes version from tree and preserves empty response shape', () => {
    const response: PlotTreeResponse = { tree: tree(), nodes: [node({ id: 'a', title: 'A' })], links: [], groups: [] };
    expect(toPlotData(response)).toMatchObject({ version: 3, nodes: [expect.objectContaining({ id: 'a' })] });
    expect(toPlotData({ tree: null, nodes: [], links: [], groups: [] })).toMatchObject({ tree: null, version: 0 });
    expect(emptyPlotData()).toEqual({ tree: null, nodes: [], links: [], groups: [], version: 0 });
  });
});

describe('subtreeIds', () => {
  it('collects the root and all descendants but not siblings', () => {
    const nodes = [
      node({ id: 'root', title: '根' }),
      node({ id: 'child', title: '子', parent_id: 'root' }),
      node({ id: 'grand', title: '孙', parent_id: 'child' }),
      node({ id: 'other', title: '其它' })
    ];
    expect(subtreeIds(nodes, 'root').sort()).toEqual(['child', 'grand', 'root']);
    expect(subtreeIds(nodes, 'missing')).toEqual(['missing']);
  });
});

describe('buildTreeRows', () => {
  it('returns pre-order rows ordered by sibling_order with depth', () => {
    const nodes = [
      node({ id: 'a2', title: 'A2', sibling_order: 1 }),
      node({ id: 'a1', title: 'A1', sibling_order: 0 }),
      node({ id: 'a1c', title: 'A1-C', parent_id: 'a1' })
    ];
    expect(buildTreeRows(nodes).map(({ node: item, depth }) => `${item.id}:${depth}`)).toEqual([
      'a1:0',
      'a1c:1',
      'a2:0'
    ]);
  });

  it('treats nodes with missing parents as roots', () => {
    const rows = buildTreeRows([node({ id: 'orphan', title: '孤儿', parent_id: 'gone' })]);
    expect(rows).toEqual([{ node: expect.objectContaining({ id: 'orphan' }), depth: 0 }]);
  });
});

describe('filterPlotNodes', () => {
  const nodes = [
    node({ id: 'a', title: '开场', summary: '雨夜', content: '火车站', attributes: { place: '上海' }, origin: 'manual' }),
    node({ id: 'b', title: '冲突', summary: '追逐', origin: 'derivation', group_id: 'g1' }),
    node({ id: 'c', title: '结尾', content: '码头', origin: 'import' })
  ];

  it('matches title, summary, content and controlled attributes', () => {
    expect(filterPlotNodes(nodes, '雨夜', {}).map((item) => item.id)).toEqual(['a']);
    expect(filterPlotNodes(nodes, '上海', {}).map((item) => item.id)).toEqual(['a']);
    expect(filterPlotNodes(nodes, '码头', {}).map((item) => item.id)).toEqual(['c']);
    expect(filterPlotNodes(nodes, '   ', {})).toHaveLength(3);
  });

  it('filters by origin and group (including ungrouped)', () => {
    expect(filterPlotNodes(nodes, '', { origin: 'derivation' }).map((item) => item.id)).toEqual(['b']);
    expect(filterPlotNodes(nodes, '', { groupId: 'g1' }).map((item) => item.id)).toEqual(['b']);
    expect(filterPlotNodes(nodes, '', { groupId: 'ungrouped' }).map((item) => item.id)).toEqual(['a', 'c']);
  });

  it('is case-insensitive for latin keywords', () => {
    const latin = [node({ id: 'd', title: 'Act One' })];
    expect(filterPlotNodes(latin, 'act', {})).toHaveLength(1);
  });
});

describe('nextSiblingOrder', () => {
  it('returns max sibling order + 1 for a parent', () => {
    const nodes = [
      node({ id: 'a', title: 'A', sibling_order: 0 }),
      node({ id: 'b', title: 'B', parent_id: 'p', sibling_order: 2 }),
      node({ id: 'c', title: 'C', parent_id: 'p', sibling_order: 5 })
    ];
    expect(nextSiblingOrder(nodes, 'p')).toBe(6);
    expect(nextSiblingOrder(nodes, null)).toBe(1);
  });
});

describe('plotErrorMessage', () => {
  it('maps business error codes to actionable Chinese messages', () => {
    expect(plotErrorMessage(new ApiError(409, 'PLOT_VERSION_CONFLICT', 'conflict', {}, 'r1'))).toContain('刷新');
    expect(plotErrorMessage(new ApiError(409, 'PLOT_PARENT_CYCLE', 'cycle', {}, 'r1'))).toContain('循环');
    expect(plotErrorMessage(new ApiError(409, 'PLOT_LINK_CYCLE', 'cycle', {}, 'r1'))).toContain('循环');
    expect(plotErrorMessage(new ApiError(409, 'PLOT_LINK_EXISTS', 'dup', {}, 'r1'))).toContain('已存在');
    expect(plotErrorMessage(new ApiError(409, 'PLOT_GROUP_NAME_EXISTS', 'dup', {}, 'r1'))).toContain('已存在');
    expect(plotErrorMessage(new ApiError(409, 'PLOT_START_NODE_MISSING', 'gone', {}, 'r1'))).toContain('重新选择');
    expect(plotErrorMessage(new ApiError(409, 'AI_TOOL_DISABLED', 'off', {}, 'r1'))).toContain('停用');
    expect(
      plotErrorMessage(new ApiError(422, 'PLOT_IMPORT_INVALID', 'bad', { reason: 'link_cycle' }, 'r1'))
    ).toContain('循环');
  });

  it('falls back to the server message or a generic message', () => {
    expect(plotErrorMessage(new ApiError(500, 'UNKNOWN', '服务器开小差', {}, 'r1'))).toBe('服务器开小差');
    expect(plotErrorMessage(new Error('网络异常'))).toBe('网络异常');
    expect(plotErrorMessage(null)).toBe('剧情操作失败');
  });
});

describe('fixture type sanity', () => {
  it('keeps link and group fixtures compatible with contracts', () => {
    const link: PlotLink = {
      id: 'l1', tree_id: treeId, source_id: 'a', target_id: 'b', type: 'linear', label: null, created_at: now
    };
    const group: PlotGroup = {
      id: 'g1', tree_id: treeId, name: '暗线', kind: 'group', order_index: 0, created_at: now, updated_at: now
    };
    expect(link.type).toBe('linear');
    expect(group.kind).toBe('group');
  });
});
