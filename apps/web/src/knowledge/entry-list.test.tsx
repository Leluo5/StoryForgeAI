import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeEntrySummary } from '@storyforge/contracts';
import { EntryList } from './entry-list';

const item = (id: string, overrides: Partial<KnowledgeEntrySummary> = {}): KnowledgeEntrySummary => ({
  kind: 'entry',
  id,
  entry_type: 'article',
  title: `标题 ${id}`,
  excerpt: '摘要内容',
  tags: ['灵感'],
  structure_status: 'ready',
  favorite: false,
  pinned: false,
  created_at: '2026-11-24T00:00:00.000Z',
  updated_at: '2026-11-24T00:00:00.000Z',
  ...overrides
});

describe('EntryList', () => {
  it('renders summary cards and the total count', () => {
    render(
      <EntryList items={[item('a'), item('b')]} total={2} loading={false} selectedEntryId={null}
        hasMore={false} onSelect={() => {}} onLoadMore={() => {}} />
    );
    expect(screen.getByRole('list', { name: '素材列表' })).toBeInTheDocument();
    expect(screen.getByText('标题 a')).toBeInTheDocument();
    expect(screen.getByText('共 2 条')).toBeInTheDocument();
  });

  it('selects an entry on click', async () => {
    const onSelect = vi.fn();
    render(
      <EntryList items={[item('a')]} total={1} loading={false} selectedEntryId={null}
        hasMore={false} onSelect={onSelect} onLoadMore={() => {}} />
    );
    await userEvent.click(screen.getByText('标题 a'));
    expect(onSelect).toHaveBeenCalledWith('a');
  });

  it('shows empty state when there are no items', () => {
    render(
      <EntryList items={[]} total={0} loading={false} selectedEntryId={null}
        hasMore={false} onSelect={() => {}} onLoadMore={() => {}} />
    );
    expect(screen.getByText('没有匹配的素材。')).toBeInTheDocument();
  });

  it('marks the selected card with is-selected', () => {
    const { container } = render(
      <EntryList items={[item('a'), item('b')]} total={2} loading={false} selectedEntryId="b"
        hasMore={false} onSelect={() => {}} onLoadMore={() => {}} />
    );
    const cards = container.querySelectorAll('.entry-card');
    expect(cards[0]).not.toHaveClass('is-selected');
    expect(cards[1]).toHaveClass('is-selected');
  });
});
