import { render, screen } from '@testing-library/react';
import type { SessionResponse } from '@storyforge/contracts';
import { App } from './app';
import { getSession } from './auth/auth-client';

vi.mock('./auth/auth-client', () => ({ getSession: vi.fn(), login: vi.fn() }));
vi.mock('./works/works-page', () => ({ WorksPage: () => <p>作品库页面</p> }));

const session: SessionResponse = {
  author: {
    id: '0f7b70de-24f0-4f0f-a568-96bb1a95bd62',
    email: 'author@example.com',
    display_name: 'M0 Author'
  },
  csrf_token: 'a'.repeat(64)
};

it('restores an authenticated session and lands on the works library', async () => {
  vi.mocked(getSession).mockResolvedValue(session);
  render(<App />);

  expect(await screen.findByText('作品库页面')).toBeInTheDocument();
  expect(getSession).toHaveBeenCalledTimes(1);
});

it('shows the login form when session recovery fails', async () => {
  vi.mocked(getSession).mockRejectedValue(new Error('Authentication required'));
  render(<App />);

  expect(await screen.findByRole('button', { name: '登录' })).toBeInTheDocument();
  expect(screen.queryByText('作品库页面')).not.toBeInTheDocument();
});
