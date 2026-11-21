import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AdminPage } from './admin-page';

describe('AdminPage', () => {
  it('renders the placeholder page with title and development notice', () => {
    render(<MemoryRouter initialEntries={['/admin']}><Routes>
      <Route path="/admin" element={<AdminPage />} />
    </Routes></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '后台' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('后台管理功能开发中');
  });
});
