import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KnowledgePage } from './knowledge-page';
import { knowledgeClient } from './knowledge-client';

// 方案 C 三栏：页面会调 knowledge-client 拉取列表/标签/详情，mock 客户端隔离网络
const mockDetail = {
  id: 'k1',
  title: '示例文章',
  entry_type: 'article',
  tags: ['写作', '技巧'],
  original_text: '正文内容…',
  structure_status: 'ready',
  structured: { entry_type: 'article', sections: [{ heading: '一', content: '内容' }], key_points: ['要点A'] },
  outline: null,
  favorite: false,
  pinned: false,
  created_at: '2026-11-01T00:00:00Z',
  updated_at: '2026-11-20T00:00:00Z',
  version: 3,
  source: 'manual'
};

vi.mock('./knowledge-client', () => ({
  knowledgeClient: {
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
    validateMarkdown: vi.fn(),
    listEntries: vi.fn(async () => ({ items: [], next_cursor: null, total: 0 })),
    listTags: vi.fn(async () => []),
    fetchEntry: vi.fn(async () => mockDetail),
    setEntryFlags: vi.fn(async () => ({}))
  }
}));

function renderPage(initialEntry = '/knowledge') {
  return render(<MemoryRouter initialEntries={[initialEntry]}><Routes>
    <Route path="/knowledge" element={<KnowledgePage />} />
  </Routes></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('KnowledgePage（方案 C 三栏）', () => {
  it('renders the manager header with scope switcher', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: '知识库管理中心', level: 1 })).toBeVisible();
    expect(screen.getByRole('group', { name: '库切换' })).toBeVisible();
  });

  it('renders left navigation with type filter', async () => {
    renderPage();
    await screen.findByRole('heading', { name: '知识库管理中心', level: 1 });
    expect(screen.getByRole('navigation', { name: '知识库导航' })).toBeVisible();
    expect(screen.getByRole('button', { name: /全部/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /小说/ })).toBeVisible();
  });

  it('renders the list area and empty state', async () => {
    renderPage();
    await screen.findByRole('heading', { name: '知识库管理中心', level: 1 });
    expect(screen.getByRole('region', { name: '知识条目列表' })).toBeVisible();
    expect(await screen.findByText(/还没有知识条目/)).toBeVisible();
  });

  it('does not render a redundant back-to-works control', async () => {
    renderPage();
    await screen.findByRole('heading', { name: '知识库管理中心', level: 1 });
    expect(screen.queryByRole('link', { name: '返回作品库' })).toBeNull();
  });

  it('disables the current-work scope when no work_id is present', async () => {
    renderPage();
    await screen.findByRole('heading', { name: '知识库管理中心', level: 1 });
    expect(screen.getByRole('button', { name: '当前作品' })).toBeDisabled();
  });

  it('enables the current-work scope and requests with the real work_id', async () => {
    renderPage('/knowledge?work_id=w42');
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: '知识库管理中心', level: 1 });
    const workBtn = screen.getByRole('button', { name: '当前作品' });
    expect(workBtn).toBeEnabled();
    await user.click(workBtn);
    await screen.findByRole('heading', { name: '知识库管理中心', level: 1 });
    expect(knowledgeClient.listEntries).toHaveBeenCalledWith(expect.objectContaining({ scope: 'work', work_id: 'w42' }));
  });
});
