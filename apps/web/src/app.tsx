import { useCallback, useEffect, useState } from 'react';
import type { LoginRequest, SessionResponse } from '@storyforge/contracts';
import { ApiError, authClient } from './auth/auth-client';
import { AuthPage } from './auth/auth-page';

export interface AuthClient {
  login: (input: LoginRequest) => Promise<SessionResponse>;
  getSession: () => Promise<SessionResponse>;
  logout: (csrfToken: string) => Promise<{ logged_out: true }>;
}

type Status = 'loading' | 'anonymous' | 'authenticated' | 'error';

interface DisplayError {
  message: string;
  requestId: string;
}

function toDisplayError(cause: unknown, fallback: string): DisplayError {
  if (cause instanceof ApiError) return { message: cause.message, requestId: cause.requestId };
  return { message: cause instanceof Error ? cause.message : fallback, requestId: '' };
}

function ErrorNotice({ error }: { error: DisplayError }) {
  return (
    <p role="alert">
      {error.message}
      {error.requestId ? `（请求 ID：${error.requestId}）` : null}
    </p>
  );
}

export function App({ client = authClient }: { client?: AuthClient }) {
  const [status, setStatus] = useState<Status>('loading');
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [error, setError] = useState<DisplayError | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  const restore = useCallback(async (): Promise<void> => {
    setStatus('loading');
    setError(null);
    try {
      const restored = await client.getSession();
      setSession(restored);
      setStatus('authenticated');
    } catch (cause: unknown) {
      setSession(null);
      if (cause instanceof ApiError && cause.status === 401) {
        setStatus('anonymous');
      } else {
        setError(toDisplayError(cause, '会话恢复失败'));
        setStatus('error');
      }
    }
  }, [client]);

  useEffect(() => {
    void restore();
  }, [restore]);

  function authenticated(next: SessionResponse): void {
    setSession(next);
    setError(null);
    setStatus('authenticated');
  }

  async function logout(): Promise<void> {
    if (!session || loggingOut) return;
    setLoggingOut(true);
    setError(null);
    try {
      await client.logout(session.csrf_token);
      setSession(null);
      setStatus('anonymous');
    } catch (cause: unknown) {
      setError(toDisplayError(cause, '退出失败'));
    } finally {
      setLoggingOut(false);
    }
  }

  if (status === 'loading') return <main><p>正在恢复会话…</p></main>;
  if (status === 'error') {
    return (
      <main>
        {error ? <ErrorNotice error={error} /> : null}
        <button type="button" onClick={() => void restore()}>重试</button>
      </main>
    );
  }
  if (status === 'anonymous' || !session) {
    return <AuthPage login={client.login} onSuccess={authenticated} />;
  }

  return (
    <main>
      <h1>工程基座已就绪</h1>
      <p>{session.author.display_name}</p>
      {error ? <ErrorNotice error={error} /> : null}
      <button type="button" disabled={loggingOut} onClick={() => void logout()}>
        {loggingOut ? '退出中…' : '退出登录'}
      </button>
    </main>
  );
}
