import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { ChatExperienceEvent, PublicWork } from '@storyforge/contracts';
import { chatStream, getPublicWork, listPublicWorks, verifyWorkAccess } from './experience-client';
import './experience-page.css';

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
}

function visitorId(): string {
  let id = localStorage.getItem('storyforge_experience_user');
  if (!id) {
    id = `visitor_${crypto.randomUUID().replace(/-/g, '')}`;
    localStorage.setItem('storyforge_experience_user', id);
  }
  return id;
}

/**
 * F3 在线体验入口页（/experience）：公开作品列表。
 * 访客无需登录，点击作品进入聊天页；设了访问码的作品在聊天页先验证。
 */
export function ExperiencePage(): JSX.Element {
  const navigate = useNavigate();
  const [works, setWorks] = useState<PublicWork[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await listPublicWorks();
      setWorks(res.works);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '公开作品加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <main className="experience-page">
      <header className="experience-page__banner">
        <h1>在线体验</h1>
        <p>精选公开作品，与智能角色实时对话</p>
      </header>
      {loading && <p className="experience-page__status" role="status">正在加载公开作品</p>}
      {error && <p className="experience-page__error" role="alert">{error}</p>}
      {!loading && !error && (
        works.length === 0
          ? <p className="experience-page__empty">暂无公开作品</p>
          : <ul className="experience-page__list">
              {works.map((work) => (
                <li key={work.id}>
                  <button
                    type="button"
                    className="experience-card"
                    onClick={() => navigate(`/experience/works/${work.id}`)}
                    aria-label={`进入 ${work.name}`}
                  >
                    {work.icon_url
                      ? <img className="experience-card__icon" src={work.icon_url} alt="" />
                      : <span className="experience-card__icon experience-card__icon--fallback" aria-hidden="true">📖</span>}
                    <div className="experience-card__body">
                      <span className="experience-card__name">{work.name}</span>
                      <p className="experience-card__desc">{work.description || '暂无简介'}</p>
                    </div>
                    {work.requires_access_code && <span className="experience-card__lock">需访问码</span>}
                  </button>
                </li>
              ))}
            </ul>
      )}
      <p className="experience-page__footer">
        <Link to="/works">返回创作后台</Link>
      </p>
    </main>
  );
}

/** F3 在线体验聊天页（/experience/works/:workId）：验证访问码（如有）+ SSE 对话 */
export function ExperienceChatPage(): JSX.Element {
  const { workId = '' } = useParams();
  const [work, setWork] = useState<PublicWork>();
  const [accessCode, setAccessCode] = useState('');
  const [accessToken, setAccessToken] = useState<string | null>(() => localStorage.getItem(`storyforge_access_${workId}`));
  const [verified, setVerified] = useState(false);
  const [verifyError, setVerifyError] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const conversationIdRef = useRef<string | null>(null);
  const [pageError, setPageError] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const msgId = useRef(0);

  const loadWork = useCallback(async () => {
    try {
      const detail = await getPublicWork(workId);
      setWork(detail);
      // 未设访问码 → 直接可聊
      if (!detail.requires_access_code) setVerified(true);
      setPageError('');
    } catch (cause) {
      setPageError(cause instanceof Error ? cause.message : '作品加载失败');
    }
  }, [workId]);

  useEffect(() => { void loadWork(); }, [loadWork]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function submitVerify(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setVerifyError('');
    try {
      const res = await verifyWorkAccess(workId, { access_code: accessCode });
      if (!res.granted) {
        setVerifyError('访问码无效');
        return;
      }
      if (res.token) {
        setAccessToken(res.token);
        localStorage.setItem(`storyforge_access_${workId}`, res.token);
      }
      setVerified(true);
    } catch (cause) {
      setVerifyError(cause instanceof Error ? cause.message : '验证失败');
    }
  }

  async function send(): Promise<void> {
    const text = input.trim();
    if (!text || streaming) return;
    setInput('');
    setStreaming(true);
    setMessages((prev) => [...prev, { id: ++msgId.current, role: 'user', content: text }]);
    const assistantId = ++msgId.current;
    setMessages((prev) => [...prev, { id: assistantId, role: 'assistant', content: '', pending: true }]);

    let accumulated = '';
    const updateAssistant = (content: string) => {
      setMessages((prev) => prev.map((m) => m.id === assistantId ? { ...m, content, pending: false } : m));
    };
    const onEvent = (event: ChatExperienceEvent) => {
      if (event.type === 'delta') {
        accumulated += event.content;
        updateAssistant(accumulated);
      } else if (event.type === 'done') {
        if (event.conversation_id) conversationIdRef.current = event.conversation_id;
        setStreaming(false);
      } else if (event.type === 'error') {
        updateAssistant(accumulated || event.message);
        setStreaming(false);
      }
    };
    try {
      await chatStream(workId, {
        user_id: visitorId(),
        conversation_id: conversationIdRef.current,
        message: text
      }, accessToken, onEvent);
    } catch (cause) {
      updateAssistant(cause instanceof Error ? cause.message : '发送失败');
      setStreaming(false);
    }
  }

  if (pageError) {
    return <main className="experience-chat"><p className="experience-page__error" role="alert">{pageError}</p>
      <p><Link to="/experience">返回作品列表</Link></p></main>;
  }

  return (
    <main className="experience-chat">
      <header className="experience-chat__header">
        <Link to="/experience" className="experience-chat__back">← 返回</Link>
        <h1>{work?.name ?? '…'}</h1>
        {work?.description && <p>{work.description}</p>}
      </header>

      {!verified ? (
        <form className="experience-chat__verify" onSubmit={submitVerify}>
          <label htmlFor="experience-access-code">该作品需要访问码才能体验</label>
          <div className="experience-chat__verify-row">
            <input
              id="experience-access-code"
              type="text"
              value={accessCode}
              onChange={(event) => setAccessCode(event.target.value)}
              placeholder="请输入访问码"
              autoComplete="off"
            />
            <button type="submit">进入</button>
          </div>
          {verifyError && <p className="experience-page__error" role="alert">{verifyError}</p>}
        </form>
      ) : (
        <>
          <div className="experience-chat__log" aria-live="polite">
            {work?.prologue && messages.length === 0 && (
              <div className="experience-chat__msg experience-chat__msg--assistant">
                <p>{work.prologue}</p>
              </div>
            )}
            {messages.map((message) => (
              <div key={message.id} className={`experience-chat__msg experience-chat__msg--${message.role}`}>
                <p>{message.content || (message.pending ? '…' : '')}</p>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          <form
            className="experience-chat__input"
            onSubmit={(event) => { event.preventDefault(); void send(); }}
          >
            <input
              type="text"
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder="发消息给角色…"
              disabled={streaming}
              autoComplete="off"
            />
            <button type="submit" disabled={streaming || !input.trim()}>{streaming ? '回复中…' : '发送'}</button>
          </form>
        </>
      )}
    </main>
  );
}
