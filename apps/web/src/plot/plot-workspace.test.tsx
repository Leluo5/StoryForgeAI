import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PlotGroup, PlotLink, PlotNode, PlotTree } from '@storyforge/contracts';
import { ApiError } from '../api/client';
import type { PlotClient } from './plot-client';
import { PlotStoreProvider, PlotWorkspace } from './plot-workspace';
import { PlotInspector } from './plot-inspector';

const workId = '11111111-1111-4111-8111-111111111111';
const treeId = '22222222-2222-4222-8222-222222222222';
const now = new Date().toISOString();

const tree: PlotTree = {
  id: treeId, work_id: workId, title: '主线', source: 'manual',
  schema_version: 1, version: 1, created_at: now, updated_at: now
};

function node(overrides: Partial<PlotNode> & Pick<PlotNode, 'id' | 'title'>): PlotNode {
  return {
    tree_id: treeId, parent_id: null, sibling_order: 0, summary: null, content: '',
    attributes: {}, position: { x: 0, y: 0 }, group_id: null, origin: 'manual',
    created_at: now, updated_at: now, ...overrides
  };
}

function group(id: string, name: string): PlotGroup {
  return { id, tree_id: treeId, name, kind: 'group', order_index: 0, created_at: now, updated_at: now };
}

function link(id: string, sourceId: string, targetId: string, type: PlotLink['type']): PlotLink {
  return { id, tree_id: treeId, source_id: sourceId, target_id: targetId, type, label: null, created_at: now };
}

function makeClient(overrides: Record<string, unknown> = {}): PlotClient {
  const base = {
    fetchTree: vi.fn(async () => ({ tree: null, nodes: [], links: [], groups: [] })),
    createTree: vi.fn(async () => ({ tree, nodes: [], links: [], groups: [] })),
    updateTree: vi.fn(),
    createNode: vi.fn(),
    updateNode: vi.fn(),
    deleteNode: vi.fn(),
    moveNode: vi.fn(),
    assignGroup: vi.fn(),
    updatePositions: vi.fn(async () => ({ updated: 0 })),
    createLink: vi.fn(),
    deleteLink: vi.fn(),
    createGroup: vi.fn(),
    updateGroup: vi.fn(),
    deleteGroup: vi.fn(),
    exportTree: vi.fn(),
    importTree: vi.fn(),
    createDerivation: vi.fn(),
    getDerivation: vi.fn(),
    updateDerivation: vi.fn(),
    generateStep: vi.fn(),
    updateStep: vi.fn(),
    createCandidate: vi.fn(),
    confirmCandidate: vi.fn(),
    rejectCandidate: vi.fn()
  };
  return { ...base, ...overrides } as unknown as PlotClient;
}

function renderWorkspace(client: PlotClient, withInspector = true) {
  return render(
    <PlotStoreProvider workId={workId} client={client}>
      <PlotWorkspace />
      {withInspector ? <PlotInspector /> : null}
    </PlotStoreProvider>
  );
}

