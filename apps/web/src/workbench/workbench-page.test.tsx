import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Chapter, TreeResponse } from '@storyforge/contracts';
import { createEmptyDocument } from '@storyforge/editor-schema';
import { WorkbenchRoute, type WorkbenchClient } from './workbench-page';

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

function client(): WorkbenchClient {
  return {
    getTree: vi.fn().mockResolvedValue(tree),
    createVolume: vi.fn(), renameVolume: vi.fn(), reorderVolumes: vi.fn(),
    createChapter: vi.fn(), renameChapter: vi.fn(), reorderChapters: vi.fn(),
    getChapter: vi.fn().mockResolvedValue(chapter), saveChange: vi.fn()
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
    expect(JSON.parse(localStorage.getItem(`storyforge-workbench:${workId}`)!)).toMatchObject({ leftWidth: 296 });
  });

  it('restores focus to the narrow-screen navigation trigger after closing its dialog', async () => {
    renderPage(client());
    const trigger = await screen.findByRole('button', { name: '打开章节导航' });
    await userEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: '章节导航' })).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '关闭章节导航' }));
    expect(trigger).toHaveFocus();
  });
});
