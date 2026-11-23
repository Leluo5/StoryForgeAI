import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chapter, TreeResponse } from '@storyforge/contracts';
import { createEmptyDocument } from '@storyforge/editor-schema';
import { WorkbenchRoute, type WorkbenchClient } from './workbench-page';
import { ApiError } from '../api/client';

const workId = crypto.randomUUID();
const chapterId = crypto.randomUUID();
const volumeId = crypto.randomUUID();
const now = new Date().toISOString();
const chapter: Chapter = {
  id: chapterId, work_id: workId, volume_id: volumeId, title: '第一章', position: 0,
  version: 0, content_hash: 'a'.repeat(64), document: createEmptyDocument()
};
const tree: TreeResponse = {
  work: {
    id: workId, author_id: crypto.randomUUID(), title: '深链作品', description: '', status: 'active',
    created_at: now, updated_at: now
  },
  volumes: [{ id: volumeId, work_id: workId, title: '第一卷', position: 0 }],
  chapters: [{ id: chapterId, work_id: workId, volume_id: volumeId, title: '第一章', position: 0, version: 0, content_hash: 'a'.repeat(64) }]
};

function plotClientFixture(): NonNullable<WorkbenchClient['plot']> {
  return {
    fetchTree: vi.fn(async () => ({ tree: null, nodes: [], links: [], groups: [] }))
  } as unknown as NonNullable<WorkbenchClient['plot']>;
}

function client(): WorkbenchClient {
  return {
    getTree: vi.fn().mockResolvedValue(tree),
    createVolume: vi.fn(), renameVolume: vi.fn(), reorderVolumes: vi.fn(),
    createChapter: vi.fn(), renameChapter: vi.fn(), reorderChapters: vi.fn(),
    getChapter: vi.fn().mockResolvedValue(chapter), saveChange: vi.fn(),
    plot: plotClientFixture()
  };
}

function LocationProbe() {
  return <output data-testid="location">{useLocation().search}</output>;
}

function renderPage(api: WorkbenchClient, entry = `/works/${workId}/write/${chapterId}?tab=manuscript&panel=chapter`) {
  return render(<MemoryRouter initialEntries={[entry]}><Routes>
    <Route path="/works/:workId/write/:chapterId" element={<><WorkbenchRoute client={api} /><LocationProbe /></>} />
  </Routes></MemoryRouter>);
}

beforeAll(() => {
  Range.prototype.getClientRects = (): DOMRectList => ({
    length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator]
  }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
  // restoreMocks 会清空 beforeAll 中 vi.fn 的实现，这里用纯函数，避免 matchMedia 返回 undefined
  window.matchMedia = (media: string) => ({
    matches: false, media, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false
  }) as unknown as MediaQueryList;
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('storyforge-theme', 'light');
});

