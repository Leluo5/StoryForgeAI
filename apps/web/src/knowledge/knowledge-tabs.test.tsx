import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { KnowledgeTabs } from './knowledge-tabs';

const items = [
  { scope: 'global' as const, label: '知识库' },
  { scope: 'work' as const, label: '作品库' }
];

describe('KnowledgeTabs', () => {
  it('renders a tablist with aria-selected reflecting the active scope', () => {
    render(<KnowledgeTabs value="global" items={items} onChange={() => {}} />);
    const tablist = screen.getByRole('tablist', { name: '素材库范围' });
    expect(tablist).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '知识库' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: '作品库' })).toHaveAttribute('aria-selected', 'false');
  });

  it('calls onChange and moves focus with arrow keys', async () => {
    const onChange = vi.fn();
    render(<KnowledgeTabs value="global" items={items} onChange={onChange} />);
    const globalTab = screen.getByRole('tab', { name: '知识库' });
    globalTab.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('work');
    expect(screen.getByRole('tab', { name: '作品库' })).toHaveFocus();
  });

  it('wraps around when pressing left on the first tab', async () => {
    const onChange = vi.fn();
    render(<KnowledgeTabs value="global" items={items} onChange={onChange} />);
    const globalTab = screen.getByRole('tab', { name: '知识库' });
    globalTab.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenCalledWith('work');
    expect(screen.getByRole('tab', { name: '作品库' })).toHaveFocus();
  });

  it('does not move focus on non-arrow keys', async () => {
    const onChange = vi.fn();
    render(<KnowledgeTabs value="global" items={items} onChange={onChange} />);
    const globalTab = screen.getByRole('tab', { name: '知识库' });
    globalTab.focus();
    await userEvent.keyboard('{a}');
    // 字母键不触发方向导航，也不切换
    expect(onChange).not.toHaveBeenCalled();
    expect(globalTab).toHaveFocus();
  });
});
