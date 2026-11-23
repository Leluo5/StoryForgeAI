import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ModuleLayout } from './module-layout';

function renderLayout() {
  return render(<MemoryRouter initialEntries={['/works']}><Routes>
    <Route element={<ModuleLayout />}>
      <Route path="/works" element={<div className="module-content">模块内容</div>} />
    </Route>
  </Routes></MemoryRouter>);
}

describe('ModuleLayout', () => {
  it('renders the side navigation and its children', () => {
    renderLayout();
    expect(screen.getByRole('complementary', { name: '功能导航' })).toBeVisible();
    expect(screen.getByText('模块内容')).toBeVisible();
  });

  it('expands the toolbar when the toggle is clicked and collapses on content click', () => {
    renderLayout();
    const toggle = screen.getByRole('button', { name: '展开工具栏' });
    fireEvent.click(toggle);
    expect(screen.getByRole('complementary', { name: '功能导航' })).toHaveAttribute('aria-expanded', 'true');
    // 用户在右侧内容区点击 → 自动收缩
    fireEvent.click(screen.getByText('模块内容'));
    expect(screen.getByRole('complementary', { name: '功能导航' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('collapses on content input focus while expanded', () => {
    renderLayout();
    fireEvent.click(screen.getByRole('button', { name: '展开工具栏' }));
    expect(screen.getByRole('complementary', { name: '功能导航' })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.focus(screen.getByText('模块内容'));
    expect(screen.getByRole('complementary', { name: '功能导航' })).toHaveAttribute('aria-expanded', 'false');
  });
});
