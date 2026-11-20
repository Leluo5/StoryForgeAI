import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CharacterGrowthEvent } from '@storyforge/contracts';
import { ApiError } from '../api/client';
import type { CharacterClient } from './character-client';
import { CharacterGrowthPanel } from './character-growth-panel';

// 硬约束：用 mock client，不连真实后端
const workId = '11111111-1111-4111-8111-111111111111';
const characterId = '22222222-2222-4222-8222-222222222222';
const otherCharacterId = '33333333-3333-4333-8333-333333333333';
const chapterId = '44444444-4444-4444-8444-444444444444';
const plotNodeId = '55555555-5555-4555-8555-555555555555';

function uid(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

function makeEvent(seed: number, overrides: Partial<CharacterGrowthEvent> = {}): CharacterGrowthEvent {
  return {
    id: uid(seed),
    work_id: workId,
    character_id: characterId,
    title: `事件${seed}`,
    content: '',
    event_time: '2020-01-01',
    plot_node_id: null,
    plot_node_title: null,
    chapter_id: null,
    status: 'active',
    archived_at: null,
    origin: 'manual',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides
  };
}

function makeClient(overrides: Partial<CharacterClient> = {}): CharacterClient {
  return {
    listGrowthEvents: vi.fn(async () => []),
    createGrowthEvent: vi.fn(),
    updateGrowthEvent: vi.fn(),
    deleteGrowthEvent: vi.fn(),
    ...overrides
  } as unknown as CharacterClient;
}

function renderPanel(client: CharacterClient, targetCharacterId = characterId) {
  return render(<CharacterGrowthPanel workId={workId} characterId={targetCharacterId} client={client} />);
}

describe('CharacterGrowthPanel T36', () => {
  it('事件按时间字符串升序，未标注时间的排最后', async () => {
    const client = makeClient({
      listGrowthEvents: vi.fn(async () => [
        makeEvent(3, { title: '无名之事', event_time: null }),
        makeEvent(1, { title: '早年', event_time: '2019-05-01' }),
        makeEvent(2, { title: '后来', event_time: '2020-01-01' })
      ])
    });
    renderPanel(client);

    const list = await screen.findByRole('list', { name: '成长事件时间线' });
    const titles = within(list)
      .getAllByRole('listitem')
      .map((item) => item.querySelector('h3')?.textContent);
    expect(titles).toEqual(['早年', '后来', '无名之事']);
    expect(screen.getByText('未标注时间')).toBeVisible();
    expect(list.textContent).toContain('2019-05-01');
    expect(list.textContent).toContain('2020-01-01');
  });

  it('新增时提交 UUID 关联，warning 可见且新事件进入时间线', async () => {
    const created = makeEvent(10, {
      title: '拜师',
      event_time: '第三卷·春',
      plot_node_id: plotNodeId,
      plot_node_title: '拜师礼',
      chapter_id: chapterId
    });
    const createGrowthEvent = vi.fn(async () => ({
      event: created,
      warnings: ['剧情节点不存在，已忽略该关联']
    }));
    const client = makeClient({ createGrowthEvent });
    renderPanel(client);

    await screen.findByText('还没有成长事件，新增后按时间顺序展示。');
    await userEvent.type(screen.getByLabelText('标题'), '拜师');
    await userEvent.type(screen.getByLabelText('时间'), '第三卷·春');
    await userEvent.type(screen.getByLabelText('剧情节点 ID'), plotNodeId);
    await userEvent.type(screen.getByLabelText('章节 ID'), chapterId);
    await userEvent.click(screen.getByRole('button', { name: '新增事件' }));

    await waitFor(() => expect(createGrowthEvent).toHaveBeenCalledTimes(1));
    expect(createGrowthEvent).toHaveBeenCalledWith(workId, characterId, {
      title: '拜师',
      content: '',
      event_time: '第三卷·春',
      plot_node_id: plotNodeId,
      chapter_id: chapterId
    });
    expect(await screen.findByText('剧情节点不存在，已忽略该关联')).toBeVisible();
    expect(screen.getByText('拜师礼', { exact: false })).toBeVisible();
    expect(screen.getByRole('list', { name: '成长事件时间线' }).textContent).toContain('拜师');
  });

  it('非法 UUID 在保存前拦截并给出可读提示', async () => {
    const createGrowthEvent = vi.fn();
    const client = makeClient({ createGrowthEvent });
    renderPanel(client);
    await screen.findByText('还没有成长事件，新增后按时间顺序展示。');

    await userEvent.type(screen.getByLabelText('标题'), '断桥');
    await userEvent.type(screen.getByLabelText('章节 ID'), 'chapter-1');
    await userEvent.click(screen.getByRole('button', { name: '新增事件' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('UUID');
    expect(createGrowthEvent).not.toHaveBeenCalled();
  });

  it('编辑已有事件并回写时间线', async () => {
    const source = makeEvent(1, { title: '旧标题', event_time: '2019-01-01' });
    const updateGrowthEvent = vi.fn(async () => ({
      event: { ...source, title: '新标题', event_time: '2021-01-01' }
    }));
    const client = makeClient({
      listGrowthEvents: vi.fn(async () => [source]),
      updateGrowthEvent
    });
    renderPanel(client);
    await screen.findByText('旧标题');

    await userEvent.click(screen.getByRole('button', { name: '编辑' }));
    const titleInput = screen.getByLabelText('标题');
    expect(titleInput).toHaveValue('旧标题');
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, '新标题');
    await userEvent.clear(screen.getByLabelText('时间'));
    await userEvent.type(screen.getByLabelText('时间'), '2021-01-01');
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));

    await waitFor(() => expect(updateGrowthEvent).toHaveBeenCalledTimes(1));
    expect(updateGrowthEvent).toHaveBeenCalledWith(workId, characterId, source.id, {
      title: '新标题',
      content: '',
      event_time: '2021-01-01',
      plot_node_id: null,
      chapter_id: null
    });
    expect(await screen.findByText('新标题')).toBeVisible();
  });

  it('跳转章节仅在存在 chapter_id 时可用，并携带角色 ID', async () => {
    const withChapter = makeEvent(1, { title: '断桥相认', chapter_id: chapterId });
    const withoutChapter = makeEvent(2, { title: '无章节之事', event_time: null });
    const onOpenChapter = vi.fn();
    const client = makeClient({ listGrowthEvents: vi.fn(async () => [withChapter, withoutChapter]) });
    render(
      <CharacterGrowthPanel workId={workId} characterId={characterId} client={client} onOpenChapter={onOpenChapter} />
    );

    const linkedRow = (await screen.findByText('断桥相认')).closest('li');
    expect(linkedRow).not.toBeNull();
    const jump = within(linkedRow as HTMLElement).getByRole('button', { name: '跳转章节' });
    expect(jump).toBeEnabled();
    await userEvent.click(jump);
    expect(onOpenChapter).toHaveBeenCalledWith(chapterId, characterId);

    const plainRow = screen.getByText('无章节之事').closest('li') as HTMLElement;
    expect(within(plainRow).getByRole('button', { name: '跳转章节' })).toBeDisabled();
  });

  it('删除需要二次确认，确认后才调用接口', async () => {
    const event = makeEvent(1, { title: '该被删掉的事' });
    const deleteGrowthEvent = vi.fn(async () => ({ deleted: true as const }));
    const client = makeClient({
      listGrowthEvents: vi.fn(async () => [event]),
      deleteGrowthEvent
    });
    renderPanel(client);
    await screen.findByText('该被删掉的事');

    await userEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(deleteGrowthEvent).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog', { name: '确认删除成长事件' });
    await userEvent.click(within(dialog).getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(deleteGrowthEvent).toHaveBeenCalledWith(workId, characterId, event.id));
    await waitFor(() => expect(screen.queryByText('该被删掉的事')).toBeNull());
  });

  it('加载失败展示可读错误', async () => {
    const client = makeClient({
      listGrowthEvents: vi.fn(async () => {
        throw new ApiError(500, 'INTERNAL', '成长线读取失败', {}, 'req-1');
      })
    });
    renderPanel(client);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('成长线读取失败');
  });

  it('characterId 变化时重新加载对应角色的成长线', async () => {
    const listGrowthEvents = vi.fn(async (_workId: string, targetId: string) => [
      makeEvent(1, { title: targetId === characterId ? '角色一事件' : '角色二事件', character_id: targetId })
    ]);
    const client = makeClient({ listGrowthEvents });
    const view = renderPanel(client, characterId);
    await screen.findByText('角色一事件');

    view.rerender(
      <CharacterGrowthPanel workId={workId} characterId={otherCharacterId} client={client} />
    );

    expect(await screen.findByText('角色二事件')).toBeVisible();
    expect(listGrowthEvents).toHaveBeenCalledWith(workId, otherCharacterId);
    expect(listGrowthEvents).toHaveBeenCalledTimes(2);
  });
});
