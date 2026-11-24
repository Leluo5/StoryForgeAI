import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeEntryDetail } from '@storyforge/contracts';
import { EntryDetail } from './entry-detail';

const detail = (overrides: Partial<KnowledgeEntryDetail> = {}): KnowledgeEntryDetail => ({
  kind: 'entry',
  id: 'e1',
  entry_type: 'novel',
  title: '测试小说',
  excerpt: '摘要',
  tags: ['设定'],
  structure_status: 'ready',
  favorite: false,
  pinned: false,
  created_at: '2026-11-24T00:00:00.000Z',
  updated_at: '2026-11-24T00:00:00.000Z',
  original_text: '第一行\n第二行',
  structured: {
    entry_type: 'novel',
    characters: [{ name: '小明', role: '主角', description: '勇敢' }],
    plot_summary: '冒险故事',
    narrative_style: '第一人称',
    worldview: '现代都市'
  },
  outline: null,
  version: 3,
  content_hash: 'hash',
  ...overrides
});

describe('EntryDetail', () => {
  it('shows a placeholder when nothing is selected', () => {
    render(<EntryDetail detail={null} loading={false} versionConflict={null} onReload={() => {}} />);
    expect(screen.getByText('选择左侧条目查看详情。')).toBeInTheDocument();
  });

  it('renders original text by default', () => {
    render(<EntryDetail detail={detail()} loading={false} versionConflict={null} onReload={() => {}} />);
    expect(screen.getByText('测试小说')).toBeInTheDocument();
    expect(screen.getByText('第一行')).toBeInTheDocument();
    expect(screen.getByText('第二行')).toBeInTheDocument();
  });

  it('switches to structured view and renders novel blocks', async () => {
    render(<EntryDetail detail={detail()} loading={false} versionConflict={null} onReload={() => {}} />);
    await userEvent.click(screen.getByRole('tab', { name: '结构化' }));
    expect(screen.getByText('冒险故事')).toBeInTheDocument();
    expect(screen.getByText('小明')).toBeInTheDocument();
    expect(screen.getByText('第一人称')).toBeInTheDocument();
  });

  it('disables structured tab when structure is not ready', () => {
    render(<EntryDetail detail={detail({ structure_status: 'pending', structured: null })}
      loading={false} versionConflict={null} onReload={() => {}} />);
    expect(screen.getByRole('tab', { name: '结构化' })).toBeDisabled();
  });

  it('renders version conflict banner and triggers reload', async () => {
    const onReload = vi.fn();
    render(<EntryDetail detail={detail()} loading={false} versionConflict={{ currentVersion: 5 }} onReload={onReload} />);
    expect(screen.getByRole('alert')).toHaveTextContent('服务器版本 5');
    await userEvent.click(screen.getByRole('button', { name: '重新加载' }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('renders paper structured blocks', async () => {
    const paper = detail({
      entry_type: 'paper',
      structured: {
        entry_type: 'paper',
        research_question: '如何写作？',
        method: '实验',
        findings: '有效',
        contributions: '贡献',
        limitations: '样本小',
        keywords: ['写作']
      }
    });
    render(<EntryDetail detail={paper} loading={false} versionConflict={null} onReload={() => {}} />);
    await userEvent.click(screen.getByRole('tab', { name: '结构化' }));
    expect(screen.getByText('如何写作？')).toBeInTheDocument();
    expect(screen.getByText('实验')).toBeInTheDocument();
  });
});
