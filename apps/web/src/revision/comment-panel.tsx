import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { Comment, CommentStatus, Todo } from '@storyforge/contracts';
import {
  createComment, listComments, replyComment, resolveComment, reopenComment, createTodo
} from './collab-client';
import './comment-panel.css';

interface Props { workId: string; chapterId: string; onTodoCreated?: (todo: Todo) => void }

const STATUS_LABEL: Record<CommentStatus, string> = { open: '进行中', resolved: '已解决', reopened: '已重新打开' };

function timeOf(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

// 评论树：按 parent_id 聚合成顶层线程 + 回复列表
interface Thread { comment: Comment; replies: Comment[] }

export function CommentPanel({ workId, chapterId, onTodoCreated }: Props) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState<string>('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const result = await listComments(workId, chapterId);
      setComments(result.comments);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '评论加载失败');
    } finally {
      setLoading(false);
    }
  }, [workId, chapterId]);

  useEffect(() => { void load(); }, [load]);

  const threads = useMemo(() => {
    const top = comments.filter((comment) => comment.parent_id === null);
    return top.map((comment) => ({ comment, replies: comments.filter((item) => item.parent_id === comment.id) }));
  }, [comments]);

  async function submitCreate(): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed || busy) return;
    setBusy('create');
    try {
      // 锚点：面板创建默认无选区，以 (0,0) 空锚点定位；划词创建由编辑器选区回调注入（后续 M2-T11 交互增强）
      await createComment(workId, chapterId, {
        anchor: { start: 0, end: 1, original_text: '', before_text: '', after_text: '', version: 0 },
        content: trimmed
      });
      setContent('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '评论创建失败');
    } finally {
      setBusy('');
    }
  }

  async function doReply(commentId: string, text: string): Promise<void> {
    if (!text.trim() || busy) return;
    setBusy(`reply-${commentId}`);
    try {
      await replyComment(workId, commentId, text.trim());
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '回复失败');
    } finally {
      setBusy('');
    }
  }

  async function doResolve(commentId: string): Promise<void> {
    if (busy) return;
    setBusy(`resolve-${commentId}`);
    try {
      await resolveComment(workId, commentId);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setBusy('');
    }
  }

  async function doReopen(commentId: string): Promise<void> {
    if (busy) return;
    setBusy(`reopen-${commentId}`);
    try {
      await reopenComment(workId, commentId);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
    } finally {
      setBusy('');
    }
  }

  async function doToTodo(comment: Comment): Promise<void> {
    if (busy) return;
    setBusy(`todo-${comment.id}`);
    try {
      const result = await createTodo(workId, {
        title: comment.content.slice(0, 200),
        chapter_id: chapterId,
        comment_id: comment.id
      });
      onTodoCreated?.(result.todo);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '转待办失败');
    } finally {
      setBusy('');
    }
  }

  function renderComment(comment: Comment, isReply = false): JSX.Element {
    const orphaned = comment.anchor_status === 'orphaned';
    return <article key={comment.id} className={`comment-card ${isReply ? 'comment-reply' : ''} ${orphaned ? 'comment-orphaned' : ''}`}>
      <header className="comment-head">
        <span className="comment-status" data-status={comment.status}>{STATUS_LABEL[comment.status]}</span>
        {orphaned && <span className="comment-orphan-tag" title="原文位置已无法定位，锚点已失联">评论已失联</span>}
        <time>{timeOf(comment.created_at)}</time>
      </header>
      <p className="comment-text">{comment.content}</p>
      {orphaned && comment.anchor.original_text && (
        <blockquote className="comment-quote" title="失联前的原文引用">{comment.anchor.original_text}</blockquote>
      )}
      {!isReply && (
        <div className="comment-actions">
          {comment.status !== 'resolved'
            ? <button type="button" disabled={busy === `resolve-${comment.id}`} onClick={() => void doResolve(comment.id)}>解决</button>
            : <button type="button" disabled={busy === `reopen-${comment.id}`} onClick={() => void doReopen(comment.id)}>重新打开</button>}
          <button type="button" disabled={busy === `todo-${comment.id}`} onClick={() => void doToTodo(comment)}>转待办</button>
        </div>
      )}
    </article>;
  }

  if (loading) return <section aria-label="评论"><p role="status">正在加载评论</p></section>;

  return <section aria-label="评论侧栏">
    <h2>评论</h2>
    {error && <p role="alert">{error}</p>}
    <div className="comment-compose">
      <label htmlFor="comment-content">新评论</label>
      <textarea id="comment-content" rows={3} value={content}
        onChange={(event) => setContent(event.target.value)} placeholder="输入评论内容（划词创建由编辑器选区注入，此处为手动入口）" />
      <button type="button" disabled={busy !== '' || !content.trim()} onClick={() => void submitCreate()}>提交评论</button>
    </div>
    <div className="comment-list">
      {threads.length === 0 && <p className="comment-empty">暂无评论</p>}
      {threads.map(({ comment, replies }) => (
        <div key={comment.id} className="comment-thread">
          {renderComment(comment)}
          <ReplyRow onReply={(text) => doReply(comment.id, text)} disabled={busy === `reply-${comment.id}`} />
          {replies.map((reply) => renderComment(reply, true))}
        </div>
      ))}
    </div>
  </section>;
}

function ReplyRow({ onReply, disabled }: { onReply: (text: string) => void; disabled: boolean }) {
  const [text, setText] = useState('');
  return <div className="comment-reply-row">
    <input aria-label="回复内容" placeholder="回复…" value={text} onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && text.trim()) { onReply(text); setText(''); }
      }} />
    <button type="button" disabled={disabled || !text.trim()}
      onClick={() => { onReply(text); setText(''); }}>回复</button>
  </div>;
}
