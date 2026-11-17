import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { RevisionSet, RevisionStatus } from '@storyforge/contracts';
import {
  acceptOperation, createRevisionSet, listRevisionSets, rejectOperation
} from './revision-client';
import './revision-panel.css';

// 存储格式的单条操作：服务端 revision_set.operations 为 { index, step, status } 包装
interface StoredOperation {
  index: number;
  step: Record<string, unknown>;
  status: 'pending' | 'accepted' | 'rejected';
  [key: string]: unknown;
}
function isStoredOperation(value: unknown): value is StoredOperation {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.index === 'number'
    && typeof record.step === 'object'
    && record.step !== null
    && ['pending', 'accepted', 'rejected'].includes(String(record.status));
}
function toStoredOperations(operations: Array<Record<string, unknown>>): StoredOperation[] {
  return operations.map((item, fallbackIndex) =>
    isStoredOperation(item) ? item : { index: fallbackIndex, step: item, status: 'pending' });
}

const STATUS_LABEL: Record<RevisionStatus, string> = {
  pending: '待处理',
  partially_resolved: '部分接受',
  resolved: '已解决'
};
const OP_LABEL: Record<StoredOperation['status'], string> = {
  pending: '待审',
  accepted: '已接受',
  rejected: '已拒绝'
};

/** 从操作 step 提取简短描述（ProseMirror 变更 step 常见 from/to/text） */
function describeStep(step: Record<string, unknown>): string {
  const type = String(step.type ?? step.stepType ?? '');
  if (type) return `变更类型：${type}`;
  if (typeof step.from === 'number') {
    const to = typeof step.to === 'number' ? step.to : step.from;
    return `替换文本 [${step.from}…${to}]`;
  }
  if (step.text) return `插入文本：${String(step.text).slice(0, 40)}`;
  return '文档变更';
}

interface RevisionPanelProps {
  workId: string;
  chapterId: string;
}

export function RevisionPanel({ workId, chapterId }: RevisionPanelProps) {
  const [revisionSets, setRevisionSets] = useState<RevisionSet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await listRevisionSets(workId, chapterId);
      setRevisionSets(result.revision_sets);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '修订集加载失败');
    } finally { setLoading(false); }
  }, [workId, chapterId]);
  useEffect(() => { void load(); }, [load]);

  const byAi = useMemo(() => ({
    ai: revisionSets.filter((set) => set.ai_set),
    manual: revisionSets.filter((set) => !set.ai_set)
  }), [revisionSets]);

  async function resolve(set: RevisionSet, index: number, decision: 'accept' | 'reject'): Promise<void> {
    const key = `${set.id}:${index}:${decision}`;
    if (busy) return;
    setBusy(key); setError('');
    try {
      const previous = revisionSets;
      // 乐观更新：本地立即更新单条操作状态
      setRevisionSets((current) => current.map((item) => item.id === set.id
        ? { ...item, operations: item.operations.map((op, i) => i === index
          ? { ...op, status: decision === 'accept' ? 'accepted' : 'rejected' }
          : op) }
        : item));
      if (decision === 'accept') await acceptOperation(workId, set.id, index);
      else await rejectOperation(workId, set.id, index);
      // 服务端权威刷新，同步 revision_set.status
      await load();
      // 失败时不回滚：交由 load() 拉取权威状态
      void previous;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '操作失败');
      await load();
    } finally { setBusy(null); }
  }

  async function createAiSet(): Promise<void> {
    if (busy) return;
    setBusy('create'); setError('');
    try {
      // AI 修订集：占位操作（真实场景由编辑器差异生成），此处仅创建空修订集演示交互
      await createRevisionSet(workId, chapterId, {
        actor_type: 'ai',
        base_version: 0,
        operations: [{ step: { type: 'placeholder', text: 'AI 修订占位' } }]
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建失败');
    } finally { setBusy(null); }
  }

  function renderSet(set: RevisionSet): JSX.Element {
    const ops = toStoredOperations(set.operations);
    return <section key={set.id} className="revision-set" aria-label={`修订集 ${set.actor_type}`}>
      <header className="revision-set-head">
        <span className={`revision-source revision-source-${set.actor_type}`}>
          {set.actor_type === 'ai' ? 'AI' : set.actor_type === 'rollback' ? '回滚' : '手工'}
        </span>
        <span className="revision-status">{STATUS_LABEL[set.status]}</span>
        <time dateTime={set.created_at}>{new Date(set.created_at).toLocaleString()}</time>
      </header>
      <ol className="revision-ops">
        {ops.map((op) => (
          <li key={op.index} className="revision-op">
            <span className="revision-op-desc">{describeStep(op.step)}</span>
            <span className={`revision-op-status revision-op-status-${op.status}`}>{OP_LABEL[op.status]}</span>
            {op.status === 'pending' && (
              <span className="revision-op-actions">
                <button type="button" disabled={busy !== null}
                  onClick={() => void resolve(set, op.index, 'accept')}>接受</button>
                <button type="button" disabled={busy !== null}
                  onClick={() => void resolve(set, op.index, 'reject')}>拒绝</button>
              </span>
            )}
          </li>
        ))}
      </ol>
    </section>;
  }

  if (loading) return <p role="status">正在加载修订</p>;
  return <div className="revision-panel">
    <h2>修订</h2>
    {error && <p role="alert">{error}</p>}
    <div className="revision-actions">
      <button type="button" disabled={busy !== null} onClick={() => void createAiSet()}>
        {busy === 'create' ? '创建中' : '创建 AI 修订集'}
      </button>
    </div>
    <h3>AI 修订</h3>
    {byAi.ai.length === 0 ? <p className="revision-empty">暂无 AI 修订</p> : byAi.ai.map(renderSet)}
    <h3>手工修订</h3>
    {byAi.manual.length === 0 ? <p className="revision-empty">暂无手工修订</p> : byAi.manual.map(renderSet)}
  </div>;
}
