// ============================================================================
// M3c-3 知识库 · 引用面板（T34）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §4.4、§5.7
//
// 职责：展示当前作品引用列表（含状态与收藏置顶）。
//       状态徽标：active=有效引用、source_deleted=来源已删除、invalid=失效引用（快照）。
//       失效引用以快照兜底，明确标注「失效引用（快照）」。
//       可移除引用（removeRef）、另存副本（copyRef { keep_ref }，成功提示并跳详情）。
//       空态「暂无引用」为非错误态（role=status）。
// ============================================================================

import { Button, Spinner } from '@storyforge/ui';
import type { KnowledgeEntrySummary, KnowledgeRefStatus } from '@storyforge/contracts';

interface Props {
  /** 当前作品 id（work_id） */
  workId: string;
  /** 已加载的引用列表 */
  refs: KnowledgeEntrySummary[];
  loading?: boolean;
  error?: string;
  /** 移除引用（removeRef） */
  onRemove?: (refId: string) => void | Promise<void>;
  /** 另存副本（copyRef { keep_ref }） */
  onCopy?: (refId: string, opts: { keep_ref: boolean }) => void | Promise<void>;
  /** 副本成功提示（含跳转说明） */
  copiedMessage?: string;
  /** 正在移除的引用 id */
  removingRefId?: string;
  /** 正在另存副本的引用 id */
  copyingRefId?: string;
}

const STATUS_LABEL: Record<KnowledgeRefStatus, string> = {
  active: '有效引用',
  source_deleted: '来源已删除',
  invalid: '失效引用（快照）'
};

/** 引用面板（M3c-3 T34）。 */
export function RefPanel({
  workId,
  refs,
  loading = false,
  error,
  onRemove,
  onCopy,
  copiedMessage,
  removingRefId,
  copyingRefId
}: Props) {
  if (loading) {
    return (
      <div className="ref-panel ref-panel--loading" role="status">
        <Spinner size="sm" />
        <p className="ref-panel__loading-text">正在加载引用…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="ref-panel ref-panel--error" role="alert">
        <p>{error}</p>
      </div>
    );
  }

  const empty = refs.length === 0;

  return (
    <div className="ref-panel">
      {empty ? (
        <p className="ref-panel__empty" role="status">暂无引用。</p>
      ) : (
        <ul className="ref-panel__list">
          {refs.map((item) => {
            const refId = item.ref_id ?? item.id;
            const status = item.ref_status ?? 'active';
            return (
              <li key={refId} className="ref-panel__item">
                <div className="ref-panel__body">
                  <strong className="ref-panel__title">{item.title}</strong>
                  <span className="ref-panel__status">{STATUS_LABEL[status]}</span>
                  {item.favorite && <span className="ref-panel__flag">已收藏</span>}
                  {item.pinned && <span className="ref-panel__flag">已置顶</span>}
                </div>
                <div className="ref-panel__actions">
                  {onCopy && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onCopy(refId, { keep_ref: true })}
                      disabled={copyingRefId === refId}
                      aria-label={`另存副本 ${item.title}`}
                    >
                      {copyingRefId === refId ? '副本创建中…' : '另存副本'}
                    </Button>
                  )}
                  {onRemove && (
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => onRemove(refId)}
                      disabled={removingRefId === refId}
                      aria-label={`移除引用 ${item.title}`}
                    >
                      {removingRefId === refId ? '移除中…' : '移除引用'}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {copiedMessage && (
        <div className="ref-panel__copied" role="status">
          <p>{copiedMessage}</p>
        </div>
      )}
    </div>
  );
}
