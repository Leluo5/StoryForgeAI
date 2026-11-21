import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api/client';
import { sendArkClawMessage } from './arkclaw-client';
import './arkclaw-page.css';

function errorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    return cause.status === 403 ? '请求校验失败，请刷新页面后重试' : cause.message;
  }
  return 'ArkClaw 连接失败，请稍后手动重试';
}

export function ArkClawPage() {
  const navigate = useNavigate();
  const [message, setMessage] = useState('');
  const [answer, setAnswer] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalized = message.trim();
    if (pending || !normalized) return;
    if (normalized.length > 4000) {
      setError('问题不能超过 4000 字');
      return;
    }

    setPending(true);
    setAnswer('');
    setError('');
    try {
      setAnswer((await sendArkClawMessage(normalized)).answer);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return <main className="arkclaw-page">
    <button type="button" className="arkclaw-back" onClick={() => navigate('/works')}>返回作品库</button>
    <h1>ArkClaw 对话验证</h1>
    <p className="arkclaw-boundary">单轮问答，不保存历史；每次提问都是独立会话。</p>
    <form className="arkclaw-form" onSubmit={submit}>
      <label htmlFor="arkclaw-message">问题</label>
      <textarea
        id="arkclaw-message"
        required
        maxLength={4000}
        disabled={pending}
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder="请输入一个问题"
      />
      <span className="arkclaw-count">{message.length}/4000</span>
      <button type="submit" disabled={pending || !message.trim()}>{pending ? '发送中…' : '发送'}</button>
    </form>
    {error && <p role="alert" className="arkclaw-error">{error}</p>}
    <section aria-labelledby="arkclaw-answer-title" className="arkclaw-answer-section">
      <h2 id="arkclaw-answer-title">回答</h2>
      {pending && <p role="status">正在等待 ArkClaw 完整回答，最长 120 秒</p>}
      {!pending && answer && <p className="arkclaw-answer">{answer}</p>}
      {!pending && !answer && <p className="arkclaw-empty">尚未获得回答</p>}
    </section>
  </main>;
}
