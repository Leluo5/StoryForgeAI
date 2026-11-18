import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { DerivationCandidate, DerivationSession, DerivationStep, PlotNode, PlotTree } from '@storyforge/contracts';
import type { SubscribeOptions, TaskEvent } from '../ai/ai-client';
import { subscribeTaskEvents } from '../ai/ai-client';
import type { PlotClient, PlotSessionDetail } from './plot-client';
import { usePlotStore } from './plot-state';
import { PlotStoreProvider } from './plot-workspace';
import { PlotDerivationPanel } from './plot-derivation-panel';

const workId = '11111111-1111-4111-8111-111111111111';
const treeId = '22222222-2222-4222-8222-222222222222';
const now = new Date().toISOString();

const tree: PlotTree = {
  id: treeId, work_id: workId, title: '主线', source: 'manual',
  schema_version: 1, version: 1, created_at: now, updated_at: now
};

function node(id: string, title: string): PlotNode {
  return {
    tree_id: treeId, id, title, parent_id: null, sibling_order: 0, summary: null, content: '',
    attributes: {}, position: { x: 0, y: 0 }, group_id: null, origin: 'manual',
    created_at: now, updated_at: now
  };
}

const startNode = node('a', '开场');
const otherNode = node('b', '第二幕');

const session: DerivationSession = {
  id: 'sess-1', work_id: workId, tree_id: treeId, start_node_id: 'a',
  place: '客栈', background: '主角被追杀', time_node: null,
  premise_node_ids: [], related_node_ids: [],
  characters: [{ name: '林澈', description: '剑客' }],
  random_enabled: true, random_character_enabled: true,
  status: 'paused', step_index: 1, created_at: now, updated_at: now
};

const step: DerivationStep = {
  id: 'step-1', session_id: 'sess-1', step_no: 1, content: '主角推门而入',
  event: null, new_characters: [], chosen_branch_id: null,
  branches: [
    { id: 'b1', label: '继续追击', description: '追击敌人' },
    { id: 'b2', label: '原地观察', description: '' }
  ],
  task_id: null, created_at: now, updated_at: now
};

function candidate(status: DerivationCandidate['status']): DerivationCandidate {
  return {
    id: 'cand-1', session_id: 'sess-1', start_node_id: 'a', placement: 'child',
    payload: { nodes: [{ title: '候选节点', content: '', summary: null, parent_index: null }] },
    status, confirmed_node_id: null, created_at: now, confirmed_at: null
  };
}

interface Mocks {
  client: PlotClient;
  fetchTree: ReturnType<typeof vi.fn>;
  createDerivation: ReturnType<typeof vi.fn>;
  updateStep: ReturnType<typeof vi.fn>;
  confirmCandidate: ReturnType<typeof vi.fn>;
  rejectCandidate: ReturnType<typeof vi.fn>;
}

function makeMocks(detail: PlotSessionDetail, taskId = ''): Mocks {
  let confirmed: PlotNode | null = null;
  const fetchTree = vi.fn(async () => ({
    tree,
    nodes: confirmed ? [startNode, otherNode, confirmed] : [startNode, otherNode],
    links: [],
    groups: []
  }));
  const createDerivation = vi.fn(async () => ({ session: { ...session, status: 'running' as const } }));
  const getDerivation = vi.fn(async () => detail);
  const generateStep = vi.fn(async () => ({
    task: { id: taskId } as never,
    session: { ...session, status: 'running' as const }
  }));
  const updateStep = vi.fn(async () => ({ step: { ...step, content: '新的内容', chosen_branch_id: 'b1' } }));
  const confirmCandidate = vi.fn(async () => {
    confirmed = node('created', '候选节点');
    return { nodes: [confirmed], version: 2 };
  });
  const rejectCandidate = vi.fn(async () => ({ candidate: { ...candidate('rejected') } }));
  const base = {
    fetchTree, createDerivation, getDerivation, generateStep, updateStep,
    confirmCandidate, rejectCandidate,
    createTree: vi.fn(), updateTree: vi.fn(), createNode: vi.fn(), updateNode: vi.fn(),
    deleteNode: vi.fn(), moveNode: vi.fn(), assignGroup: vi.fn(),
    updatePositions: vi.fn(async () => ({ updated: 0 })),
    createLink: vi.fn(), deleteLink: vi.fn(), createGroup: vi.fn(), updateGroup: vi.fn(),
    deleteGroup: vi.fn(), exportTree: vi.fn(), importTree: vi.fn(), updateDerivation: vi.fn(),
    createCandidate: vi.fn()
  };
  return {
    client: base as unknown as PlotClient,
    fetchTree, createDerivation, updateStep, confirmCandidate, rejectCandidate
  };
}

