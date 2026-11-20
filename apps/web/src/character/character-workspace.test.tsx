import { createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CharacterBoardResponse } from '@storyforge/contracts';
import { ApiError } from '../api/client';
import type { CharacterClient } from './character-client';
import { CharacterWorkspace } from './character-workspace';

// 硬约束：用 mock client，不连真实后端
vi.mock('./character-client');

const workId = '11111111-1111-4111-8111-111111111111';
const viewId = 'vvvvvvvv-vvvv-4vvv-8vvv-vvvvvvvvvvvv';

function uid(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

type BoardCharacter = CharacterBoardResponse['characters'][number];
type BoardRelation = CharacterBoardResponse['relations'][number];
type BoardLayout = CharacterBoardResponse['layout'];

function makeCharacter(seed: number, overrides: Partial<BoardCharacter> = {}): BoardCharacter {
  return {
    id: uid(seed),
    name: `角色${seed}`,
    status: 'active',
    avatar_asset_id: null,
    six_dim: {
      country_region: '中原',
      faith: '道家',
      faction: seed % 2 === 0 ? '正派' : '邪派',
      race: '汉人',
      occupation: '侠客',
      age_band: '青年'
    },
    ...overrides
  };
}

function makeRelation(seed: number, sourceId: string, targetId: string, overrides: Partial<BoardRelation> = {}): BoardRelation {
  return {
    id: uid(1000 + seed),
    source_id: sourceId,
    target_id: targetId,
    type_id: uid(2000 + seed),
    directed: true,
    label: `关系${seed}`,
    reverse_label: null,
    color: '#3b82f6',
    line_style: 'solid',
    tag: `标签${seed}`,
    ...overrides
  };
}

function makeBoard(
  characters: BoardCharacter[],
  relations: BoardRelation[] = [],
  layout: BoardLayout = []
): CharacterBoardResponse {
  return {
    view: { id: viewId, name: '默认视图', filters: {}, version: 1, is_default: true },
    characters,
    relations,
    relation_types: [],
    layout
  };
}

function makeClient(overrides: Partial<CharacterClient> = {}): CharacterClient {
  const base = {
    listViews: vi.fn(async () => [
      { id: viewId, work_id: workId, name: '默认视图', is_default: true, filters: {}, version: 1, sort_order: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }
    ]),
    getBoard: vi.fn(async () => makeBoard([])),
    updateLayout: vi.fn(async () => ({ updated: 0 }))
  };
  return { ...base, ...overrides } as unknown as CharacterClient;
}

function renderWorkspace(client: CharacterClient) {
  return render(<CharacterWorkspace workId={workId} client={client} enabled />);
}

// jsdom 的 PointerEvent 构造不接受 clientX/clientY 初始化（始终 undefined），
// 这里用 createEvent 创建 React 可识别的 pointer 事件，再通过 defineProperty 注入坐标。
function dispatchPointer(
  el: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
  clientY: number,
  pointerId = 1
) {
  const ctor = { pointerdown: createEvent.pointerDown, pointermove: createEvent.pointerMove, pointerup: createEvent.pointerUp }[type];
  const evt = ctor(el, { pointerId, button: 0 });
  Object.defineProperty(evt, 'clientX', { value: clientX });
  Object.defineProperty(evt, 'clientY', { value: clientY });
  fireEvent(el, evt);
}

describe('CharacterWorkspace T33', () => {
  it('进入页签一次加载 board 并渲染角色卡（先取默认视图）', async () => {
    const client = makeClient({
      getBoard: vi.fn(async () => makeBoard([makeCharacter(1, { name: '林墨' }), makeCharacter(2, { name: '沈星河' })]))
    });
    renderWorkspace(client);

    await waitFor(() => expect(client.listViews).toHaveBeenCalledTimes(1));
    expect(client.listViews).toHaveBeenCalledWith(workId);
    await waitFor(() => expect(client.getBoard).toHaveBeenCalledTimes(1));
    expect(client.getBoard).toHaveBeenCalledWith(workId, viewId);

    expect(await screen.findByRole('button', { name: /林墨/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /沈星河/ })).toBeVisible();
  });

  it('100 角色 / 150 关系可渲染', async () => {
    const characters = Array.from({ length: 100 }, (_, i) => makeCharacter(i + 1));
    const relations: BoardRelation[] = [];
    for (let i = 0; i < 150; i += 1) {
      relations.push(makeRelation(i + 1, characters[i % 100]!.id, characters[(i + 1) % 100]!.id));
    }
    const client = makeClient({ getBoard: vi.fn(async () => makeBoard(characters, relations)) });
    const view = renderWorkspace(client);

    await screen.findByRole('button', { name: /角色1，/ });
    const cards = view.container.querySelectorAll('[data-character-id]');
    expect(cards).toHaveLength(100);
    const edges = view.container.querySelectorAll('[data-character-relation]');
    expect(edges).toHaveLength(150);
  });

  it('拖拽结束一次批量 PUT layout，坐标钳制', async () => {
    const c1 = makeCharacter(1, { name: '林墨' });
    const c2 = makeCharacter(2, { name: '沈星河' });
    const layout: BoardLayout = [
      { character_id: c1.id, x: 100, y: 100, arranged: true, sort_index: 0 },
      { character_id: c2.id, x: 400, y: 100, arranged: true, sort_index: 1 }
    ];
    const client = makeClient({
      getBoard: vi.fn(async () => makeBoard([c1, c2], [], layout)),
      updateLayout: vi.fn(async () => ({ updated: 1 }))
    });
    renderWorkspace(client);

    const card = await screen.findByRole('button', { name: /林墨/ });
    dispatchPointer(card, 'pointerdown', 10, 10);
    dispatchPointer(card, 'pointermove', 60, 10);
    dispatchPointer(card, 'pointerup', 60, 10);

    await waitFor(() => expect(client.updateLayout).toHaveBeenCalledTimes(1));
    expect(client.updateLayout).toHaveBeenCalledWith(workId, viewId, [
      { character_id: c1.id, x: 150, y: 100, arranged: true }
    ]);

    // 坐标钳制 ±1,000,000：拖到极远也被截断
    dispatchPointer(card, 'pointerdown', 10, 10, 2);
    dispatchPointer(card, 'pointermove', 10 + 5_000_000, 10, 2);
    dispatchPointer(card, 'pointerup', 10 + 5_000_000, 10, 2);
    await waitFor(() => expect(client.updateLayout).toHaveBeenCalledTimes(2));
    expect(client.updateLayout).toHaveBeenLastCalledWith(workId, viewId, [
      { character_id: c1.id, x: 1_000_000, y: 100, arranged: true }
    ]);
  });

  it('缩放钳制在 0.25~2 之间', async () => {
    const client = makeClient({ getBoard: vi.fn(async () => makeBoard([makeCharacter(1, { name: '林墨' })])) });
    renderWorkspace(client);
    await screen.findByRole('button', { name: /林墨/ });

    const zoomIn = screen.getByRole('button', { name: '放大画布' });
    const zoomOut = screen.getByRole('button', { name: '缩小画布' });
    const output = screen.getByLabelText('当前缩放');

    for (let i = 0; i < 15; i += 1) fireEvent.click(zoomIn);
    expect(output).toHaveTextContent('200%');

    for (let i = 0; i < 25; i += 1) fireEvent.click(zoomOut);
    expect(output).toHaveTextContent('25%');
  });

  it('筛选结果（关键词 + 六维）可见且结果计数同步', async () => {
    const c1 = makeCharacter(1, { name: '林墨', six_dim: { faction: '正派', occupation: '侠客' } });
    const c2 = makeCharacter(2, { name: '沈星河', six_dim: { faction: '邪派', occupation: '教主' } });
    const client = makeClient({ getBoard: vi.fn(async () => makeBoard([c1, c2])) });
    const view = renderWorkspace(client);
    await screen.findByRole('button', { name: /林墨/ });

    const search = screen.getByLabelText('搜索');
    await userEvent.type(search, '林墨');
    await waitFor(() => expect(screen.getByText('1 个结果')).toBeVisible());
    expect(screen.queryByRole('button', { name: /沈星河/ })).toBeNull();
    expect(screen.getByRole('button', { name: /林墨/ })).toBeVisible();

    await userEvent.clear(search);
    await waitFor(() => expect(screen.getByText('2 个结果')).toBeVisible());

    const factionSelect = view.container.querySelector<HTMLSelectElement>('[data-character-dim="faction"]')!;
    fireEvent.change(factionSelect, { target: { value: '邪派' } });
    await waitFor(() => expect(screen.getByText('1 个结果')).toBeVisible());
    expect(screen.queryByRole('button', { name: /林墨/ })).toBeNull();
    expect(screen.getByRole('button', { name: /沈星河/ })).toBeVisible();
  });

  it('有方向关系加箭头 marker、无方向不加；线型与标签 chip 始终显示，颜色只用于描边', async () => {
    const c1 = makeCharacter(1, { name: 'A' });
    const c2 = makeCharacter(2, { name: 'B' });
    const c3 = makeCharacter(3, { name: 'C' });
    const directed = makeRelation(1, c1.id, c2.id, { directed: true, line_style: 'dashed', tag: '师徒', color: '#ef4444' });
    const undirected = makeRelation(2, c2.id, c3.id, { directed: false, line_style: 'dotted', tag: '挚友', color: '#22c55e' });
    const client = makeClient({
      getBoard: vi.fn(async () => makeBoard([c1, c2, c3], [directed, undirected]))
    });
    const view = renderWorkspace(client);
    await screen.findByRole('button', { name: /^A，/ });

    const svg = view.container.querySelector('svg')!;
    const markerCount = svg.querySelectorAll('marker').length;
    expect(markerCount).toBe(1);

    const directedPath = svg.querySelector(`[data-character-relation="${directed.id}"] path`)!;
    expect(directedPath.getAttribute('marker-end')).toMatch(/^url\(#character-arrow-/);
    expect(directedPath.getAttribute('stroke')).toBe('#ef4444');
    expect(directedPath.getAttribute('stroke-dasharray')).toBe('8 6');

    const undirectedPath = svg.querySelector(`[data-character-relation="${undirected.id}"] path`)!;
    expect(undirectedPath.getAttribute('marker-end')).toBeNull();
    expect(undirectedPath.getAttribute('stroke')).toBe('#22c55e');
    expect(undirectedPath.getAttribute('stroke-dasharray')).toBe('2 4');

    // 标签 chip 始终显示，颜色不用于 chip 填充（chip 走中性 surface 变量，不接收 relation.color）
    const labels = svg.querySelectorAll('.character-edge-label text');
    expect(labels).toHaveLength(2);
    expect(labels[0]!.textContent).toBe('师徒');
    expect(labels[1]!.textContent).toBe('挚友');
  });

  it('布局 PUT 遇 409 版本冲突时展示可读提示并可刷新重试', async () => {
    const c1 = makeCharacter(1, { name: '林墨' });
    const layout: BoardLayout = [{ character_id: c1.id, x: 100, y: 100, arranged: true, sort_index: 0 }];
    const client = makeClient({
      getBoard: vi.fn(async () => makeBoard([c1], [], layout)),
      updateLayout: vi.fn(async () => {
        throw new ApiError(409, 'CHARACTER_VERSION_CONFLICT', 'conflict', {}, 'req-1');
      })
    });
    renderWorkspace(client);
    const card = await screen.findByRole('button', { name: /林墨/ });

    dispatchPointer(card, 'pointerdown', 10, 10);
    dispatchPointer(card, 'pointermove', 60, 10);
    dispatchPointer(card, 'pointerup', 60, 10);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('刷新');
    expect(client.updateLayout).toHaveBeenCalledTimes(1);
  });
});
