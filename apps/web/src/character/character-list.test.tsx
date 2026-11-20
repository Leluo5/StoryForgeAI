import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { JSX } from 'react';
import type { CharacterBoardResponse } from '@storyforge/contracts';
import type { CharacterClient } from './character-client';
import { useCharacterStore } from './character-state';
import { CharacterStoreProvider, CharacterWorkspace } from './character-workspace';
import { CharacterList, isCompactViewport, type CharacterListProps } from './character-list';

const workId = '11111111-1111-4111-8111-111111111111';
const viewId = 'vvvvvvvv-vvvv-4vvv-8vvv-vvvvvvvvvvvv';

function uid(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

type BoardCharacter = CharacterBoardResponse['characters'][number];
type BoardRelation = CharacterBoardResponse['relations'][number];

function makeCharacter(seed: number, name: string, faction: string): BoardCharacter {
  return {
    id: uid(seed),
    name,
    status: 'active',
    avatar_asset_id: null,
    six_dim: {
      country_region: '中原',
      faith: '道家',
      faction,
      race: '汉人',
      occupation: '侠客',
      age_band: '青年'
    }
  };
}

function makeRelation(
  seed: number,
  sourceId: string,
  targetId: string,
  overrides: Partial<BoardRelation> = {}
): BoardRelation {
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

function makeBoard(characters: BoardCharacter[], relations: BoardRelation[] = []): CharacterBoardResponse {
  return {
    view: { id: viewId, name: '默认视图', filters: {}, version: 1, is_default: true },
    characters,
    relations,
    relation_types: [],
    layout: []
  };
}

function makeClient(board: CharacterBoardResponse): CharacterClient {
  const base = {
    listViews: vi.fn(async () => [
      {
        id: viewId,
        work_id: workId,
        name: '默认视图',
        is_default: true,
        filters: {},
        version: 1,
        sort_order: 0,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z'
      }
    ]),
    getBoard: vi.fn(async () => board),
    updateLayout: vi.fn(async () => ({ updated: 0 }))
  };
  return base as unknown as CharacterClient;
}

/** 在 Provider 内部驱动真实 store 的筛选，验证列表与画布共享同一份筛选状态 */
function FilterProbe(): JSX.Element {
  const store = useCharacterStore();
  return (
    <div>
      <button type="button" onClick={() => store.setFilters({ faction: '正派' })}>只看正派</button>
      <button type="button" onClick={() => store.setFilters({ faction: '邪派' })}>只看邪派</button>
      <button type="button" onClick={() => store.setFilters({})}>清除筛选</button>
    </div>
  );
}

function renderList(client: CharacterClient, props: CharacterListProps = {}) {
  return render(
    <CharacterStoreProvider workId={workId} client={client} enabled>
      <FilterProbe />
      <CharacterList {...props} />
    </CharacterStoreProvider>
  );
}

describe('CharacterList T34', () => {
  it('渲染全部角色与关系，且关系只展示两端都可见的行（与画布共享筛选）', async () => {
    const lin = makeCharacter(1, '林墨', '正派');
    const shen = makeCharacter(2, '沈星河', '邪派');
    const bai = makeCharacter(3, '白芷', '正派');
    const relations = [
      makeRelation(1, lin.id, shen.id, { tag: '宿敌', label: '对立' }),
      makeRelation(2, lin.id, bai.id, { tag: '同门', label: '师兄妹', directed: false, line_style: 'dashed' }),
      makeRelation(3, shen.id, bai.id, { tag: '师徒', label: '授业', line_style: 'dotted' })
    ];
    const client = makeClient(makeBoard([lin, shen, bai], relations));
    renderList(client);

    const characterGrid = await screen.findByRole('grid', { name: '角色列表' });
    expect(within(characterGrid).getAllByRole('row')).toHaveLength(4); // 表头 + 3 名角色

    const relationGrid = screen.getByRole('grid', { name: '关系列表' });
    expect(within(relationGrid).getAllByRole('row')).toHaveLength(4); // 表头 + 3 条关系
    expect(within(relationGrid).getByText('宿敌')).toBeVisible();
    expect(within(relationGrid).getByText('同门')).toBeVisible();
    // 方向与线型都以文字表达，不依赖箭头或颜色
    expect(within(relationGrid).getAllByText(/有向 · 实线/)).toHaveLength(1);
    expect(within(relationGrid).getByText('无向 · 虚线')).toBeVisible();
    expect(within(relationGrid).getByText('有向 · 点线')).toBeVisible();

    // 共享 store 筛选：只剩正派时，沈星河被排除，仅保留两端都可见的 林墨-白芷
    await userEvent.click(screen.getByRole('button', { name: '只看正派' }));
    await waitFor(() =>
      expect(within(screen.getByRole('grid', { name: '角色列表' })).getAllByRole('row')).toHaveLength(3)
    );
    expect(screen.queryByText('沈星河')).toBeNull();
    const filteredRelations = screen.getByRole('grid', { name: '关系列表' });
    expect(within(filteredRelations).getAllByRole('row')).toHaveLength(2); // 表头 + 1
    expect(within(filteredRelations).getByText('同门')).toBeVisible();
    expect(within(filteredRelations).queryByText('宿敌')).toBeNull();

    // 只剩邪派一人时没有两端都可见的关系，关系表整体收起
    await userEvent.click(screen.getByRole('button', { name: '只看邪派' }));
    await waitFor(() => expect(screen.queryByRole('grid', { name: '关系列表' })).toBeNull());
    expect(screen.getByText('当前筛选下没有两端都可见的关系。')).toBeVisible();
  });

  it('方向键移动焦点并可跨入关系表，Enter 打开详情', async () => {
    const lin = makeCharacter(1, '林墨', '正派');
    const shen = makeCharacter(2, '沈星河', '邪派');
    const bai = makeCharacter(3, '白芷', '正派');
    const onOpen = vi.fn();
    const view = renderList(
      makeClient(makeBoard([lin, shen, bai], [makeRelation(1, lin.id, shen.id, { tag: '宿敌' })])),
      { onOpen }
    );

    const grid = await screen.findByRole('grid', { name: '角色列表' });
    const rows = within(grid).getAllByRole('row');
    expect(rows).toHaveLength(4);

    const firstCell = within(rows[1]!).getAllByRole('gridcell')[0]!;
    act(() => firstCell.focus());
    expect(firstCell).toHaveFocus();

    fireEvent.keyDown(firstCell, { key: 'ArrowDown' });
    expect(within(rows[2]!).getAllByRole('gridcell')[0]!).toHaveFocus();

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(within(rows[2]!).getAllByRole('gridcell')[1]!).toHaveFocus();

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(firstCell).toHaveFocus();

    // 最后一行角色继续向下进入关系表，按列对齐（方向列）
    fireEvent.keyDown(firstCell, { key: 'End' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    const relationGrid = screen.getByRole('grid', { name: '关系列表' });
    const relationCells = within(within(relationGrid).getAllByRole('row')[1]!).getAllByRole('gridcell');
    expect(relationCells[2]!).toHaveFocus();

    // roving tabindex：整份列表任一时刻只有一个 tabIndex=0
    expect(view.container.querySelectorAll('[tabindex="0"]')).toHaveLength(1);

    act(() => firstCell.focus());
    fireEvent.keyDown(firstCell, { key: 'Enter' });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(lin.id);
  });

  it('Delete 弹出内联确认：确认才请求归档，取消不请求；不注册全局快捷键', async () => {
    const lin = makeCharacter(1, '林墨', '正派');
    const shen = makeCharacter(2, '沈星河', '邪派');
    const onRequestArchive = vi.fn();
    renderList(makeClient(makeBoard([lin, shen])), { onRequestArchive });

    const grid = await screen.findByRole('grid', { name: '角色列表' });
    const firstCell = within(within(grid).getAllByRole('row')[1]!).getAllByRole('gridcell')[0]!;

    // window 级 Delete 不应弹确认（避免抢占正文编辑器快捷键）
    fireEvent.keyDown(window, { key: 'Delete' });
    expect(screen.queryByRole('alertdialog')).toBeNull();

    act(() => firstCell.focus());
    fireEvent.keyDown(firstCell, { key: 'Delete' });
    const dialog = await screen.findByRole('alertdialog', { name: /确认归档/ });
    expect(dialog).toBeVisible();
    expect(within(dialog).getByText('林墨', { exact: false })).toBeVisible();

    await userEvent.click(within(dialog).getByRole('button', { name: '确认归档' }));
    expect(onRequestArchive).toHaveBeenCalledTimes(1);
    expect(onRequestArchive).toHaveBeenCalledWith(lin.id);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    // 取消路径
    fireEvent.keyDown(firstCell, { key: 'Delete' });
    const secondDialog = await screen.findByRole('alertdialog', { name: /确认归档/ });
    await userEvent.click(within(secondDialog).getByRole('button', { name: '取消' }));
    expect(onRequestArchive).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('表格 role / aria-selected 正确，点击行同步选中状态', async () => {
    const lin = makeCharacter(1, '林墨', '正派');
    const shen = makeCharacter(2, '沈星河', '邪派');
    renderList(makeClient(makeBoard([lin, shen])));

    const grid = await screen.findByRole('grid', { name: '角色列表' });
    expect(grid).toHaveAttribute('aria-label', '角色列表');
    expect(grid).toHaveAttribute('aria-colcount', '3');

    const rows = within(grid).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getAllByRole('columnheader')).toHaveLength(3);

    const dataRow = rows[1]!;
    expect(dataRow).toHaveAttribute('role', 'row');
    expect(dataRow).toHaveAttribute('aria-selected', 'false');
    const cells = within(dataRow).getAllByRole('gridcell');
    expect(cells).toHaveLength(3);
    expect(cells[0]!).toHaveAttribute('aria-selected', 'false');

    await userEvent.click(cells[0]!);
    await waitFor(() => expect(within(grid).getAllByRole('row')[1]!).toHaveAttribute('aria-selected', 'true'));
    expect(within(grid).getAllByRole('row')[1]!).toHaveAttribute('role', 'row');
    expect(within(grid).getAllByRole('row')[2]!).toHaveAttribute('aria-selected', 'false');
  });

  it('宽屏点击行在摘要侧栏展示并可从「打开详情」回调', async () => {
    const lin = makeCharacter(1, '林墨', '正派');
    const shen = makeCharacter(2, '沈星河', '邪派');
    const onOpen = vi.fn();
    renderList(
      makeClient(makeBoard([lin, shen], [makeRelation(1, lin.id, shen.id, { tag: '宿敌' })])),
      { onOpen }
    );

    const grid = await screen.findByRole('grid', { name: '角色列表' });
    await userEvent.click(within(within(grid).getAllByRole('row')[1]!).getAllByRole('gridcell')[0]!);

    const aside = screen.getByRole('complementary', { name: '角色摘要' });
    expect(within(aside).getByText('林墨')).toBeVisible();
    expect(within(aside).getByText('1 条可见关系', { exact: false })).toBeVisible();
    await userEvent.click(within(aside).getByRole('button', { name: '打开详情' }));
    expect(onOpen).toHaveBeenCalledWith(lin.id);
  });

  it('窄屏（<768）点击行折叠为抽屉：摘要 + 关闭 + 打开详情', async () => {
    const originalWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 375 });
    try {
      const lin = makeCharacter(1, '林墨', '正派');
      const onOpen = vi.fn();
      renderList(makeClient(makeBoard([lin])), { onOpen });

      const grid = await screen.findByRole('grid', { name: '角色列表' });
      // 窄屏不渲染常驻侧栏
      expect(screen.queryByRole('complementary', { name: '角色摘要' })).toBeNull();

      await userEvent.click(within(within(grid).getAllByRole('row')[1]!).getAllByRole('gridcell')[0]!);
      const drawer = await screen.findByRole('dialog', { name: '角色摘要' });
      expect(within(drawer).getByText('林墨')).toBeVisible();
      expect(within(drawer).getByRole('button', { name: '关闭' })).toBeVisible();

      await userEvent.click(within(drawer).getByRole('button', { name: '打开详情' }));
      expect(onOpen).toHaveBeenCalledWith(lin.id);

      await userEvent.click(within(drawer).getByRole('button', { name: '关闭' }));
      expect(screen.queryByRole('dialog', { name: '角色摘要' })).toBeNull();
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: originalWidth });
    }
  });
});

describe('isCompactViewport 四档边界', () => {
  const cases: Array<{ width: number; compact: boolean }> = [
    { width: 375, compact: true },
    { width: 767, compact: true },
    { width: 768, compact: false },
    { width: 1024, compact: false },
    { width: 1440, compact: false }
  ];

  it.each(cases)('$width px → 折叠 $compact', ({ width, compact }) => {
    expect(isCompactViewport(width)).toBe(compact);
  });
});

describe('CharacterList T34 全量场景', () => {
  it('100 角色 / 150 关系全部承载，关系数量按两端可见关系统计', async () => {
    const characters = Array.from({ length: 100 }, (_, i) =>
      makeCharacter(i + 1, `角色${i + 1}`, i % 2 === 0 ? '正派' : '邪派')
    );
    const relations: BoardRelation[] = [];
    for (let i = 0; i < 150; i += 1) {
      relations.push(makeRelation(i + 1, characters[i % 100]!.id, characters[(i + 1) % 100]!.id));
    }

    renderList(makeClient(makeBoard(characters, relations)));

    const characterGrid = await screen.findByRole('grid', { name: '角色列表' });
    expect(within(characterGrid).getAllByRole('row')).toHaveLength(101); // 表头 + 100 角色

    const relationGrid = screen.getByRole('grid', { name: '关系列表' });
    expect(within(relationGrid).getAllByRole('row')).toHaveLength(151); // 表头 + 150 关系

    const rows = within(characterGrid).getAllByRole('row');
    // 角色1：作为起点 2 次（0、100）+ 作为终点 1 次（99）
    expect(within(rows[1]!).getByText('3 条关系')).toBeVisible();
    // 角色2：作为起点 2 次（1、101）+ 作为终点 2 次（0、100）
    expect(within(rows[2]!).getByText('4 条关系')).toBeVisible();
  });

  it('加载中与空结果都有可读提示', async () => {
    const client = makeClient(makeBoard([]));
    client.getBoard = vi.fn(() => new Promise<CharacterBoardResponse>(() => {}));
    renderList(client);
    expect(await screen.findByRole('status')).toHaveTextContent('正在加载角色版图');

    cleanup();
    renderList(makeClient(makeBoard([])));    expect(await screen.findByRole('status')).toHaveTextContent('没有匹配的角色');
    expect(screen.queryByRole('grid', { name: '角色列表' })).toBeNull();
  });

  it('工具栏切换列表不重新拉 board，筛选变化后列表行数同步', async () => {
    const lin = makeCharacter(1, '林墨', '正派');
    const shen = makeCharacter(2, '沈星河', '邪派');
    const client = makeClient(makeBoard([lin, shen], [makeRelation(1, lin.id, shen.id, { tag: '宿敌' })]));

    render(<CharacterWorkspace workId={workId} client={client} enabled />);
    await screen.findByRole('button', { name: /林墨/ });
    expect(client.getBoard).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole('button', { name: '列表' }));
    const grid = await screen.findByRole('grid', { name: '角色列表' });
    expect(within(grid).getAllByRole('row')).toHaveLength(3); // 表头 + 2 角色
    // 切换视图复用同一 store 的 board，不重新请求
    expect(client.getBoard).toHaveBeenCalledTimes(1);

    await userEvent.type(screen.getByLabelText('搜索'), '林墨');
    await waitFor(() =>
      expect(within(screen.getByRole('grid', { name: '角色列表' })).getAllByRole('row')).toHaveLength(2)
    );
    expect(screen.getByText('1 个结果')).toBeVisible();
    expect(client.getBoard).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText('搜索'), { target: { value: '' } });
    await waitFor(() =>
      expect(within(screen.getByRole('grid', { name: '角色列表' })).getAllByRole('row')).toHaveLength(3)
    );
  });
});
