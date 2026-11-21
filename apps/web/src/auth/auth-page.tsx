import { useState, type FormEvent } from 'react';
import type { LoginRequest, SessionResponse } from '@storyforge/contracts';
import { Button, Input } from '@storyforge/ui';
import { ApiError } from './auth-client';
import './auth-page.css';

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

/** 品牌区特性要点（墨韵科技风） */
const BRAND_FEATURES = [
  '角色驱动创作',
  '剧情多线推衍',
  '上下文记忆',
  '协作与 AI 协同',
];

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
    <main className="auth-layout">
      {/* 左侧品牌渐变横幅 */}
      <section className="auth-brand" aria-label="StoryForgeAI 产品介绍">
        <div className="auth-brand__mark">
          <span className="auth-brand__logo" aria-hidden="true">墨</span>
          <span>StoryForgeAI</span>
        </div>
        <h1 className="auth-brand__title">让 AI 懂角色、有记忆、能协同</h1>
        <p className="auth-brand__subtitle">
          面向网络小说创作者的专业 AI 写作工具。以角色为驱动，
          从人物设定到剧情推衍，AI 与你并肩完成每一段故事。
        </p>
        <ul className="auth-brand__features">
          {BRAND_FEATURES.map((feature) => (
            <li key={feature} className="auth-brand__feature">
              <span className="auth-brand__feature-dot" aria-hidden="true">✓</span>
              {feature}
            </li>
          ))}
        </ul>
      </section>

      {/* 右侧登录表单 */}
      <section className="auth-panel">
        <div className="auth-card">
          <div className="auth-card__heading">
            <h2 className="auth-card__title">作者登录</h2>
            <p className="auth-card__desc">登录后进入你的创作工作台</p>
          </div>

          <form className="auth-form" onSubmit={submit}>
            <Input
              id="author-email"
              name="email"
              type="email"
              label="邮箱"
              autoComplete="username"
              required
              maxLength={320}
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <Input
              id="author-password"
              name="password"
              type="password"
              label="密码"
              autoComplete="current-password"
              required
              minLength={8}
              maxLength={128}
              placeholder="请输入密码"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />

            {error ? (
              <p className="auth-form__error" role="alert">
                {error.message}
                {error.requestId ? (
                  <span className="auth-form__error-request">（请求 ID：{error.requestId}）</span>
                ) : null}
              </p>
            ) : null}

            <Button
              className="auth-form__submit"
              type="submit"
              variant="primary"
              size="md"
              block
              loading={pending}
            >
              {pending ? '登录中…' : '登录'}
            </Button>
          </form>

          <p className="auth-card__footer">
            StoryForgeAI · 专业小说 AI 写作工具
          </p>
        </div>
      </section>
    </main>
  );
}
