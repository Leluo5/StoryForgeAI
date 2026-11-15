import { render, screen } from '@testing-library/react';
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
});
