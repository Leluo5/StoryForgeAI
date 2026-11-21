import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgePage } from './knowledge-page';

// 知识库面板会调 knowledge-client 发起真实请求，页面级用例只验证页头与入口跳转，故 mock 客户端隔离网络
vi.mock('./knowledge-client', () => ({
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

function renderPage() {
  return render(<MemoryRouter initialEntries={['/knowledge']}><Routes>
    <Route path="/knowledge" element={<KnowledgePage />} />
    <Route path="/works" element={<div>作品库</div>} />
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('KnowledgePage', () => {
  it('renders the knowledge panel with its title and function tabs', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: '知识库', level: 1 })).toBeVisible();
    expect(screen.getByRole('heading', { name: '知识库', level: 2 })).toBeVisible();
    const tablist = screen.getByRole('tablist', { name: '知识库功能页签' });
    expect(tablist).toBeVisible();
  });

  it('links back to the works library', async () => {
    renderPage();
    await screen.findByRole('heading', { name: '知识库', level: 1 });
    const back = screen.getByRole('link', { name: '返回作品库' });
    expect(back).toHaveAttribute('href', '/works');
  });
});