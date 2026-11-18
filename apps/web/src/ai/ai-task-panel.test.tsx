import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AiTask } from '@storyforge/contracts';
import { AiTaskPanel } from './ai-task-panel';
import { createAiTask, listAiTasks, cancelAiTask, retryAiTask, subscribeTaskEvents } from './ai-client';
import type { TaskEvent } from './ai-client';

vi.mock('./ai-client', () => ({
  createAiTask: vi.fn(),
  listAiTasks: vi.fn(),
  cancelAiTask: vi.fn(),
  retryAiTask: vi.fn(),
  subscribeTaskEvents: vi.fn()
}));

const workId = crypto.randomUUID();
const chapterId = crypto.randomUUID();
const now = new Date().toISOString();

function task(overrides: Partial<AiTask> = {}): AiTask {
  return {
    id: crypto.randomUUID(),
    work_id: workId,
    chapter_id: chapterId,
    scope: 'chapter',
    tool: 'continue',
    agent_id: null,
    input_summary: {},
    base_version: 0,
    status: 'queued',
    event_seq: 0,
    result_revision_set_id: null,
    error: null,
    attempts: 0,
    created_by: crypto.randomUUID(),
    created_at: now,
    updated_at: now,
    ...overrides
  };
}

/** 记录 subscribeTaskEvents 每次调用拿到的 onEvent 回调，供测试手动触发事件帧 */
const streams: Array<{ onEvent: (event: TaskEvent) => void }> = [];

function mockStream() {
  const stream = { close: vi.fn(), getState: vi.fn().mockReturnValue('open' as const) };
  vi.mocked(subscribeTaskEvents).mockImplementation((_w, _t, options) => {
    streams.push({ onEvent: options.onEvent });
    return stream;
  });
  return stream;
}

beforeEach(() => {
  streams.length = 0;
  vi.clearAllMocks();
});

