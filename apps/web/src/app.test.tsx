import { render, screen, waitFor } from '@testing-library/react';
import type { SessionResponse } from '@storyforge/contracts';
import { App } from './app';
import { getSession } from './auth/auth-client';

vi.mock('./auth/auth-client', () => ({ getSession: vi.fn(), login: vi.fn(), logout: vi.fn() }));
vi.mock('./works/works-page', () => ({ WorksPage: () => <p>作品库页面</p> }));
vi.mock('./arkclaw/arkclaw-page', () => ({ ArkClawPage: () => <p>ArkClaw 验证页面</p> }));

beforeEach(() => {
  window.history.pushState({}, '', '/works');
  vi.mocked(getSession).mockReset();
});

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

it('redirects an unauthenticated deep link to the login route', async () => {
  window.history.replaceState({}, '', '/works/work-1/write/chapter-1');
  vi.mocked(getSession).mockRejectedValue(new Error('Authentication required'));
  render(<App />);

  expect(await screen.findByRole('button', { name: '登录' })).toBeInTheDocument();
  await waitFor(() => expect(window.location.pathname).toBe('/login'));
  expect(screen.queryByText('作品库页面')).not.toBeInTheDocument();
});

it('loads the lazy ArkClaw route for an authenticated author', async () => {
  window.history.pushState({}, '', '/arkclaw');
  vi.mocked(getSession).mockResolvedValue(session);
  render(<App />);

  expect(await screen.findByText('ArkClaw 验证页面')).toBeInTheDocument();
});
