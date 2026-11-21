import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { WorkflowsPage } from './workflows-page';

describe('WorkflowsPage', () => {
  it('renders the placeholder page with title and development notice', () => {
    render(<MemoryRouter initialEntries={['/workflows']}><Routes>
      <Route path="/workflows" element={<WorkflowsPage />} />
    </Routes></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '工作流管理' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('工作流管理功能开发中');
    // 返回入口已收口到左侧共享导航工具栏，页面内不再渲染「返回作品库」
    expect(screen.queryByRole('link', { name: '返回作品库' })).toBeNull();
  });
});
