import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Work } from '@storyforge/contracts';
import { createWork, listWorks, updateWork } from './writing-client';
import { WorksPage } from './works-page';

vi.mock('./writing-client', () => ({
  listWorks: vi.fn(), createWork: vi.fn(), updateWork: vi.fn()
}));

const work: Work = {
  id: crypto.randomUUID(), author_id: crypto.randomUUID(), title: '既有作品', description: '',
  status: 'active', created_at: new Date().toISOString(), updated_at: new Date().toISOString()
};

function renderPage() {
  return render(<MemoryRouter initialEntries={['/works']}><Routes>
    <Route path="/works" element={<WorksPage />} />
    <Route path="/works/:workId/write/:chapterId" element={<div>工作台深链</div>} />
    <Route path="/arkclaw" element={<div>ArkClaw 验证页面</div>} />
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  vi.mocked(listWorks).mockReset().mockResolvedValue([work]);
  vi.mocked(createWork).mockReset();
  vi.mocked(updateWork).mockReset();
});

describe('WorksPage', () => {
  it('creates once while pending and opens the returned first chapter', async () => {
    let finish!: (value: { work: Work; first_chapter_id: string }) => void;
    vi.mocked(createWork).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderPage();
    expect(await screen.findByText('既有作品')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: '新建作品' }));
    await userEvent.type(screen.getByLabelText('作品名称'), '星河');
    await userEvent.click(screen.getByRole('button', { name: '创建' }));
    expect(screen.getByRole('button', { name: '创建中' })).toBeDisabled();
    const chapterId = crypto.randomUUID();
    finish({ work: { ...work, title: '星河' }, first_chapter_id: chapterId });
    expect(await screen.findByText('工作台深链')).toBeVisible();
    expect(createWork).toHaveBeenCalledTimes(1);
    expect(createWork).toHaveBeenCalledWith({ title: '星河', description: '' });
  });

  it('keeps the create button and does not render module entry links in the header', async () => {
    renderPage();
    await screen.findByText('既有作品');
    // 功能入口已收口到左侧共享导航工具栏，页头工具区只保留搜索 + 新建作品
    expect(screen.getByRole('button', { name: '新建作品' })).toBeVisible();
    expect(screen.queryByRole('link', { name: '知识库' })).toBeNull();
    expect(screen.queryByRole('link', { name: '智能体管理' })).toBeNull();
    expect(screen.queryByRole('link', { name: '工作流管理' })).toBeNull();
  });

  // 三个创作功能入口仅在写作工作台渲染；作品库页面（及其他模块页）不得展示。
  it('does not render the workbench-only feature entries on the works page', async () => {
    renderPage();
    await screen.findByText('既有作品');
    expect(screen.queryByRole('group', { name: '创作功能入口' })).toBeNull();
    expect(screen.queryByRole('button', { name: '角色版图' })).toBeNull();
    expect(screen.queryByRole('button', { name: '剧情树' })).toBeNull();
    expect(screen.queryByRole('button', { name: '创作工具' })).toBeNull();
  });

  it('archives only after native confirmation', async () => {
    vi.mocked(updateWork).mockResolvedValue({ ...work, status: 'archived' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '归档既有作品' }));
    expect(confirm).toHaveBeenCalled();
    expect(updateWork).toHaveBeenCalledWith(work.id, { status: 'archived' });
  });

  it('opens the ArkClaw verification page from the works library', async () => {
    renderPage();
    expect(await screen.findByText('既有作品')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'ArkClaw 验证' }));
    expect(await screen.findByText('ArkClaw 验证页面')).toBeVisible();
  });
});
