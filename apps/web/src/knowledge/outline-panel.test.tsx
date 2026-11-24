import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OutlinePanel } from './outline-panel';
import type { KnowledgeEntryDetail } from '@storyforge/contracts';

const baseDetail = {
  kind: 'entry' as const,
  id: 'entry-1',
  entry_type: 'novel' as const,
  title: '小说',
  excerpt: '',
  tags: [],
  structure_status: 'ready' as const,
  outline_status: 'ready' as const,
  favorite: false,
  pinned: false,
  created_at: '2026-11-24T00:00:00.000Z',
  updated_at: '2026-11-24T00:00:00.000Z',
  original_text: 'text',
  structured: null,
  outline: null,
  version: 1,
  content_hash: 'h'
};

const outline = {
  chapters: [
    { title: '第一章', summary: '开篇' },
    { title: '第二章', summary: '发展' }
  ],
  plot_nodes: [
    { title: '节点1', summary: '事件', chapter_index: 0 }
  ],
  character_relations: [
    { source: 'A', target: 'B', relation: '师徒' }
  ],
  story_lines: [
    { name: '主线', description: '主线情节', chapter_indexes: [0, 1] }
  ]
};

describe('OutlinePanel', () => {
  it('renders the four dimensions with grouped data', () => {
    render(<OutlinePanel detail={{ ...baseDetail, outline }} />);
    expect(screen.getByText('章节')).toBeInTheDocument();
    expect(screen.getByText('情节节点')).toBeInTheDocument();
    expect(screen.getByText('人物关系')).toBeInTheDocument();
    expect(screen.getByText('故事线')).toBeInTheDocument();
    // 章节由 OutlineEditor 渲染为输入框值
    expect(screen.getByDisplayValue('第一章')).toBeInTheDocument();
    expect(screen.getByText('节点1')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('主线')).toBeInTheDocument();
  });

  it('shows a degraded notice when there are no chapters', () => {
    render(<OutlinePanel detail={{ ...baseDetail, outline: { ...outline, chapters: [] } }} onRestructure={() => {}} />);
    expect(screen.getByText(/未提取到章节/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重新提取/ })).toBeInTheDocument();
  });

  it('calls onRestructure when the re-extract button is clicked', async () => {
    const onRestructure = vi.fn();
    render(<OutlinePanel detail={{ ...baseDetail, outline: { ...outline, chapters: [] } }} onRestructure={onRestructure} />);
    await userEvent.click(screen.getByRole('button', { name: /重新提取/ }));
    expect(onRestructure).toHaveBeenCalled();
  });

  it('shows extracting progress while pending', () => {
    render(<OutlinePanel detail={{ ...baseDetail, outline_status: 'pending' }} progress={42} />);
    expect(screen.getByText(/提取中/)).toBeInTheDocument();
    expect(screen.getByText(/42%/)).toBeInTheDocument();
  });

  it('shows an empty state when outline is null', () => {
    render(<OutlinePanel detail={baseDetail} />);
    expect(screen.getByText(/暂无大纲/)).toBeInTheDocument();
  });
});
