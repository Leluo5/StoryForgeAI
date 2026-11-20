import { useCallback, useEffect, useState, type JSX } from 'react';
import type { Notification, NotificationType } from '@storyforge/contracts';
import { listNotifications, markRead, markAllRead, unreadCount } from './collab-client';
import './notification-center.css';

const TYPE_LABEL: Record<NotificationType, string> = {
  mention: '提及', assign: '指派', task_result: '任务结果', system: '系统'
};

function timeOf(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

function renderNotification(notification: Notification): JSX.Element {
  const linked = notification.linked_object;
  return <article key={notification.id} className={`notice-card ${notification.read_at ? 'notice-read' : 'notice-unread'}`}>
    <header className="notice-head">
      <span className="notice-type" data-type={notification.type}>{TYPE_LABEL[notification.type]}</span>
      {linked && <span className="notice-linked" title={`${linked.kind}: ${linked.id}`}>{linked.label}</span>}
      <time>{timeOf(notification.created_at)}</time>
    </header>
    <p className="notice-content">{notification.content}</p>
  </article>;
}

export function NotificationCenter() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string>('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [result, count] = await Promise.all([listNotifications(), unreadCount()]);
      setNotifications(result.notifications);
      setUnread(count.unread);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '通知加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function doMarkRead(notification: Notification): Promise<void> {
    if (busy || notification.read_at) return;
    setBusy(`read-${notification.id}`);
    try {
      await markRead(notification.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '标记已读失败');
    } finally {
      setBusy('');
    }
  }

  async function doMarkAll(): Promise<void> {
    if (busy || unread === 0) return;
    setBusy('read-all');
    try {
      await markAllRead();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '全部已读失败');
    } finally {
      setBusy('');
    }
  }

  if (loading) return <section aria-label="通知中心"><p role="status">正在加载通知</p></section>;

  return <section aria-label="通知中心">
    <header className="notice-toolbar">
      <h2>通知 <span className="notice-badge" aria-label={`${unread} 条未读`}>{unread}</span></h2>
      <button type="button" disabled={busy !== '' || unread === 0} onClick={() => void doMarkAll()}>全部已读</button>
    </header>
    {error && <p role="alert">{error}</p>}
    <div className="notice-list">
      {notifications.length === 0 && <p className="notice-empty">暂无通知</p>}
      {notifications.map((notification) => (
        <div key={notification.id} className="notice-item" onClick={() => void doMarkRead(notification)} role="button" tabIndex={0}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') void doMarkRead(notification); }}>
          {renderNotification(notification)}
        </div>
      ))}
    </div>
  </section>;
}
