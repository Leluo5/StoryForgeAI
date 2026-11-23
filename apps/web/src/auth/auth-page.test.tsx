import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SessionResponse } from '@storyforge/contracts';
import { AuthPage } from './auth-page';

const session: SessionResponse = {
  author: { id: 'a1', email: 'author@example.com', display_name: 'Author' },
  csrf_token: 'a'.repeat(64)
};

it('submits credentials and exposes server errors', async () => {
  const user = userEvent.setup();
  const login = vi.fn().mockRejectedValue(new Error('Invalid credentials'));
  render(<AuthPage login={login} onSuccess={vi.fn()} />);

  await user.type(screen.getByLabelText('邮箱'), 'author@example.com');
  await user.type(screen.getByLabelText('密码'), 'correct horse');
  await user.click(screen.getByRole('button', { name: '登录' }));

  expect(login).toHaveBeenCalledWith({ email: 'author@example.com', password: 'correct horse' });
  expect(await screen.findByRole('alert')).toHaveTextContent('Invalid credentials');
  expect(screen.getByRole('button', { name: '登录' })).toBeEnabled();
});

it('shows an auto-registration notice when the account was created', async () => {
  const user = userEvent.setup();
  const login = vi.fn().mockResolvedValue({ ...session, created: true });
  const onSuccess = vi.fn();
  render(<AuthPage login={login} onSuccess={onSuccess} />);

  await user.type(screen.getByLabelText('邮箱'), 'new@example.com');
  await user.type(screen.getByLabelText('密码'), 'password123');
  await user.click(screen.getByRole('button', { name: '登录' }));

  expect(await screen.findByRole('status')).toHaveTextContent('已自动创建账号并成功登录');
  expect(onSuccess).toHaveBeenCalledWith(expect.objectContaining({ created: true }));
});

it('does not show a creation notice for an already registered account', async () => {
  const user = userEvent.setup();
  const login = vi.fn().mockResolvedValue({ ...session, created: false });
  render(<AuthPage login={login} onSuccess={vi.fn()} />);

  await user.type(screen.getByLabelText('邮箱'), 'author@example.com');
  await user.type(screen.getByLabelText('密码'), 'correct horse');
  await user.click(screen.getByRole('button', { name: '登录' }));

  expect(await screen.findByRole('button', { name: '登录' })).toBeEnabled();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
