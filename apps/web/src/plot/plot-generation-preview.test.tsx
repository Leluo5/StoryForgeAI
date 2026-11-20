import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PlotGenerationDraft, PlotNode, PlotTree } from '@storyforge/contracts';
import type { SubscribeOptions, TaskEvent } from '../ai/ai-client';
import { subscribeTaskEvents } from '../ai/ai-client';
import type { PlotClient } from './plot-client';
import { PlotStoreProvider } from './plot-workspace';
import { PlotGenerationPreview } from './plot-generation-preview';

const workId = '11111111-1111-4111-8111-111111111111';
const treeId = '22222222-2222-4222-8222-222222222222';
const now = new Date().toISOString();

const payload = {
  nodes: [
    { title: '返乡', summary: '主角回到家乡', content: '家乡已经物是人非', parent_index: null },
    { title: '旧案', summary: '发现旧案线索', content: '旧案另有隐情', parent_index: 0 }
  ]
};

function draft(status: PlotGenerationDraft['status'], overrides: Partial<PlotGenerationDraft> = {}): PlotGenerationDraft {
  return {
    id: 'gen-1',
    work_id: workId,
    source: 'outline',
    input_text: '第一幕：主角回到家乡。第二幕：发现旧案。',
    input_chapter_id: null,
    status,
    payload: status === 'succeeded' ? payload : null,
    error: null,
    task_id: 'task-1',
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

interface Mocks {
  client: PlotClient;
  createGeneration: ReturnType<typeof vi.fn>;
  getGeneration: ReturnType<typeof vi.fn>;
  updateGeneration: ReturnType<typeof vi.fn>;
  commitGeneration: ReturnType<typeof vi.fn>;
  discardGeneration: ReturnType<typeof vi.fn>;
}

function makeMocks(initial: PlotGenerationDraft = draft('pending'), treeNodes: PlotNode[] = []): Mocks {
  const tree: PlotTree = {
    id: treeId, work_id: workId, title: '主线', source: 'manual',
    schema_version: 1, version: 1, created_at: now, updated_at: now
  };
  const createGeneration = vi.fn(async () => ({ draft: initial }));
  const getGeneration = vi.fn(async () => ({ draft: draft('succeeded') }));
  const updateGeneration = vi.fn(async (_workId: string, _draftId: string, next: PlotGenerationDraft['payload']) => ({
    draft: { ...draft('succeeded'), payload: next }
  }));
  const commitGeneration = vi.fn(async () => ({ draft: draft('committed'), version: 2 }));
  const discardGeneration = vi.fn(async () => ({ draft: draft('discarded') }));
  const base = {
    fetchTree: vi.fn(async () => ({
      tree: treeNodes.length > 0 ? tree : null,
      nodes: treeNodes,
      links: [],
      groups: []
    })),
    createGeneration,
    getGeneration,
    updateGeneration,
    commitGeneration,
    discardGeneration,
    createTree: vi.fn(), updateTree: vi.fn(), createNode: vi.fn(), updateNode: vi.fn(),
    deleteNode: vi.fn(), moveNode: vi.fn(), assignGroup: vi.fn(),
    updatePositions: vi.fn(), createLink: vi.fn(), deleteLink: vi.fn(),
    createGroup: vi.fn(), updateGroup: vi.fn(), deleteGroup: vi.fn(),
    exportTree: vi.fn(), importTree: vi.fn(),
    createDerivation: vi.fn(), getDerivation: vi.fn(), updateDerivation: vi.fn(),
    generateStep: vi.fn(), updateStep: vi.fn(), createCandidate: vi.fn(),
    confirmCandidate: vi.fn(), rejectCandidate: vi.fn()
  };
  return {
    client: base as unknown as PlotClient,
    createGeneration, getGeneration, updateGeneration, commitGeneration, discardGeneration
  };
}

interface Extras {
  subscribeEvents?: typeof subscribeTaskEvents;
  loadChapters?: (workId: string) => Promise<Array<{ id: string; title: string }>>;
}

function renderPreview(mocks: Mocks, extras: Extras = {}) {
  const onClose = vi.fn();
  render(
    <PlotStoreProvider workId={workId} client={mocks.client}>
      <PlotGenerationPreview
        workId={workId}
        client={mocks.client}
        onClose={onClose}
        pollIntervalMs={1_000_000}
        {...(extras.subscribeEvents ? { subscribeEvents: extras.subscribeEvents } : {})}
        {...(extras.loadChapters ? { loadChapters: extras.loadChapters } : {})}
      />
    </PlotStoreProvider>
  );
  return { onClose, mocks };
}

const outline = '第一幕：主角回到家乡。第二幕：发现旧案。';

async function openPreview(mocks: Mocks): Promise<void> {
  await waitFor(() => expect(mocks.client.fetchTree).toHaveBeenCalled());
  await userEvent.type(screen.getByLabelText('大纲内容'), outline);
  await userEvent.click(screen.getByRole('button', { name: '开始解析' }));
  await screen.findByLabelText('节点 1 标题');
}

describe('PlotGenerationPreview', () => {
  it('parses an outline, watches the task and shows the editable preview', async () => {
    const subscriptions: SubscribeOptions[] = [];
    const subscribeEvents = vi.fn((_workId: string, _taskId: string, options: SubscribeOptions) => {
      subscriptions.push(options);
      return { close: vi.fn(), getState: () => 'open' as const };
    });
    const mocks = makeMocks();
    renderPreview(mocks, { subscribeEvents });
    const text = '第一幕：主角回到家乡。第二幕：发现旧案。';

    await waitFor(() => expect(mocks.client.fetchTree).toHaveBeenCalled());
    await userEvent.type(screen.getByLabelText('大纲内容'), text);
    await userEvent.click(screen.getByRole('button', { name: '开始解析' }));

    await waitFor(() => expect(mocks.createGeneration).toHaveBeenCalledWith(workId, { source: 'outline', text }));
    await waitFor(() => expect(subscribeEvents).toHaveBeenCalledWith(workId, 'task-1', expect.any(Object)));

    subscriptions[0]!.onEvent({ seq: 2, type: 'succeeded', payload: {} } satisfies TaskEvent);

    await waitFor(() => expect(mocks.getGeneration).toHaveBeenCalledWith(workId, 'gen-1'));
    expect(await screen.findByLabelText('节点 1 标题')).toHaveValue('返乡');
    expect(screen.getByLabelText('节点 2 标题')).toHaveValue('旧案');
  });

  it('saves edited nodes and only replaces the tree after explicit confirmation', async () => {
    const mocks = makeMocks(draft('succeeded'));
    const { onClose } = renderPreview(mocks);
    await openPreview(mocks);

    const title = screen.getByLabelText('节点 1 标题');
    await userEvent.clear(title);
    await userEvent.type(title, '返乡（修订）');
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(mocks.updateGeneration).toHaveBeenCalledWith(workId, 'gen-1', {
      nodes: [
        { title: '返乡（修订）', summary: '主角回到家乡', content: '家乡已经物是人非', parent_index: null },
        { title: '旧案', summary: '发现旧案线索', content: '旧案另有隐情', parent_index: 0 }
      ]
    }));

    const submit = screen.getByRole('button', { name: '提交到剧情树' });
    expect(submit).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: '我确认覆盖现有剧情树' }));
    await userEvent.click(submit);

    await waitFor(() => expect(mocks.commitGeneration).toHaveBeenCalledWith(workId, 'gen-1', {
      mode: 'replace', confirm_overwrite: true
    }));
    expect(onClose).toHaveBeenCalled();
  });

  it('appends the draft beneath the selected existing node', async () => {
    const parentNode: PlotNode = {
      id: 'node-1', tree_id: treeId, parent_id: null, sibling_order: 0, title: '既有主线',
      summary: null, content: '', attributes: {}, position: { x: 0, y: 0 }, group_id: null,
      origin: 'manual', created_at: now, updated_at: now
    };
    const mocks = makeMocks(draft('succeeded'), [parentNode]);
    renderPreview(mocks);
    await openPreview(mocks);

    await userEvent.click(screen.getByRole('radio', { name: '追加为子树' }));
    await userEvent.selectOptions(screen.getByLabelText('挂接父节点'), 'node-1');
    await userEvent.click(screen.getByRole('button', { name: '提交到剧情树' }));

    await waitFor(() => expect(mocks.commitGeneration).toHaveBeenCalledWith(workId, 'gen-1', {
      mode: 'append', parent_node_id: 'node-1', confirm_overwrite: false
    }));
  });

  it('keeps the input on failure and offers retry or manual building', async () => {
    const mocks = makeMocks(draft('failed'));
    const { onClose } = renderPreview(mocks);
    await waitFor(() => expect(mocks.client.fetchTree).toHaveBeenCalled());
    await userEvent.type(screen.getByLabelText('大纲内容'), outline);
    await userEvent.click(screen.getByRole('button', { name: '开始解析' }));

    expect(await screen.findByRole('heading', { name: '解析失败' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '重新解析' }));
    await waitFor(() => expect(mocks.createGeneration).toHaveBeenCalledTimes(2));
    expect(mocks.createGeneration).toHaveBeenLastCalledWith(workId, { source: 'outline', text: outline });

    await userEvent.click(screen.getByRole('button', { name: '转手动建树' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('discards a draft without submitting it', async () => {
    const mocks = makeMocks(draft('succeeded'));
    const { onClose } = renderPreview(mocks);
    await openPreview(mocks);

    await userEvent.click(screen.getByRole('button', { name: '丢弃草稿' }));
    await waitFor(() => expect(mocks.discardGeneration).toHaveBeenCalledWith(workId, 'gen-1'));
    expect(mocks.commitGeneration).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('parses a chapter from the selected work chapter', async () => {
    const loadChapters = vi.fn(async () => [{ id: 'ch-1', title: '第一章' }]);
    const mocks = makeMocks(draft('pending'));
    renderPreview(mocks, { loadChapters });
    await waitFor(() => expect(mocks.client.fetchTree).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('radio', { name: '章节正文' }));
    await waitFor(() => expect(screen.getByLabelText('章节')).toHaveTextContent('第一章'));
    await userEvent.selectOptions(screen.getByLabelText('章节'), 'ch-1');
    await userEvent.click(screen.getByRole('button', { name: '开始解析' }));

    await waitFor(() => expect(mocks.createGeneration).toHaveBeenCalledWith(workId, {
      source: 'novel_text', chapter_id: 'ch-1'
    }));
  });
});