describe('WorkbenchRoute', () => {
  it('uses Routes and Route params to load the exact work and chapter', async () => {
    const api = client();
    renderPage(api);
    expect(await screen.findByRole('heading', { name: '深链作品' })).toBeVisible();
    await waitFor(() => expect(api.getChapter).toHaveBeenCalledWith(workId, chapterId));
    expect(api.getTree).toHaveBeenCalledWith(workId);
    // LocationProbe 的 output 也是隐式 status，这里按文本定位保存状态
    await waitFor(() => expect(screen.getAllByRole('status').map((node) => node.textContent)).toContain('已同步'));
  });

  it('normalizes invalid deep-link state and persists panel collapse per work', async () => {
    const api = client();
    renderPage(api, `/works/${workId}/write/${chapterId}?tab=revisions&panel=comments`);
    expect(await screen.findByTestId('location')).toHaveTextContent('?tab=manuscript&panel=chapter');
    // 需求1：左侧栏宽度拖动条已移除，展开/收起仍可用 —— 点击「收起左侧栏」收起并持久化 leftCollapsed
    const collapse = await screen.findByRole('button', { name: '收起左侧栏' });
    await userEvent.click(collapse);
    expect(await screen.findByRole('button', { name: '展开左侧栏' })).toBeInTheDocument();
    // 持久化经 rAF 节流 + 150ms 防抖异步写入，需等待防抖完成后再断言 localStorage
    await waitFor(() => expect(JSON.parse(localStorage.getItem(`storyforge-workbench:${workId}`)!)).toMatchObject({ leftCollapsed: true }));
    // 点击展开恢复
    await userEvent.click(screen.getByRole('button', { name: '展开左侧栏' }));
    expect(await screen.findByRole('button', { name: '收起左侧栏' })).toBeInTheDocument();
  });

  it('restores focus to the narrow-screen navigation trigger after closing its dialog', async () => {
    renderPage(client());
    const trigger = await screen.findByRole('button', { name: '打开章节导航' });
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: '章节导航' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '关闭章节导航' }));
    expect(trigger).toHaveFocus();
  });

  it('ports the rich-text / markdown switch into the header and puts it right of the mode row', async () => {
    const api = client();
    const view = renderPage(api);
    await waitFor(() => expect(view.container.querySelector('.ProseMirror')).not.toBeNull());
    // 需求3：编辑模式切换按钮 portal 到页头第三行容器（返回作品库下方），正文区不再内联渲染
    const slot = view.container.querySelector('.workbench-editor-mode') as HTMLDivElement;
    expect(slot).not.toBeNull();
    expect(within(slot).getByRole('group', { name: '编辑模式' })).toBeVisible();
    expect(view.container.querySelector('section[aria-label="正文编辑器"] > [role="group"]')).toBeNull();
    // 正文文本框填满中央区
    expect(view.container.querySelector('.ProseMirror')).toBeVisible();
  });

  // 需求5：折叠 / 展开左侧栏使用与共享导航工具栏同款结构（aria-expanded + 展开/收起 标签）
  it('uses the shared side-nav collapse toggle style for the left panel', async () => {
    const api = client();
    renderPage(api);
    await screen.findByRole('heading', { name: '深链作品' });
    const toggle = await screen.findByRole('button', { name: '收起左侧栏' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle.querySelector('.panel-collapse-toggle__label')).toHaveTextContent('收起');
    await userEvent.click(toggle);
    expect(await screen.findByRole('button', { name: '展开左侧栏' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps the manuscript editor mounted when switching to the plot tab', async () => {
    const api = client();
    const view = renderPage(api);
    await screen.findByRole('heading', { name: '深链作品' });
    await waitFor(() => expect(view.container.querySelector('.ProseMirror')).not.toBeNull());
    const editor = view.container.querySelector('.ProseMirror')!;

    // 中央页签栏已移除（需求三改由 header「剧情树」按钮切换），改用 header 功能入口进入剧情
    await userEvent.click(within(screen.getByRole('group', { name: '创作功能入口' })).getByRole('button', { name: '剧情树' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('?tab=plot&panel=plot'));
    // 正文编辑器不能被卸载，只是收进 hidden 容器
    expect(view.container.querySelector('.ProseMirror')).toBe(editor);
    expect(editor.closest('[hidden]')).not.toBeNull();
    expect(await screen.findByRole('button', { name: '新建空树' })).toBeVisible();
  });

  it('opens the plot tab and panel from a deep link', async () => {
    const api = client();
    renderPage(api, `/works/${workId}/write/${chapterId}?tab=plot&panel=plot`);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('?tab=plot&panel=plot'));
    expect(await screen.findByRole('button', { name: '新建空树' })).toBeVisible();
    await waitFor(() => expect(api.plot?.fetchTree).toHaveBeenCalledWith(workId));
  });

  // 知识库已从工作台右侧 tab 迁移到作品库页头入口（独立路由 /knowledge），旧深链 ?panel=knowledge 不再合法：
  // 页面应安全归一化为默认面板（chapter），且不渲染知识库面板。
  // 注意：Agent 管理在 main 中是合法右侧面板（F11 协同），故 tab 应存在，仅 knowledge 归一化。
  it('normalizes the legacy knowledge deep link back to the chapter panel', async () => {
    const api = client();
    renderPage(api, `/works/${workId}/write/${chapterId}?tab=manuscript&panel=knowledge`);
    // 非法 panel 被归一化：URL 不再保留 knowledge
    await waitFor(() => expect(screen.getByTestId('location')).not.toHaveTextContent('panel=knowledge'));
    expect(screen.getByTestId('location')).toHaveTextContent('panel=chapter');
    const rightTabs = screen.getByRole('tablist', { name: '右侧面板' });
    expect(within(rightTabs).queryByRole('tab', { name: '知识库' })).toBeNull();
    // Agent 管理是合法面板，tab 应存在；深链为 knowledge（归一化到 chapter），故面板不渲染
    expect(within(rightTabs).getByRole('tab', { name: 'Agent 管理' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '知识库' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Agent 管理' })).toBeNull();
  });

  // 未在作品库选择作品直接进入工作台（或作品已被删除）时，getTree 返回 404，
  // 应默认重定向回作品库 /works，而不是停留在报错页面。
  it('redirects to the works page when the work no longer exists (getTree 404)', async () => {
    const api = client();
    api.getTree = vi.fn().mockRejectedValue(
      new ApiError(404, 'WORK_NOT_FOUND', '作品不存在', null, 'req-404')
    );
    render(<MemoryRouter initialEntries={[`/works/${workId}/write/${chapterId}`]}><Routes>
      <Route path="/works/:workId/write/:chapterId" element={<><WorkbenchRoute client={api} /><LocationProbe /></>} />
      <Route path="/works" element={<output data-testid="works-page">作品库</output>} />
    </Routes></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('works-page')).toBeInTheDocument());
    // 工作台不再渲染，作品库兜底可见
    expect(screen.queryByRole('heading', { name: '深链作品' })).toBeNull();
  });

  // Agent 管理在 main 中是合法右侧面板（F11 协同）：深链 ?panel=agent 应保留并渲染 Agent 管理，
  // 而非被归一化为章节信息（本分支曾删除该面板，merge 后恢复 main 语义，测试跟随 main）。
  it('keeps the agent panel as a legal deep-link target and renders it', async () => {
    const api = client();
    renderPage(api, `/works/${workId}/write/${chapterId}?tab=manuscript&panel=agent`);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('panel=agent'));
    const rightTabs = screen.getByRole('tablist', { name: '右侧面板' });
    expect(within(rightTabs).getByRole('tab', { name: 'Agent 管理' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Agent 管理' })).toBeVisible();
  });

  // 功能入口（写作 / 角色版图 / 剧情树 / 创作工具）位于写作工作台页头，点击后导航到对应功能。
  it('renders the four feature entries and navigates to each target on click', async () => {
    const api = client();
    renderPage(api);
    await screen.findByRole('heading', { name: '深链作品' });

    const entries = screen.getByRole('group', { name: '创作功能入口' });
    // 写作：切回中央写作页签
    expect(within(entries).getByRole('button', { name: '写作' })).toBeVisible();
    expect(within(entries).getByRole('button', { name: '角色版图' })).toBeVisible();
    expect(within(entries).getByRole('button', { name: '剧情树' })).toBeVisible();
    expect(within(entries).getByRole('button', { name: '创作工具' })).toBeVisible();

    // 写作：切换到中央 manuscript 页签
    await userEvent.click(within(entries).getByRole('button', { name: '写作' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('?tab=manuscript&panel=chapter'));

    // 角色版图：切换到中央 roles 页签并同步打开右侧 role 面板
    await userEvent.click(within(entries).getByRole('button', { name: '角色版图' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('?tab=roles&panel=role'));

    // 剧情树：切换到中央 plot 页签并同步打开右侧 plot 面板
    await userEvent.click(within(entries).getByRole('button', { name: '剧情树' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('?tab=plot&panel=plot'));

    // 创作工具：切换为独立中央视图（tools 页签），不再打开右侧 AI 面板
    await userEvent.click(within(entries).getByRole('button', { name: '创作工具' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('?tab=tools&panel=chapter'));
    // 独立中央视图渲染创作工具面板
    expect(screen.getByRole('tabpanel', { name: '创作工具' })).toBeVisible();
  });
});
