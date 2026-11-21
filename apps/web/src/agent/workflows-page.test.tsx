import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { WorkflowsPage } from './workflows-page';

describe('WorkflowsPage', () => {
  it('renders the placeholder page with title, back link and development notice', () => {
    render(<MemoryRouter initialEntries={['/workflows']}><Routes>
      <Route path="/workflows" element={<WorkflowsPage />} />
    </Routes></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '工作流管理' })).toBeVisible();
    const back = screen.getByRole('link', { name: '返回作品库' });
    expect(back).toHaveAttribute('href', '/works');
    expect(screen.getByRole('status')).toHaveTextContent('工作流管理功能开发中');
  });
});
