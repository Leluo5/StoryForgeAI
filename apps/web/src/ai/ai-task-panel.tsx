import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import type { AiTask, AiTaskEventType, AiTaskStatus, AiTool } from '@storyforge/contracts';
import {
  cancelAiTask,
  createAiTask,
  listAiTasks,
  retryAiTask,
  subscribeTaskEvents,
  type StreamState,
  type TaskEvent
} from './ai-client';
import './ai-task-panel.css';

const TOOL_OPTIONS: Array<{ value: AiTool; label: string; hint: string }> = [
  { value: 'continue', label: '续写', hint: '基于当前章节继续推进剧情' },
  { value: 'rewrite', label: '改写', hint: '在不改变核心情节的前提下优化文笔' },
  { value: 'expand', label: '扩写', hint: '为现有段落补充细节与描写' },
  { value: 'polish', label: '润色', hint: '精修措辞与句式，提升可读性' }
];

const STATUS_LABEL: Record<AiTaskStatus, string> = {
  queued: '排队中',
  running: '执行中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消'
};

// 事件类型 → 中文阶段名（snapshot 为传输层包装，不展示为独立阶段）
const EVENT_LABEL: Record<AiTaskEventType, string> = {
  queued: '任务已入队',
  running: 'AI 开始生成',
  progress: '进度更新',
  succeeded: '生成完成',
  failed: '生成失败',
  cancelled: '任务已取消',
  snapshot: '状态快照'
};

/** 从进度事件 payload 提取 0-100 的百分比，缺省用未知 */
function extractProgress(payload: Record<string, unknown>): number | null {
  const value = payload.progress ?? payload.percent ?? payload.progress_pct;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.min(100, Math.max(0, value));
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.min(100, Math.max(0, parsed));
  }
  return null;
}

/** 从事件 payload 提取可读阶段描述（如 "改写中·第 3/8 段"） */
function describePayload(payload: Record<string, unknown>): string {
  const candidates = [payload.message, payload.stage, payload.step, payload.note];
  for (const item of candidates) {
    if (typeof item === 'string' && item.trim()) return item.trim();
  }
  return '';
}

interface AiTaskPanelProps {
  workId: string;
  chapterId: string;
}

