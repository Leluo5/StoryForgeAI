import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlotNode } from '@storyforge/contracts';
import { PlotNodeList } from './plot-node-list';

const treeId = '22222222-2222-4222-8222-222222222222';
const now = new Date().toISOString();

function node(overrides: Partial<PlotNode> & Pick<PlotNode, 'id' | 'title'>): PlotNode {
  return {
    tree_id: treeId, parent_id: null, sibling_order: 0, summary: null, content: '',
    attributes: {}, position: { x: 0, y: 0 }, group_id: null, origin: 'manual',
    created_at: now, updated_at: now, ...overrides
  };
}

const a = node({ id: 'a', title: 'A', sibling_order: 0 });
const b = node({ id: 'b', title: 'B', parent_id: 'a', sibling_order: 0 });
const c = node({ id: 'c', title: 'C', sibling_order: 1 });

function row(title: string): HTMLElement {
  const element = screen.getByText(title).closest<HTMLElement>('[role="treeitem"]');
  if (!element) throw new Error(`找不到 ${title} 的列表行`);
  return element;
}

describe('PlotNodeList', () => {
  it('renders tree rows with depth levels in pre-order', () => {
    render(<PlotNodeList nodes={[c, b, a]} selectedNodeId="a" onSelect={vi.fn()} onDelete={vi.fn()} />);
    const rows = screen.getAllByRole('treeitem');
    expect(rows.map((item) => item.getAttribute('data-node-id'))).toEqual(['a', 'b', 'c']);
    expect(row('A')).toHaveAttribute('aria-level', '1');
    expect(row('B')).toHaveAttribute('aria-level', '2');
    expect(row('A')).toHaveAttribute('aria-selected', 'true');
    expect(row('A')).toHaveAttribute('tabindex', '0');
    expect(row('C')).toHaveAttribute('tabindex', '-1');
  });

  it('moves selection with arrow keys, Home and End', () => {
    const onSelect = vi.fn();
    render(<PlotNodeList nodes={[a, b, c]} selectedNodeId="a" onSelect={onSelect} onDelete={vi.fn()} />);
    fireEvent.keyDown(row('A'), { key: 'ArrowDown' });
    expect(onSelect).toHaveBeenLastCalledWith('b');
    fireEvent.keyDown(row('B'), { key: 'ArrowUp' });
    expect(onSelect).toHaveBeenLastCalledWith('a');
    fireEvent.keyDown(row('B'), { key: 'End' });
    expect(onSelect).toHaveBeenLastCalledWith('c');
    fireEvent.keyDown(row('C'), { key: 'Home' });
    expect(onSelect).toHaveBeenLastCalledWith('a');
  });

  it('requests deletion from keyboard and the row button', () => {
    const onDelete = vi.fn();
    render(<PlotNodeList nodes={[a, b, c]} selectedNodeId="a" onSelect={vi.fn()} onDelete={onDelete} />);
    fireEvent.keyDown(row('A'), { key: 'Delete' });
    expect(onDelete).toHaveBeenLastCalledWith('a');
    fireEvent.keyDown(row('B'), { key: 'Backspace' });
    expect(onDelete).toHaveBeenLastCalledWith('b');
    fireEvent.click(screen.getByRole('button', { name: '删除节点 C' }));
    expect(onDelete).toHaveBeenLastCalledWith('c');
  });

  it('shows an empty state when filters exclude every node', () => {
    render(<PlotNodeList nodes={[]} selectedNodeId={null} onSelect={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('没有匹配的节点');
    expect(screen.queryAllByRole('treeitem')).toHaveLength(0);
  });
});
