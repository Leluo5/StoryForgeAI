import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { Todo, TodoStatus } from '@storyforge/contracts';
import { createTodo, listTodos, updateTodoStatus } from './collab-client';
import './todo-panel.css';

interface Props { workId: string }

// 待办状态机合法流转（对齐服务层 TRANSITIONS）
const TRANSITIONS: Record<TodoStatus, TodoStatus[]> = {
  open: ['in_progress', 'done', 'cancelled'],
  in_progress: ['open', 'done', 'cancelled'],
  done: ['open'],
  cancelled: ['open']
};
const STATUS_LABEL: Record<TodoStatus, string> = { open: '待处理', in_progress: '进行中', done: '已完成', cancelled: '已取消' };

function timeOf(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

export function TodoPanel({ workId }: Props) {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<TodoStatus | 'all'>('all');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState<string>('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const result = await listTodos(workId);
      setTodos(result.todos);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '待办加载失败');
    } finally {
      setLoading(false);
    }
  }, [workId]);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => filter === 'all' ? todos : todos.filter((todo) => todo.status === filter), [todos, filter]);

  async function submitCreate(): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy('create');
    try {
      await createTodo(workId, {
        title: trimmed,
        description: description.trim() || undefined
      });
      setTitle(''); setDescription('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '待办创建失败');
    } finally {
      setBusy('');
    }
  }

  async function doTransition(todo: Todo, next: TodoStatus): Promise<void> {
    if (busy) return;
    setBusy(`${todo.id}:${next}`);
    try {
      await updateTodoStatus(workId, todo.id, next);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '状态更新失败');
    } finally {
      setBusy('');
    }
  }

  function renderTodo(todo: Todo): JSX.Element {
    const nextStates = TRANSITIONS[todo.status] ?? [];
    return <article key={todo.id} className="todo-card" data-status={todo.status}>
      <header className="todo-head">
        <span className="todo-status">{STATUS_LABEL[todo.status]}</span>
        <time>{timeOf(todo.created_at)}</time>
      </header>
      <h3 className="todo-title">{todo.title}</h3>
      {todo.description && <p className="todo-desc">{todo.description}</p>}
      {todo.assignee_id && <p className="todo-assignee">负责人：{todo.assignee_id.slice(0, 8)}</p>}
      <div className="todo-actions">
        {nextStates.map((next) => (
          <button key={next} type="button" disabled={busy !== ''}
            onClick={() => void doTransition(todo, next)}>{STATUS_LABEL[next]}</button>
        ))}
      </div>
    </article>;
  }

  if (loading) return <section aria-label="待办"><p role="status">正在加载待办</p></section>;

  return <section aria-label="待办面板">
    <h2>待办</h2>
    {error && <p role="alert">{error}</p>}
    <div className="todo-compose">
      <label htmlFor="todo-title">标题</label>
      <input id="todo-title" value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
      <label htmlFor="todo-desc">说明</label>
      <textarea id="todo-desc" rows={2} value={description} maxLength={2000}
        onChange={(event) => setDescription(event.target.value)} />
      <button type="button" disabled={busy !== '' || !title.trim()} onClick={() => void submitCreate()}>创建待办</button>
    </div>
    <div className="todo-filter" role="tablist" aria-label="待办状态筛选">
      {(['all', 'open', 'in_progress', 'done', 'cancelled'] as const).map((key) => (
        <button key={key} type="button" role="tab" aria-selected={filter === key}
          className={filter === key ? 'todo-filter-active' : ''}
          onClick={() => setFilter(key)}>
          {key === 'all' ? '全部' : STATUS_LABEL[key]}
        </button>
      ))}
    </div>
    <div className="todo-list">
      {visible.length === 0 && <p className="todo-empty">暂无待办</p>}
      {visible.map(renderTodo)}
    </div>
  </section>;
}