describe('AiTaskPanel', () => {
  it('loads and renders the task list with status badges and empty state', async () => {
    vi.mocked(listAiTasks).mockResolvedValue({
      tasks: [
        task({ id: 't-1', tool: 'continue', status: 'succeeded', input_summary: { note: '续写第三章' } }),
        task({ id: 't-2', tool: 'rewrite', status: 'failed', error: { message: '模型超时' } }),
        task({ id: 't-3', tool: 'polish', status: 'queued' })
      ],
      total: 3, page: 1, page_size: 50
    });
    mockStream();

    render(<AiTaskPanel workId={workId} chapterId={chapterId} />);

    expect(await screen.findByRole('heading', { name: 'AI 创作' })).toBeVisible();
    expect(await screen.findByText('续写第三章')).toBeVisible();
    expect(screen.getByText('已完成')).toBeVisible();
    expect(screen.getByText('失败')).toBeVisible();
    expect(screen.getByText('模型超时')).toBeVisible();
    expect(screen.getByText('排队中')).toBeVisible();
    // 仅活跃任务（queued/running）订阅 SSE，且带任务级 aria-label
    expect(subscribeTaskEvents).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('progressbar', { name: '任务进度' })).toBeVisible();
  });

  it('shows the empty message when no tasks exist', async () => {
    vi.mocked(listAiTasks).mockResolvedValue({ tasks: [], total: 0, page: 1, page_size: 50 });
    render(<AiTaskPanel workId={workId} chapterId={chapterId} />);

    expect(await screen.findByText('暂无 AI 任务')).toBeVisible();
  });

  it('appends progress events and updates the progress bar from the SSE stream', async () => {
    vi.mocked(listAiTasks).mockResolvedValue({ tasks: [task({ id: 't-1', status: 'running' })], total: 1, page: 1, page_size: 50 });
    mockStream();

    render(<AiTaskPanel workId={workId} chapterId={chapterId} />);
    await screen.findByRole('progressbar', { name: '任务进度' });

    // 模拟服务端推送进度事件
    const stream = streams[0]!;
    act(() => {
      stream.onEvent({ seq: 1, type: 'running', payload: { message: 'AI 开始生成' } });
      stream.onEvent({ seq: 2, type: 'progress', payload: { progress: 40, stage: '改写中·第 2/5 段' } });
    });

    const bar = await screen.findByRole('progressbar', { name: '任务进度' });
    expect(bar).toHaveAttribute('aria-valuenow', '40');
    expect(await screen.findByText('40%')).toBeVisible();
    expect(screen.getByText('进度更新')).toBeVisible();
    expect(screen.getByText('改写中·第 2/5 段')).toBeVisible();
  });

  it('synchronizes task status from a snapshot frame without adding it to the event list', async () => {
    vi.mocked(listAiTasks).mockResolvedValue({ tasks: [task({ id: 't-1', status: 'running' })], total: 1, page: 1, page_size: 50 });
    mockStream();

    render(<AiTaskPanel workId={workId} chapterId={chapterId} />);
    await screen.findByRole('progressbar', { name: '任务进度' });

    const stream = streams[0]!;
    act(() => {
      stream.onEvent({ seq: 5, type: 'snapshot', payload: { status: 'succeeded' } });
    });

    // 状态同步为终态，进度条消失（不再活跃）
    expect(await screen.findByText('已完成')).toBeVisible();
    expect(screen.queryByRole('progressbar', { name: '任务进度' })).not.toBeInTheDocument();
  });

  it('submits a new AI task and reloads the list', async () => {
    vi.mocked(listAiTasks).mockResolvedValue({ tasks: [], total: 0, page: 1, page_size: 50 });
    vi.mocked(createAiTask).mockResolvedValue({ task: task({ id: 't-new', status: 'queued' }) });
    mockStream();

    render(<AiTaskPanel workId={workId} chapterId={chapterId} />);
    await screen.findByText('暂无 AI 任务');

    await userEvent.selectOptions(screen.getByLabelText('创作工具'), 'rewrite');
    await userEvent.type(screen.getByLabelText('补充说明（可选）'), '让主角在雨中第一次遇见对手');
    await userEvent.click(screen.getByRole('button', { name: '发起创作' }));

    await waitFor(() => expect(createAiTask).toHaveBeenCalledWith(workId, chapterId, expect.objectContaining({
      tool: 'rewrite',
      input_summary: { note: '让主角在雨中第一次遇见对手' }
    })));
    await waitFor(() => expect(listAiTasks).toHaveBeenCalledTimes(2));
  });

  it('cancels an active task', async () => {
    vi.mocked(listAiTasks).mockResolvedValue({ tasks: [task({ id: 't-1', status: 'running' })], total: 1, page: 1, page_size: 50 });
    vi.mocked(cancelAiTask).mockResolvedValue({ task: task({ id: 't-1', status: 'cancelled' }) });
    mockStream();

    render(<AiTaskPanel workId={workId} chapterId={chapterId} />);
    await screen.findByRole('button', { name: '取消' });

    await userEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(cancelAiTask).toHaveBeenCalledWith(workId, 't-1'));
    // 取消后重新加载列表（终态不再活跃，不订阅）
    await waitFor(() => expect(listAiTasks).toHaveBeenCalledTimes(2));
  });

  it('retries a failed task', async () => {
    vi.mocked(listAiTasks).mockResolvedValue({ tasks: [task({ id: 't-1', status: 'failed', error: { message: '模型超时' } })], total: 1, page: 1, page_size: 50 });
    vi.mocked(retryAiTask).mockResolvedValue({ task: task({ id: 't-1', status: 'queued' }) });

    render(<AiTaskPanel workId={workId} chapterId={chapterId} />);
    await screen.findByRole('button', { name: '重试' });

    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(retryAiTask).toHaveBeenCalledWith(workId, 't-1'));
  });

  it('closes all SSE streams on unmount', async () => {
    vi.mocked(listAiTasks).mockResolvedValue({ tasks: [task({ id: 't-1', status: 'running' })], total: 1, page: 1, page_size: 50 });
    const stream = mockStream();

    const { unmount } = render(<AiTaskPanel workId={workId} chapterId={chapterId} />);
    await screen.findByRole('progressbar', { name: '任务进度' });

    unmount();
    expect(stream.close).toHaveBeenCalled();
  });
});
