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

  it('archives only after native confirmation', async () => {
    vi.mocked(updateWork).mockResolvedValue({ ...work, status: 'archived' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: '归档既有作品' }));
    expect(confirm).toHaveBeenCalled();
    expect(updateWork).toHaveBeenCalledWith(work.id, { status: 'archived' });
  });
});
