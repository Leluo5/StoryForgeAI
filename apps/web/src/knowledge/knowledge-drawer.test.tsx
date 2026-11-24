import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { KnowledgeDrawer, type KnowledgeDrawerHandle } from './knowledge-drawer';

beforeEach(() => {
  // jsdom 未实现 dialog showModal/close，测试桩保持一致
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});

describe('KnowledgeDrawer', () => {
  it('opens via the imperative handle and marks the dialog open', () => {
    const ref = createRef<KnowledgeDrawerHandle>();
    render(<KnowledgeDrawer ref={ref} workId="w1" />);
    ref.current!.open();
    expect(screen.getByRole('dialog', { name: '知识库' })).toBeVisible();
    expect(ref.current!.isOpen()).toBe(true);
  });

  it('closes via the close button and fires onClose', async () => {
    const onClose = vi.fn();
    const ref = createRef<KnowledgeDrawerHandle>();
    render(<KnowledgeDrawer ref={ref} workId="w1" onClose={onClose} />);
    ref.current!.open();
    await userEvent.click(screen.getByRole('button', { name: '关闭知识库' }));
    expect(ref.current!.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('exposes the work id to the body for scope resolution', () => {
    render(<KnowledgeDrawer workId="work-42" />);
    expect(document.querySelector('.knowledge-drawer__body')).toHaveAttribute('data-work-id', 'work-42');
  });

  it('no-ops when open is called twice', () => {
    const ref = createRef<KnowledgeDrawerHandle>();
    render(<KnowledgeDrawer ref={ref} workId={null} />);
    ref.current!.open();
    const dialog = screen.getByRole('dialog', { name: '知识库' }) as HTMLDialogElement;
    const show = vi.spyOn(dialog, 'showModal');
    ref.current!.open();
    expect(show).not.toHaveBeenCalled();
  });

  // T30：两库页签 + 检索栏
  it('renders only the global tab when no work context is present', () => {
    const ref = createRef<KnowledgeDrawerHandle>();
    render(<KnowledgeDrawer ref={ref} workId={null} />);
    ref.current!.open();
    expect(screen.getByRole('tab', { name: '知识库' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: '作品库' })).not.toBeInTheDocument();
  });

  it('renders both tabs when a work id is present and switches scope', async () => {
    const ref = createRef<KnowledgeDrawerHandle>();
    render(<KnowledgeDrawer ref={ref} workId="w1" />);
    ref.current!.open();
    const workTab = screen.getByRole('tab', { name: '作品库' });
    expect(workTab).toHaveAttribute('aria-selected', 'false');
    await userEvent.click(workTab);
    expect(screen.getByRole('tab', { name: '作品库' })).toHaveAttribute('aria-selected', 'true');
    expect(document.querySelector('.knowledge-drawer__body')).toHaveAttribute('data-work-id', 'w1');
  });

  it('switching scope resets the item list via SCOPE_SET', async () => {
    const ref = createRef<KnowledgeDrawerHandle>();
    render(<KnowledgeDrawer ref={ref} workId="w1" />);
    ref.current!.open();
    await userEvent.click(screen.getByRole('tab', { name: '作品库' }));
    expect(document.querySelector('.knowledge-empty')).toBeInTheDocument();
  });

  it('shows the search bar and empty state', async () => {
    const ref = createRef<KnowledgeDrawerHandle>();
    render(<KnowledgeDrawer ref={ref} workId="w1" />);
    ref.current!.open();
    expect(screen.getByPlaceholderText('搜索标题、标签、内容…')).toBeInTheDocument();
    expect(screen.getByText('没有匹配的素材。')).toBeInTheDocument();
    expect(screen.getByText('选择左侧条目查看详情。')).toBeInTheDocument();
  });
});
