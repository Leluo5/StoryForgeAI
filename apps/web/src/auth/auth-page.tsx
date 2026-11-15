import { useState, type FormEvent } from 'react';
import type { LoginRequest, SessionResponse } from '@storyforge/contracts';
import { ApiError } from './auth-client';

export interface AuthPageProps {
  login: (input: LoginRequest) => Promise<SessionResponse>;
  onSuccess: (session: SessionResponse) => void;
}

interface DisplayError {
  message: string;
  requestId: string;
}

function toDisplayError(cause: unknown): DisplayError {
  if (cause instanceof ApiError) return { message: cause.message, requestId: cause.requestId };
  return { message: cause instanceof Error ? cause.message : '登录失败', requestId: '' };
}

export function AuthPage({ login, onSuccess }: AuthPageProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<DisplayError | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      onSuccess(await login({ email, password }));
    } catch (cause: unknown) {
      setError(toDisplayError(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <main>
      <h1>StoryForgeAI 作者登录</h1>
      <form onSubmit={submit}>
        <div>
          <label htmlFor="author-email">邮箱</label>
          <input
            id="author-email"
            name="email"
            type="email"
            autoComplete="username"
            required
            maxLength={320}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div>
          <label htmlFor="author-password">密码</label>
          <input
            id="author-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            minLength={8}
            maxLength={128}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        {error ? (
          <p role="alert">
            {error.message}
            {error.requestId ? `（请求 ID：${error.requestId}）` : null}
          </p>
        ) : null}
        <button type="submit" disabled={pending}>{pending ? '登录中…' : '登录'}</button>
      </form>
    </main>
  );
}
