import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chapter, TreeResponse } from '@storyforge/contracts';
import { createEmptyDocument } from '@storyforge/editor-schema';
import { WorkbenchRoute, type WorkbenchClient } from './workbench-page';

// 知识库面板会调 knowledge-client 发起真实请求，回归用例只验证「面板接入 + tab 存在」，故 mock 客户端隔离网络
vi.mock('../knowledge/knowledge-client', () => ({
  createEntryPreview: vi.fn(),
  commitEntry: vi.fn(),
  searchEntries: vi.fn(async () => ({ total: 0, items: [] })),
  getEntry: vi.fn(),
  updateEntry: vi.fn(),
  deleteEntry: vi.fn(),
  linkEntry: vi.fn(),
  extractOutline: vi.fn(),
  exportMarkdown: vi.fn(),
  importPreview: vi.fn(),
  importMarkdown: vi.fn(),
  validateMarkdown: vi.fn()
}));

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

  it('normalizes invalid deep-link state and persists panel width per work', async () => {
    const api = client();
    renderPage(api, `/works/${workId}/write/${chapterId}?tab=revisions&panel=comments`);
    expect(await screen.findByTestId('location')).toHaveTextContent('?tab=manuscript&panel=chapter');
    const slider = await screen.findByRole('slider', { name: '左侧栏宽度' });
    fireEvent.change(slider, { target: { value: '296' } });
    // 持久化经 rAF 节流 + 150ms 防抖异步写入，需等待防抖完成后再断言 localStorage
    await waitFor(() => expect(JSON.parse(localStorage.getItem(`storyforge-workbench:${workId}`)!)).toMatchObject({ leftWidth: 296 }));
  });

  it('restores focus to the narrow-screen navigation trigger after closing its dialog', async () => {
    renderPage(client());
    const trigger = await screen.findByRole('button', { name: '打开章节导航' });
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: '章节导航' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '关闭章节导航' }));
    expect(trigger).toHaveFocus();
  });

  it('keeps the manuscript editor mounted when switching to the plot tab', async () => {
    const api = client();
    const view = renderPage(api);
    await screen.findByRole('heading', { name: '深链作品' });
    await waitFor(() => expect(view.container.querySelector('.ProseMirror')).not.toBeNull());
    const editor = view.container.querySelector('.ProseMirror')!;

    const centerTabs = screen.getByRole('tablist', { name: '中央工作区页签' });
    await userEvent.click(within(centerTabs).getByRole('tab', { name: '剧情' }));
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

  it('renders the knowledge panel from a deep link and lists the tab', async () => {
    const api = client();
    renderPage(api, `/works/${workId}/write/${chapterId}?tab=manuscript&panel=knowledge`);
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('?tab=manuscript&panel=knowledge'));
    // 知识库面板已挂载
    expect(await screen.findByRole('heading', { name: '知识库' })).toBeVisible();
    // 右侧面板 tab 包含知识库
    const rightTabs = screen.getByRole('tablist', { name: '右侧面板' });
    expect(within(rightTabs).getByRole('tab', { name: '知识库' })).toBeVisible();
  });
});
