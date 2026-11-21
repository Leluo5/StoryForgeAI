import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { CollabTaskDetail } from '@storyforge/contracts';
import type { CollabClient } from './collab-client';
import type { TaskEvent } from '../ai/ai-client';
import './collab-panel.css';

const EVENT_LABEL: Record<string, string> = {
  queued: '已入队',
  running: '执行中',
  progress: '生成中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消'
};

interface Props {
  workId: string;
  taskId: string;
  client: CollabClient;
  /** 外部注入的 SSE 订阅（复用既有事件流），供进度展示 */
  subscribe?: (workId: string, taskId: string, onEvent: (event: TaskEvent) => void) => { close: () => void };
}

export function CollabTaskProgress({ workId, taskId, client, subscribe }: Props): JSX.Element {
  const [detail, setDetail] = useState<CollabTaskDetail | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const streamRef = useRef<{ close: () => void } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await client.getTaskDetail(workId, taskId);
      setDetail(next);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '任务详情加载失败');
    } finally {
      setLoading(false);
    }
  }, [client, workId, taskId]);

  useEffect(() => { void load(); }, [load]);

  // 订阅既有任务事件流（SSE），完成后自动关闭
  useEffect(() => {
    if (!subscribe) return;
    const stream = subscribe(workId, taskId, (event) => {
      setEvents((prev) => [...prev, event]);
    });
    streamRef.current = stream;
    return () => stream.close();
  }, [subscribe, workId, taskId]);

  useEffect(() => {
    if (events.some((event) => event.type === 'succeeded' || event.type === 'failed' || event.type === 'cancelled')) {
      streamRef.current?.close();
    }
  }, [events]);

  const status = detail?.task.status ?? null;
  const channel = detail?.task.channel ?? null;

  return (
    <div className="collab-card">
      <div className="collab-card-title">
        任务进度
        {status && <span className="collab-tag">{EVENT_LABEL[status] ?? status}</span>}
        {channel && <span className="collab-tag collab-tag-muted">{channel}</span>}
      </div>
      {loading && <div className="collab-muted">加载任务详情…</div>}
      {error && <div className="collab-error">{error}</div>}
      {detail && (
        <>
          {detail.task.error && (
            <div className="collab-error">任务错误：{String(detail.task.error.message ?? detail.task.error)}</div>
          )}
          {detail.citations.length > 0 && (
            <div className="collab-block">
              <div className="collab-block-title">引用资料（{detail.citations.length}）</div>
              <ul className="collab-list">
                {detail.citations.map((citation) => (
                  <li key={citation.source_id} className="collab-item">
                    <div className="collab-item-title">{citation.title}</div>
                    <div className="collab-item-sub">{citation.snippet}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {detail.writeback && (
            <div className="collab-block">
              <div className="collab-block-title">
                写回结果（{detail.writeback.fields.length} 字段）
              </div>
              <ul className="collab-list">
                {detail.writeback.fields.map((field) => (
                  <li key={field.field_key} className="collab-item">
                    <div className="collab-item-title">
                      {field.field_key}
                      <span className="collab-tag">{field.status}</span>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {detail.archive && (
            <div className="collab-block">
              <div className="collab-block-title">归档</div>
              <div className="collab-item-sub">
                状态 {detail.archive.status} · 尝试 {detail.archive.attempts}
              </div>
            </div>
          )}
          {events.length > 0 && (
            <div className="collab-block">
              <div className="collab-block-title">事件流</div>
              <ul className="collab-list">
                {events.map((event, index) => (
                  <li key={`${event.seq}-${index}`} className="collab-item">
                    <span className="collab-tag">{EVENT_LABEL[event.type] ?? event.type}</span>
                    <span className="collab-item-sub">#{event.seq}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}
