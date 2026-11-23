import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { SideNav } from './side-nav';

const EXPECTED_LABELS = ['作品库', '知识库', '智能体', '工作流', '模型', '后台'];

describe('SideNav', () => {
  it('renders the six module entries in order', () => {
    render(<MemoryRouter><SideNav expanded={false} onToggle={() => {}} /></MemoryRouter>);
    // aside 带 aria-label 被映射为 complementary role（非 navigation），按容器内链接查询
    const nav = screen.getByRole('complementary', { name: '功能导航' });
    const links = Array.from(nav.querySelectorAll('a'));
    expect(links).toHaveLength(6);
    links.forEach((link, index) => {
      expect(link).toHaveAttribute('aria-label', EXPECTED_LABELS[index]);
    });
    expect(links[0]).toHaveAttribute('href', '/works');
    expect(links[1]).toHaveAttribute('href', '/knowledge');
    expect(links[2]).toHaveAttribute('href', '/agents');
    expect(links[3]).toHaveAttribute('href', '/workflows');
    expect(links[4]).toHaveAttribute('href', '/models');
    expect(links[5]).toHaveAttribute('href', '/admin');
  });

  it('reflects collapsed state with aria-expanded false and no visible labels', () => {
    render(<MemoryRouter><SideNav expanded={false} onToggle={() => {}} /></MemoryRouter>);
    const aside = screen.getByRole('complementary', { name: '功能导航' });
    expect(aside).toHaveAttribute('aria-expanded', 'false');
    expect(aside.classList.contains('side-nav--expanded')).toBe(false);
  });

  it('reflects expanded state and shows labels', () => {
    render(<MemoryRouter><SideNav expanded={true} onToggle={() => {}} /></MemoryRouter>);
    const aside = screen.getByRole('complementary', { name: '功能导航' });
    expect(aside).toHaveAttribute('aria-expanded', 'true');
    expect(aside.classList.contains('side-nav--expanded')).toBe(true);
    EXPECTED_LABELS.forEach((label) => expect(screen.getAllByText(label).length).toBeGreaterThan(0));
  });

  it('calls onToggle when the expand/collapse button is clicked', () => {
    const onToggle = vi.fn();
    render(<MemoryRouter><SideNav expanded={false} onToggle={onToggle} /></MemoryRouter>);
    fireEvent.click(screen.getByRole('button', { name: '展开工具栏' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows the collapse label when expanded', () => {
    render(<MemoryRouter><SideNav expanded={true} onToggle={() => {}} /></MemoryRouter>);
    expect(screen.getByRole('button', { name: '收起工具栏' })).toBeVisible();
  });
});
