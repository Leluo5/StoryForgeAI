// ============================================================================
// M3c-3 知识库 · 回收站视图（T35）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.5、§5.8
//
// 职责：展示软删除列表（deleted=true 检索结果），逐条恢复（restoreEntry，
//       幂等；409 DUPLICATE 提示先处理冲突）、彻底删除（purgeEntry，必须
//       confirm=true，先二次确认）。引用来源被删显示「可从回收站恢复」。
// ============================================================================

import { useState } from 'react';
import { Button, Spinner } from '@storyforge/ui';
import type { KnowledgeEntrySummary } from '@storyforge/contracts';

interface Props {
  /** 软删除条目列表 */
  items: KnowledgeEntrySummary[];
  /** 恢复条目（restoreEntry，幂等） */
  onRestore?: (entryId: string) => void | Promise<void>;
  /** 彻底删除（purgeEntry，confirm=true，需二次确认） */
  onPurge?: (entryId: string, opts: { confirm: true }) => void | Promise<void>;
  loading?: boolean;
  error?: string;
  /** 恢复冲突（409 DUPLICATE）提示 */
  restoreError?: string;
  /** 正在恢复的条目 id */
  restoringId?: string;
  /** 正在彻底删除的条目 id */
  purgingId?: string;
}

function formatDeletedAt(value: string): string {
  try {
    return new Date(value).toLocaleString('zh-CN');
  } catch {
    return value;
  }
}

/** 回收站视图（M3c-3 T35）。 */
export function TrashView({
  items,
  onRestore,
  onPurge,
  loading = false,
  error,
  restoreError,
  restoringId,
  purgingId
}: Props) {
  const [confirmId, setConfirmId] = useState<string | null>(null);

  if (loading) {
    return (
      <div className="trash-view trash-view--loading" role="status">
        <Spinner size="sm" />
        <p className="trash-view__loading-text">正在加载回收站…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="trash-view trash-view--error" role="alert">
        <p>{error}</p>
      </div>
    );
  }

  const empty = items.length === 0;
  const confirmItem = confirmId ? items.find((i) => i.id === confirmId) : null;

  return (
    <div className="trash-view">
      {empty ? (
        <p className="trash-view__empty" role="status">回收站为空。</p>
      ) : (
        <ul className="trash-view__list">
          {items.map((item) => (
            <li key={item.id} className="trash-view__item">
              <div className="trash-view__body">
                <strong className="trash-view__title">{item.title}</strong>
                <span className="trash-view__deleted">删除于 {formatDeletedAt(item.updated_at)}</span>
              </div>
              <div className="trash-view__actions">
                {onRestore && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onRestore(item.id)}
                    disabled={restoringId === item.id}
                    aria-label={`恢复 ${item.title}`}
                  >
                    {restoringId === item.id ? '恢复中…' : '恢复'}
                  </Button>
                )}
                {onPurge && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => setConfirmId(item.id)}
                    disabled={purgingId === item.id}
                    aria-label={`彻底删除 ${item.title}`}
                  >
                    彻底删除
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {confirmItem && onPurge && (
        <div className="trash-view__confirm" role="dialog" aria-modal="true" aria-label="确认彻底删除">
          <p>确认彻底删除「{confirmItem.title}」？此操作不可撤销。</p>
          <div className="trash-view__confirm-actions">
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                onPurge(confirmItem.id, { confirm: true });
                setConfirmId(null);
              }}
              disabled={purgingId === confirmItem.id}
            >
              确认删除
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmId(null)}>
              取消
            </Button>
          </div>
        </div>
      )}

      {restoreError && (
        <div className="trash-view__restore-error" role="alert">
          <p>{restoreError}</p>
        </div>
      )}
    </div>
  );
}
