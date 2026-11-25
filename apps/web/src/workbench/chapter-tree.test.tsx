import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { TreeResponse } from '@storyforge/contracts';
import { ChapterTree } from './chapter-tree';

const workId = crypto.randomUUID();
const volumeId = crypto.randomUUID();
const firstId = crypto.randomUUID();
const secondId = crypto.randomUUID();
const tree: TreeResponse = {
  work: {
    id: workId, author_id: crypto.randomUUID(), title: '测试作品', description: '', status: 'active',
    is_public: true, access_code: '',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString()
  },
  volumes: [{ id: volumeId, work_id: workId, title: '第一卷', position: 0 }],
  chapters: [
    { id: firstId, work_id: workId, volume_id: volumeId, title: '第一章', position: 0, version: 0, content_hash: 'a'.repeat(64) },
    { id: secondId, work_id: workId, volume_id: volumeId, title: '第二章', position: 1, version: 0, content_hash: 'a'.repeat(64) }
  ]
};

describe('ChapterTree', () => {
  it('opens deep links and supports arrow-key navigation', async () => {
    const open = vi.fn();
    render(<MemoryRouter><ChapterTree tree={tree} currentChapterId={firstId} onOpen={open} onAction={vi.fn()} /></MemoryRouter>);
    const first = screen.getByRole('link', { name: '第一章' });
    first.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('link', { name: '第二章' })).toHaveFocus();
    await userEvent.click(screen.getByRole('link', { name: '第二章' }));
    expect(open).toHaveBeenCalledWith(secondId);
  });

  it('returns a newly created chapter id for immediate navigation', async () => {
    const action = vi.fn().mockResolvedValue(secondId);
    const open = vi.fn();
    vi.spyOn(window, 'prompt').mockReturnValue('新章节');
    render(<MemoryRouter><ChapterTree tree={tree} currentChapterId={firstId} onOpen={open} onAction={action} /></MemoryRouter>);
    await userEvent.click(screen.getByRole('button', { name: '在第一卷新建章节' }));
    expect(action).toHaveBeenCalledWith({ type: 'create_chapter', volumeId, title: '新章节' });
    expect(open).toHaveBeenCalledWith(secondId);
  });

  it('moves rename and reorder actions into a context menu and keeps only a plus button', async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(window, 'prompt').mockReturnValue('新名');
    render(<MemoryRouter><ChapterTree tree={tree} currentChapterId={firstId} onOpen={vi.fn()} onAction={action} /></MemoryRouter>);
    // 行内重命名 / 上移 / 下移按钮已移除，只保留加号新建章节
    expect(screen.queryByRole('button', { name: '重命名第一章' })).toBeNull();
    expect(screen.queryByRole('button', { name: '上移第一章' })).toBeNull();
    expect(screen.queryByRole('button', { name: '下移第一章' })).toBeNull();
    expect(screen.getByRole('button', { name: '在第一卷新建章节' })).toBeInTheDocument();
    // 右键章节后菜单提供重命名与上移 / 下移
    fireEvent.contextMenu(screen.getByRole('link', { name: '第二章' }));
    expect(await screen.findByRole('menu')).toBeVisible();
    expect(screen.getByRole('menuitem', { name: '重命名章节' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '上移' })).toBeInTheDocument();
    // 末位章节的下移禁用
    expect(screen.getByRole('menuitem', { name: '下移' })).toBeDisabled();
    await userEvent.click(screen.getByRole('menuitem', { name: '重命名章节' }));
    expect(action).toHaveBeenCalledWith({ type: 'rename_chapter', chapterId: secondId, title: '新名' });
  });

  it('keeps long volume and chapter titles truncated and exposes them via title', () => {
    const longTitle = '这是一个超过导航栏显示宽度的很长很长的卷名称';
    render(<MemoryRouter><ChapterTree tree={{ ...tree, volumes: [{ id: volumeId, work_id: workId, title: longTitle, position: 0 }] }}
      currentChapterId={firstId} onOpen={vi.fn()} onAction={vi.fn()} /></MemoryRouter>);
    expect(screen.getByText(longTitle)).toHaveAttribute('title', longTitle);
  });
});