describe('PlotWorkspace', () => {
  it('creates an empty tree and adds nodes on demand', async () => {
    const a = node({ id: 'a', title: '开场', sibling_order: 0 });
    const client = makeClient({
      createNode: vi.fn(async () => ({ node: a, version: 2 }))
    });
    renderWorkspace(client);

    await userEvent.click(await screen.findByRole('button', { name: '新建空树' }));
    expect(client.createTree).toHaveBeenCalledWith(workId, undefined);
    expect(await screen.findByRole('application', { name: /剧情画布/ })).toBeVisible();

    await userEvent.click(screen.getByRole('button', { name: '新增节点' }));
    await waitFor(() => expect(client.createNode).toHaveBeenCalled());
    expect(client.createNode).toHaveBeenCalledWith(workId, expect.objectContaining({
      title: '新节点', expected_version: 1, origin: 'manual'
    }));
    expect(await screen.findByRole('button', { name: '开场 来源 手动' })).toBeVisible();
  });

  it('renders distinct styles for parent, linear and non-linear edges', async () => {
    const a = node({ id: 'a', title: 'A' });
    const b = node({ id: 'b', title: 'B', parent_id: 'a' });
    const c = node({ id: 'c', title: 'C' });
    const client = makeClient({
      fetchTree: vi.fn(async () => ({
        tree, nodes: [a, b, c],
        links: [link('l1', 'a', 'c', 'linear'), link('l2', 'b', 'c', 'non_linear')],
        groups: []
      }))
    });
    const view = renderWorkspace(client, false);
    await screen.findByRole('application', { name: /剧情画布/ });
    await waitFor(() => expect(view.container.querySelectorAll('[data-plot-edge="parent"]')).toHaveLength(1));
    expect(view.container.querySelectorAll('[data-plot-edge="linear"]')).toHaveLength(1);
    expect(view.container.querySelectorAll('[data-plot-edge="non_linear"]')).toHaveLength(1);
  });

  it('applies auto layout and can undo it once', async () => {
    const a = node({ id: 'a', title: 'A', position: { x: 0, y: 0 } });
    const b = node({ id: 'b', title: 'B', parent_id: 'a', position: { x: 30, y: 30 } });
    const client = makeClient({
      fetchTree: vi.fn(async () => ({ tree, nodes: [a, b], links: [], groups: [] })),
      updatePositions: vi.fn(async () => ({ updated: 1 }))
    });
    renderWorkspace(client, false);
    await screen.findByRole('application', { name: /剧情画布/ });

    await userEvent.click(screen.getByRole('button', { name: '自动布局' }));
    await waitFor(() => expect(client.updatePositions).toHaveBeenCalledWith(workId, [
      { node_id: 'b', x: 260, y: 0 }
    ]));

    const undo = screen.getByRole('button', { name: '撤销布局' });
    await waitFor(() => expect(undo).toBeEnabled());
    await userEvent.click(undo);
    await waitFor(() => expect(client.updatePositions).toHaveBeenLastCalledWith(workId, [
      { node_id: 'a', x: 0, y: 0 },
      { node_id: 'b', x: 30, y: 30 }
    ]));
    expect(screen.getByRole('button', { name: '撤销布局' })).toBeDisabled();
  });

  it('confirms cascade delete with the affected node count', async () => {
    const a = node({ id: 'a', title: 'A' });
    const b = node({ id: 'b', title: 'B', parent_id: 'a' });
    const client = makeClient({
      fetchTree: vi.fn(async () => ({ tree, nodes: [a, b], links: [], groups: [group('g1', '暗线')] })),
      deleteNode: vi.fn(async () => ({ deleted: 2, version: 2 }))
    });
    renderWorkspace(client);
    await screen.findByRole('application', { name: /剧情画布/ });
    const target = screen.getByRole('button', { name: 'A 来源 手动' });
    fireEvent.keyDown(target, { key: 'Delete' });
    expect(screen.getByText(/将同时删除 2 个节点/)).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(client.deleteNode).toHaveBeenCalledWith(workId, 'a'));
  });

  it('shows an actionable message when the structure version conflicts', async () => {
    const a = node({ id: 'a', title: 'A' });
    const client = makeClient({
      fetchTree: vi.fn(async () => ({ tree, nodes: [a], links: [], groups: [] })),
      updateNode: vi.fn(async () => {
        throw new ApiError(409, 'PLOT_VERSION_CONFLICT', 'conflict', {}, 'req-1');
      })
    });
    renderWorkspace(client);
    await screen.findByRole('application', { name: /剧情画布/ });
    fireEvent.click(screen.getByRole('button', { name: 'A 来源 手动' }));
    await userEvent.click(await screen.findByRole('button', { name: '保存节点' }));
    // 工作区与检查器都会展示同一条冲突提示，因此可能命中多个 alert
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.some((node) => node.textContent?.includes('刷新后重试'))).toBe(true);
  });

  it('shows an empty search state in list view', async () => {
    const a = node({ id: 'a', title: '开场' });
    const client = makeClient({
      fetchTree: vi.fn(async () => ({ tree, nodes: [a], links: [], groups: [] }))
    });
    renderWorkspace(client, false);
    await screen.findByRole('application', { name: /剧情画布/ });
    await userEvent.click(screen.getByRole('button', { name: '列表' }));
    await userEvent.type(screen.getByRole('searchbox'), '不存在的关键词');
    expect(await screen.findByText(/没有匹配的节点/)).toBeVisible();
  });

  it('rejects malformed import JSON before asking for confirmation', async () => {
    const a = node({ id: 'a', title: '开场' });
    const client = makeClient({
      fetchTree: vi.fn(async () => ({ tree, nodes: [a], links: [], groups: [] }))
    });
    const view = renderWorkspace(client, false);
    await screen.findByRole('application', { name: /剧情画布/ });

    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    // jsdom 的 File 未实现 text()，这里补一个最小实现
    const file = new File(['{ not json'], 'broken.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { value: async () => '{ not json' });
    fireEvent.change(input, { target: { files: [file] } });

    expect(await screen.findByRole('alert')).toHaveTextContent('文件不是合法 JSON');
    expect(screen.queryByRole('alertdialog', { name: '确认导入' })).toBeNull();
    expect(client.importTree).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '开场 来源 手动' })).toBeVisible();
  });
});
