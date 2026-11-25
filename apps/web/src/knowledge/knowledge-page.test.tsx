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
    // 列表 / 详情 / 标签 / 收藏置顶
    listEntries: vi.fn(async () => ({ items: [], next_cursor: null, total: 0 })),
    listTags: vi.fn(async () => []),
    fetchEntry: vi.fn(async () => mockDetail),
    setEntryFlags: vi.fn(async () => ({ favorite: false, pinned: false })),
    removeEntry: vi.fn(async () => ({ status: 'deleted' })),
    // 录入（方案 C §3.5 弹窗）
    createEntryPreview: vi.fn(async () => ({ preview_id: 'p1', conflicts: [] })),
    commitEntry: vi.fn(async () => ({ id: 'k-new', status: 'created' })),
    // Markdown 导入导出
    exportKnowledge: vi.fn(async () => ({ job_id: 'e1', total: 0 })),
    downloadExport: vi.fn(async () => new Blob(['# 导出'], { type: 'text/markdown' })),
    previewImport: vi.fn(async () => ({ preview_id: 'i1', files: [], summary: { total: 0, new: 0, updated: 0, skipped: 0 }, conflicts: [] })),
    commitImport: vi.fn(async () => ({ job_id: 'c1', total: 0, success: 0, failed: 0, created: 0, updated: 0 })),
    // 整库备份 / 恢复
    createBackup: vi.fn(async () => ({ job_id: 'b1', total: 0 })),
    downloadBackup: vi.fn(async () => new Blob(['{"data":{}}'], { type: 'application/gzip' })),
    previewRestore: vi.fn(async () => ({ preview_id: 'r1', file_name: 'b1.json.gz', uncompressed_bytes: 0, summary: { total: 0, new: 0, same_content: 0, same_title_diff_content: 0 }, conflicts: [] })),
    commitRestore: vi.fn(async () => ({ job_id: 'rc1', total: 0, success: 0, failed: 0 }))
  }
}));

// 列表条目（批量操作用例用）
function entry(id: string, title: string): Record<string, unknown> {
  return {
    kind: 'summary',
    id,
    entry_type: 'article',
    title,
    excerpt: '摘要',
    tags: [],
    structure_status: 'ready',
    favorite: false,
    pinned: false,
    created_at: '2026-11-01T00:00:00Z',
    updated_at: '2026-11-20T00:00:00Z'
  };
}

function renderPage(initialEntry = '/knowledge') {
  return render(<MemoryRouter initialEntries={[initialEntry]}><Routes>
    <Route path="/knowledge" element={<KnowledgePage />} />
  </Routes></MemoryRouter>);
}

function mockList(items: Record<string, unknown>[]) {
  vi.mocked(knowledgeClient.listEntries).mockResolvedValueOnce({
    items: items as never,
    next_cursor: null,
    total: items.length
  });
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

  it('restores filters carried over from the drawer (方案 D 「全屏管理 →」)', async () => {
    renderPage('/knowledge?work_id=w42&q=世界&type=novel&entry=k1');
    await screen.findByRole('heading', { name: '知识库管理中心', level: 1 });
    // ?q= 恢复关键词、?type= 恢复类型筛选、?entry= 恢复选中条目
    const search = screen.getByRole('searchbox', { name: '列表关键词' }) as HTMLInputElement;
    expect(search.value).toBe('世界');
    expect(screen.getByRole('combobox', { name: '类型多选' })).toHaveValue('novel');
    expect(knowledgeClient.fetchEntry).toHaveBeenCalledWith('k1');
  });

  it('opens the entry-create modal from the 录入 button', async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: '知识库管理中心', level: 1 });
    await user.click(screen.getByRole('button', { name: '录入' }));
    expect(await screen.findByText('录入知识条目')).toBeVisible();
  });

  it('opens the import/export modal from the 导入/导出 button', async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: '知识库管理中心', level: 1 });
    await user.click(screen.getByRole('button', { name: '导入/导出' }));
    expect(await screen.findByText(/导入 \/ 导出 Markdown/)).toBeVisible();
  });

  it('opens the backup modal from the 整库备份 button', async () => {
    renderPage();
    const user = userEvent.setup();
    await screen.findByRole('heading', { name: '知识库管理中心', level: 1 });
    await user.click(screen.getByRole('button', { name: '整库备份' }));
    expect(await screen.findByText(/整库备份 \/ 恢复/)).toBeVisible();
  });

  it('shows the batch toolbar with the checked count', async () => {
    mockList([entry('k1', '条目一'), entry('k2', '条目二')]);
    renderPage();
    const user = userEvent.setup();
    await screen.findByText('条目一');
    await user.click(screen.getByRole('checkbox', { name: '选中 条目一' }));
    expect(screen.getByRole('toolbar', { name: '批量操作' })).toBeVisible();
    expect(screen.getByText('已选 1 条')).toBeVisible();
    expect(screen.getByRole('button', { name: '导出选中' })).toBeVisible();
    expect(screen.getByRole('button', { name: '删除' })).toBeVisible();
  });

  it('soft-deletes checked entries after batch delete confirmation', async () => {
    mockList([entry('k1', '条目一'), entry('k2', '条目二')]);
    renderPage();
    const user = userEvent.setup();
    await screen.findByText('条目一');
    await user.click(screen.getByRole('checkbox', { name: '选中 条目一' }));
    await user.click(screen.getByRole('checkbox', { name: '选中 条目二' }));
    await user.click(screen.getByRole('button', { name: '删除' }));
    expect(await screen.findByText(/确定删除已选中的/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(knowledgeClient.removeEntry).toHaveBeenCalledWith('k1');
    expect(knowledgeClient.removeEntry).toHaveBeenCalledWith('k2');
    expect(screen.queryByText('确认删除选中条目')).toBeNull();
  });

  it('cancels the batch delete dialog without deleting', async () => {
    mockList([entry('k1', '条目一')]);
    renderPage();
    const user = userEvent.setup();
    await screen.findByText('条目一');
    await user.click(screen.getByRole('checkbox', { name: '选中 条目一' }));
    await user.click(screen.getByRole('button', { name: '删除' }));
    expect(await screen.findByText(/确定删除已选中的/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '保留' }));
    expect(knowledgeClient.removeEntry).not.toHaveBeenCalled();
    expect(screen.queryByText('确认删除选中条目')).toBeNull();
  });

  it('hides the batch toolbar again after cancelling the selection', async () => {
    mockList([entry('k1', '条目一')]);
    renderPage();
    const user = userEvent.setup();
    await screen.findByText('条目一');
    await user.click(screen.getByRole('checkbox', { name: '选中 条目一' }));
    expect(screen.getByRole('toolbar', { name: '批量操作' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('toolbar', { name: '批量操作' })).toBeNull();
  });
});