export function AiTaskPanel({ workId, chapterId }: AiTaskPanelProps): JSX.Element {
  const [tasks, setTasks] = useState<AiTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [tool, setTool] = useState<AiTool>('continue');
  const [inputSummary, setInputSummary] = useState('');
  const [streamStates, setStreamStates] = useState<Record<string, StreamState>>({});
  const [eventsByTask, setEventsByTask] = useState<Record<string, TaskEvent[]>>({});
  const [progressByTask, setProgressByTask] = useState<Record<string, number | null>>({});
  // 每个任务的 SSE 订阅句柄（组件卸载时统一关闭）
  const streamsRef = useRef<Map<string, { close: () => void }>>(new Map());

  const load = useCallback(async () => {
    try {
      const result = await listAiTasks(workId, chapterId, { page: 1, page_size: 50 });
      setTasks(result.tasks);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'AI 任务加载失败');
    } finally {
      setLoading(false);
    }
  }, [workId, chapterId]);
  useEffect(() => { void load(); }, [load]);

  // 订阅活跃任务（queued/running）的 SSE，并在收到新事件时追加到事件流
  useEffect(() => {
    const active = tasks.filter((task) => task.status === 'queued' || task.status === 'running');
    const activeIds = new Set(active.map((task) => task.id));
    // 关闭已结束任务的流
    for (const [id, stream] of streamsRef.current) {
      if (!activeIds.has(id)) {
        stream.close();
        streamsRef.current.delete(id);
      }
    }
    for (const task of active) {
      if (streamsRef.current.has(task.id)) continue;
      const stream = subscribeTaskEvents(workId, task.id, {
        // 初始订阅用任务当前 event_seq 作为游标：仅接收新事件，避免重复全量
        since: task.event_seq,
        onEvent: (event) => {
          // snapshot 帧是连接时状态基线：直接同步任务状态（含终态），不追加为事件
          if (event.type === 'snapshot') {
            const snapshotStatus = event.payload.status as AiTaskStatus | undefined;
            if (snapshotStatus && snapshotStatus !== task.status) {
              setTasks((current) => current.map((item) => item.id === task.id
                ? { ...item, status: snapshotStatus, result_revision_set_id: (event.payload.result_revision_set_id as string | null) ?? item.result_revision_set_id, error: (event.payload.error as Record<string, unknown> | null) ?? item.error }
                : item));
            }
            return;
          }
          setEventsByTask((current) => ({
            ...current,
            [task.id]: [...(current[task.id] ?? []), event]
          }));
          const progress = extractProgress(event.payload);
          if (progress !== null) {
            setProgressByTask((current) => ({ ...current, [task.id]: progress }));
          }
        },
        onStateChange: (state) => {
          setStreamStates((current) => ({ ...current, [task.id]: state }));
        },
        onError: (cause) => {
          setError(cause instanceof Error ? cause.message : '事件推送连接异常');
        }
      });
      streamsRef.current.set(task.id, stream);
    }
    return () => {
      // 不在此处统一关闭：依赖 tasks 变化时，已结束任务在上面关闭；活跃任务保留跨渲染
    };
  }, [tasks, workId, chapterId]);

  // 组件卸载时关闭全部订阅
  useEffect(() => {
    const streams = streamsRef.current;
    return () => {
      for (const stream of streams.values()) stream.close();
      streams.clear();
    };
  }, []);

  async function submit(): Promise<void> {
    if (busy) return;
    setBusy('submit');
    setError('');
    try {
      const input = inputSummary.trim();
      await createAiTask(workId, chapterId, {
        tool,
        input_summary: input ? { note: input } : {},
        idempotency_key: crypto.randomUUID()
      });
      setInputSummary('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '任务发起失败');
    } finally {
      setBusy(null);
    }
  }

  async function cancel(task: AiTask): Promise<void> {
    const key = `cancel:${task.id}`;
    if (busy) return;
    setBusy(key); setError('');
    try {
      await cancelAiTask(workId, task.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '取消失败');
    } finally {
      setBusy(null);
    }
  }

  async function retry(task: AiTask): Promise<void> {
    const key = `retry:${task.id}`;
    if (busy) return;
    setBusy(key); setError('');
    try {
      await retryAiTask(workId, task.id);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重试失败');
    } finally {
      setBusy(null);
    }
  }

  function renderEvent(event: TaskEvent, index: number): JSX.Element {
    const desc = describePayload(event.payload);
    return <li key={`${event.seq}:${index}`} className="ai-event">
      <span className="ai-event-type">{EVENT_LABEL[event.type]}</span>
      {desc && <span className="ai-event-desc">{desc}</span>}
      <time dateTime={String(event.seq)}>#{event.seq}</time>
    </li>;
  }

  function renderTask(task: AiTask): JSX.Element {
    const events = eventsByTask[task.id] ?? [];
    const progress = progressByTask[task.id] ?? null;
    const streamState = streamStates[task.id];
    const isActive = task.status === 'queued' || task.status === 'running';
    return <section key={task.id} className="ai-task" aria-label={`AI 任务 ${task.tool}`}>
      <header className="ai-task-head">
        <span className={`ai-task-status ai-task-status-${task.status}`}>{STATUS_LABEL[task.status]}</span>
        <span className="ai-task-tool">{TOOL_OPTIONS.find((opt) => opt.value === task.tool)?.label ?? task.tool}</span>
        <time dateTime={task.created_at}>{new Date(task.created_at).toLocaleString()}</time>
      </header>
      {task.input_summary && Object.keys(task.input_summary).length > 0 && (
        <p className="ai-task-note">{String(task.input_summary.note ?? '')}</p>
      )}
      {isActive && (
        <div className="ai-task-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100}
          aria-valuenow={progress ?? 0} aria-label="任务进度">
          <div className="ai-task-progress-track">
            <div className="ai-task-progress-bar" style={{ width: `${progress ?? 0}%` }} />
          </div>
          <span className="ai-task-progress-text">
            {progress === null ? (streamState === 'open' ? '进行中' : '连接中') : `${Math.round(progress)}%`}
          </span>
        </div>
      )}
      {events.length > 0 && (
        <ol className="ai-events" aria-label="进度事件">
          {events.map(renderEvent)}
        </ol>
      )}
      {task.status === 'failed' && (
        <p className="ai-task-error">{String(task.error?.message ?? task.error?.reason ?? '')}</p>
      )}
      <div className="ai-task-actions">
        {isActive && (
          <button type="button" disabled={busy !== null} onClick={() => void cancel(task)}>
            {busy === `cancel:${task.id}` ? '取消中' : '取消'}
          </button>
        )}
        {task.status === 'failed' && (
          <button type="button" disabled={busy !== null} onClick={() => void retry(task)}>
            {busy === `retry:${task.id}` ? '重试中' : '重试'}
          </button>
        )}
      </div>
    </section>;
  }

  if (loading) return <p role="status">正在加载 AI 任务</p>;
  return <div className="ai-task-panel">
    <h2>AI 创作</h2>
    {error && <p role="alert">{error}</p>}
    <form className="ai-task-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label htmlFor="ai-tool">创作工具</label>
      <select id="ai-tool" value={tool} onChange={(event) => setTool(event.target.value as AiTool)}>
        {TOOL_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
      </select>
      <p className="ai-tool-hint">{TOOL_OPTIONS.find((opt) => opt.value === tool)?.hint}</p>
      <label htmlFor="ai-input">补充说明（可选）</label>
      <textarea id="ai-input" value={inputSummary} rows={3}
        onChange={(event) => setInputSummary(event.target.value)}
        placeholder="例如：让主角在雨中第一次遇见对手……" />
      <button type="submit" disabled={busy !== null}>
        {busy === 'submit' ? '发起中' : '发起创作'}
      </button>
    </form>
    <h3>任务列表</h3>
    {tasks.length === 0
      ? <p className="ai-task-empty">暂无 AI 任务</p>
      : tasks.map(renderTask)}
  </div>;
}
