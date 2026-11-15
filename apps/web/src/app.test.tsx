import { render, screen } from '@testing-library/react';
import type { SessionResponse } from '@storyforge/contracts';
import { App, type AuthClient } from './app';
import { ApiError } from './auth/auth-client';

const session: SessionResponse = {
  author: {
    id: '0f7b70de-24f0-4f0f-a568-96bb1a95bd62',
    email: 'author@example.com',
    display_name: 'M0 Author'
  },
  csrf_token: 'a'.repeat(64)
};

function client(overrides: Partial<AuthClient>): AuthClient {
  return {
    login: vi.fn(),
    getSession: vi.fn().mockRejectedValue(new ApiError(401, 'UNAUTHORIZED', 'Authentication required', '0f7b70de-24f0-4f0f-a568-96bb1a95bd62')),
    logout: vi.fn(),
    ...overrides
  };
}

it('restores an authenticated session from the API', async () => {
  const getSession = vi.fn().mockResolvedValue(session);
  render(<App client={client({ getSession })} />);

  expect(await screen.findByText('工程基座已就绪')).toBeInTheDocument();
  expect(screen.getByText('M0 Author')).toBeInTheDocument();
  expect(getSession).toHaveBeenCalledTimes(1);
});

it('shows the login form when session recovery returns 401', async () => {
  render(<App client={client({})} />);
  expect(await screen.findByRole('button', { name: '登录' })).toBeInTheDocument();
  expect(screen.queryByText('工程基座已就绪')).not.toBeInTheDocument();
});