/** 面板要求先选中起点节点 */
function SelectStart(): null {
  const store = usePlotStore();
  const firstId = store.data.nodes[0]?.id;
  useEffect(() => {
    if (firstId) store.selectNode(firstId);
    // 只在首个节点出现时选中一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstId]);
  return null;
}

function renderPanel(
  detail: PlotSessionDetail = { session, steps: [], candidates: [] },
  pollIntervalMs = 1_000_000,
  extras: { taskId?: string; subscribeEvents?: typeof subscribeTaskEvents } = {}
) {
  const mocks = makeMocks(detail, extras.taskId);
  render(
    <PlotStoreProvider workId={workId} client={mocks.client}>
      <SelectStart />
      <PlotDerivationPanel
        workId={workId}
        client={mocks.client}
        pollIntervalMs={pollIntervalMs}
        {...(extras.subscribeEvents ? { subscribeEvents: extras.subscribeEvents } : {})}
      />
    </PlotStoreProvider>
  );
  return mocks;
}

describe('PlotDerivationPanel', () => {
  it('requires place and background before starting', async () => {
    const mocks = renderPanel();
    const form = (await screen.findByRole('button', { name: '开始推衍' })).closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('场所与核心背景为必填项'));
    expect(mocks.createDerivation).not.toHaveBeenCalled();
  });

  it('requires at least one participating character', async () => {
    const mocks = renderPanel();
    await screen.findByRole('button', { name: '开始推衍' });
    await userEvent.type(screen.getByLabelText('场所'), '客栈');
    await userEvent.type(screen.getByLabelText('核心背景'), '主角被追杀');
    await userEvent.click(screen.getByRole('button', { name: '开始推衍' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('至少录入 1 个参与角色'));
    expect(mocks.createDerivation).not.toHaveBeenCalled();
  });

  it('creates a session with the configured payload and starts step one', async () => {
    const mocks = renderPanel();
    await screen.findByRole('button', { name: '开始推衍' });
    await userEvent.type(screen.getByLabelText('场所'), '客栈');
    await userEvent.type(screen.getByLabelText('核心背景'), '主角被追杀');
    await userEvent.type(screen.getByLabelText('角色 1 名称'), '林澈');
    await userEvent.type(screen.getByLabelText('角色 1 设定'), '剑客');
    await userEvent.click(screen.getByRole('checkbox', { name: '随机新角色入场' }));
    await userEvent.click(screen.getByRole('button', { name: '开始推衍' }));

    await waitFor(() => expect(mocks.createDerivation).toHaveBeenCalledWith(workId, {
      start_node_id: 'a',
      place: '客栈',
      background: '主角被追杀',
      time_node: null,
      premise_node_ids: [],
      related_node_ids: [],
      characters: [{ name: '林澈', description: '剑客' }],
      random_enabled: true,
      random_character_enabled: false
    }));
    expect(mocks.client.generateStep).toHaveBeenCalledWith(workId, 'sess-1');
  });

  it('saves edited step content together with the chosen branch', async () => {
    const mocks = renderPanel({ session, steps: [step], candidates: [] });
    await screen.findByRole('button', { name: '开始推衍' });
    await userEvent.type(screen.getByLabelText('场所'), '客栈');
    await userEvent.type(screen.getByLabelText('核心背景'), '主角被追杀');
    await userEvent.type(screen.getByLabelText('角色 1 名称'), '林澈');
    await userEvent.click(screen.getByRole('button', { name: '开始推衍' }));

    expect(await screen.findByRole('heading', { name: '第 1 步' })).toBeVisible();
    const editor = screen.getByLabelText('本步内容');
    await userEvent.clear(editor);
    await userEvent.type(editor, '新的内容');
    await userEvent.click(screen.getByRole('radio', { name: /继续追击/ }));
    await userEvent.click(screen.getByRole('button', { name: '保存本步' }));

    await waitFor(() => expect(mocks.updateStep).toHaveBeenCalledWith(workId, 'sess-1', 1, {
      content: '新的内容',
      chosen_branch_id: 'b1'
    }));
  });

  it('confirms a candidate, reloads the tree and selects the created node', async () => {
    const mocks = renderPanel({ session, steps: [step], candidates: [candidate('pending')] }, 10);
    await screen.findByRole('button', { name: '开始推衍' });
    await userEvent.type(screen.getByLabelText('场所'), '客栈');
    await userEvent.type(screen.getByLabelText('核心背景'), '主角被追杀');
    await userEvent.type(screen.getByLabelText('角色 1 名称'), '林澈');
    await userEvent.click(screen.getByRole('button', { name: '开始推衍' }));
    await screen.findByRole('button', { name: '确认回写' });

    await userEvent.click(screen.getByRole('button', { name: '确认回写' }));
    await waitFor(() => expect(mocks.confirmCandidate).toHaveBeenCalledWith(workId, 'sess-1', 'cand-1', 1));
    // 回写后整树重载
    await waitFor(() => expect(mocks.fetchTree).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('候选已写入剧情树')).toBeVisible();
  });

  it('rejects a candidate without touching the tree', async () => {
    const mocks = renderPanel({ session, steps: [step], candidates: [candidate('pending')] }, 10);
    await screen.findByRole('button', { name: '开始推衍' });
    await userEvent.type(screen.getByLabelText('场所'), '客栈');
    await userEvent.type(screen.getByLabelText('核心背景'), '主角被追杀');
    await userEvent.type(screen.getByLabelText('角色 1 名称'), '林澈');
    await userEvent.click(screen.getByRole('button', { name: '开始推衍' }));
    await screen.findByRole('button', { name: '拒绝' });

    await userEvent.click(screen.getByRole('button', { name: '拒绝' }));
    await waitFor(() => expect(mocks.rejectCandidate).toHaveBeenCalledWith(workId, 'sess-1', 'cand-1'));
    expect(mocks.fetchTree).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('候选已拒绝，剧情树保持不变')).toBeVisible();
  });

  it('watches the step task over SSE and refreshes the session on success', async () => {
    const subscriptions: SubscribeOptions[] = [];
    const close = vi.fn();
    const subscribeEvents = vi.fn((_workId: string, _taskId: string, options: SubscribeOptions) => {
      subscriptions.push(options);
      return { close, getState: () => 'open' as const };
    });
    const mocks = renderPanel(
      { session: { ...session, status: 'running' }, steps: [], candidates: [] },
      1_000_000,
      { taskId: 'task-1', subscribeEvents }
    );
    await screen.findByRole('button', { name: '开始推衍' });
    await userEvent.type(screen.getByLabelText('场所'), '客栈');
    await userEvent.type(screen.getByLabelText('核心背景'), '主角被追杀');
    await userEvent.type(screen.getByLabelText('角色 1 名称'), '林澈');
    await userEvent.click(screen.getByRole('button', { name: '开始推衍' }));

    await waitFor(() => expect(subscribeEvents).toHaveBeenCalledWith(workId, 'task-1', expect.any(Object)));
    const getDerivation = mocks.client.getDerivation as ReturnType<typeof vi.fn>;
    getDerivation.mockClear();

    subscriptions[0]!.onEvent({ seq: 2, type: 'succeeded', payload: { step_no: 1 } } satisfies TaskEvent);

    await waitFor(() => expect(getDerivation).toHaveBeenCalledWith(workId, 'sess-1'));
    expect(close).toHaveBeenCalled();
    expect(await screen.findByText(/已生成，已自动暂停/)).toBeVisible();
  });

  it('falls back to polling when the SSE channel errors', async () => {
    const subscriptions: SubscribeOptions[] = [];
    const subscribeEvents = vi.fn((_workId: string, _taskId: string, options: SubscribeOptions) => {
      subscriptions.push(options);
      return { close: vi.fn(), getState: () => 'connecting' as const };
    });
    const mocks = renderPanel(
      { session, steps: [step], candidates: [] },
      10,
      { taskId: 'task-1', subscribeEvents }
    );
    await screen.findByRole('button', { name: '开始推衍' });
    await userEvent.type(screen.getByLabelText('场所'), '客栈');
    await userEvent.type(screen.getByLabelText('核心背景'), '主角被追杀');
    await userEvent.type(screen.getByLabelText('角色 1 名称'), '林澈');
    await userEvent.click(screen.getByRole('button', { name: '开始推衍' }));

    await waitFor(() => expect(subscribeEvents).toHaveBeenCalled());
    const getDerivation = mocks.client.getDerivation as ReturnType<typeof vi.fn>;
    getDerivation.mockClear();

    subscriptions[0]!.onError?.(new Error('sse unavailable'));

    await waitFor(() => expect(getDerivation).toHaveBeenCalledWith(workId, 'sess-1'));
  });
});
