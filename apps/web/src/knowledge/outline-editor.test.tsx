import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OutlineEditor } from './outline-editor';
import type { KnowledgeEntryOutline } from '@storyforge/contracts';

const outline: KnowledgeEntryOutline = {
  chapters: [
    { title: '第一章', summary: '开篇' },
    { title: '第二章', summary: '发展' }
  ],
  plot_nodes: [],
  character_relations: [],
  story_lines: []
};

describe('OutlineEditor', () => {
  it('renders chapter inputs with their values', () => {
    render(<OutlineEditor outline={outline} version={3} />);
    const titles = screen.getAllByDisplayValue('第一章');
    expect(titles).toHaveLength(1);
    expect(screen.getByDisplayValue('开篇')).toBeInTheDocument();
    expect(screen.getByDisplayValue('第二章')).toBeInTheDocument();
  });

  it('allows editing a chapter title', async () => {
    render(<OutlineEditor outline={outline} version={3} />);
    const title = screen.getByLabelText('章节 1 标题');
    fireEvent.change(title, { target: { value: '序章' } });
    expect(screen.getByDisplayValue('序章')).toBeInTheDocument();
  });

  it('saves the edited outline with the expected version', async () => {
    const onSave = vi.fn();
    render(<OutlineEditor outline={outline} version={3} onSave={onSave} />);
    const title = screen.getByLabelText('章节 1 标题');
    fireEvent.change(title, { target: { value: '序章' } });
    await userEvent.click(screen.getByRole('button', { name: '保存大纲' }));

    expect(onSave).toHaveBeenCalledTimes(1);
    const [savedOutline, version] = onSave.mock.calls[0]!;
    expect(version).toBe(3);
    expect(savedOutline.chapters[0]?.title).toBe('序章');
  });

  it('adds a chapter', async () => {
    render(<OutlineEditor outline={outline} version={3} />);
    await userEvent.click(screen.getByRole('button', { name: '添加章节' }));
    // 新增章节渲染一个空标题输入框
    expect(screen.getAllByPlaceholderText('章节标题')).toHaveLength(3);
  });

  it('removes a chapter', async () => {
    render(<OutlineEditor outline={outline} version={3} />);
    await userEvent.click(screen.getAllByRole('button', { name: /删除章节/ })[0]!);
    expect(screen.queryByDisplayValue('第一章')).not.toBeInTheDocument();
  });

  it('disables save while saving', () => {
    render(<OutlineEditor outline={outline} version={3} saving />);
    const saveButton = screen.getByRole('button', { name: '保存中…' });
    expect(saveButton).toBeDisabled();
  });
});
