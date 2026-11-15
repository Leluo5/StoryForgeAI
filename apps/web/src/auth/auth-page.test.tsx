import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthPage } from './auth-page';

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
