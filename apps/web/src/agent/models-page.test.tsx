import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { ModelsPage } from './models-page';

describe('ModelsPage', () => {
  it('renders the placeholder page with title and development notice', () => {
    render(<MemoryRouter initialEntries={['/models']}><Routes>
      <Route path="/models" element={<ModelsPage />} />
    </Routes></MemoryRouter>);
    expect(screen.getByRole('heading', { name: '模型' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('模型管理功能开发中');
  });
});
