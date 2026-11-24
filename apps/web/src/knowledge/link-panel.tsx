// ============================================================================
// M3c-3 知识库 · 关联面板（T34）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.3、§5.5
//
// 职责：展示条目全部关联（双向，含对方标题与类型）。
//       自动关联（inspiration_auto）展示相似度分数与「灵感相似匹配」徽标；
//       手动关联（manual）展示「手动关联」徽标。
//       可解除关联（deleteLink）、手动新增（createLink）。
//       自关联被拒（409 KNOWLEDGE_LINK_SELF）由上层以 selfLinkError 传入友好提示。
//       空态「暂无关联」为非错误态（role=status）。
// ============================================================================

import { useState } from 'react';
import { Button, Spinner } from '@storyforge/ui';
import type { KnowledgeLink, KnowledgeEntrySummary } from '@storyforge/contracts';

interface Props {
  /** 当前条目 id（source_entry_id） */
  entryId: string;
  /** 已加载的关联列表 */
  links: KnowledgeLink[];
  /** 手动关联候选目标条目（可选） */
  candidates?: KnowledgeEntrySummary[];
  loading?: boolean;
  error?: string;
  /** 自关联 / 重复 / 跨库等被拒的友好提示 */
  selfLinkError?: string;
  /** 解除关联（deleteLink） */
  onRemove?: (linkId: string) => void | Promise<void>;
  /** 手动建立关联（createLink { source_entry_id, target_entry_id }） */
  onAdd?: (targetEntryId: string) => void | Promise<void>;
  /** 正在解除的关联 id */
  removingLinkId?: string;
  /** 正在新增关联 */
  adding?: boolean;
}

const KIND_LABEL: Record<KnowledgeLink['kind'], string> = {
  inspiration_auto: '灵感相似匹配',
  manual: '手动关联'
};

/** 关联面板（M3c-3 T34）。 */
export function LinkPanel({
  entryId,
  links,
  candidates,
  loading = false,
  error,
  selfLinkError,
  onRemove,
  onAdd,
  removingLinkId,
  adding = false
}: Props) {
  const [targetId, setTargetId] = useState('');

  if (loading) {
    return (
      <div className="link-panel link-panel--loading" role="status">
        <Spinner size="sm" />
        <p className="link-panel__loading-text">正在加载关联…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="link-panel link-panel--error" role="alert">
        <p>{error}</p>
      </div>
    );
  }

  const empty = links.length === 0;

  return (
    <div className="link-panel">
      {empty ? (
        <p className="link-panel__empty" role="status">暂无关联。</p>
      ) : (
        <ul className="link-panel__list">
          {links.map((link) => (
            <li key={link.id} className="link-panel__item">
              <div className="link-panel__body">
                <strong className="link-panel__title">{link.target_title}</strong>
                <span className="link-panel__kind">{KIND_LABEL[link.kind]}</span>
                {link.kind === 'inspiration_auto' && typeof link.score === 'number' && (
                  <span className="link-panel__score">相似度 {link.score.toFixed(2)}</span>
                )}
              </div>
              {onRemove && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRemove(link.id)}
                  disabled={removingLinkId === link.id}
                  aria-label={`解除关联 ${link.target_title}`}
                >
                  {removingLinkId === link.id ? '解除中…' : '解除关联'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {onAdd && (
        <div className="link-panel__add">
          <label className="link-panel__add-label" htmlFor={`link-target-${entryId}`}>
            选择目标条目
          </label>
          <select
            id={`link-target-${entryId}`}
            className="link-panel__add-select"
            aria-label="选择目标条目"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            disabled={adding}
          >
            <option value="">请选择…</option>
            {(candidates ?? []).map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.title}
              </option>
            ))}
          </select>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              if (!targetId) return;
              void onAdd(targetId);
              setTargetId('');
            }}
            disabled={adding || targetId === ''}
            loading={adding}
          >
            建立关联
          </Button>
        </div>
      )}

      {selfLinkError && (
        <div className="link-panel__error" role="alert">
          <p>{selfLinkError}</p>
        </div>
      )}
    </div>
  );
}
