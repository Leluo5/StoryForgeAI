import { useEffect, useRef } from 'react';
import type { KnowledgeEntrySummary } from '@storyforge/contracts';

interface Props {
  items: KnowledgeEntrySummary[];
  total: number;
  loading: boolean;
  selectedEntryId: string | null;
  hasMore: boolean;
  onSelect: (entryId: string) => void;
  onLoadMore: () => void;
}

/**
 * 条目列表（M3c-3 T31）：摘要卡片 + 无限滚动加载。
 * 满足 F2 §6.3：滚动到底部触发加载下一页（IntersectionObserver），
 * 选中态高亮，数据来自 T28 缓存（上层注入）。
 */
export function EntryList({ items, total, loading, selectedEntryId, hasMore, onSelect, onLoadMore }: Props) {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { rootMargin: '80px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, onLoadMore]);

  return (
    <div className="entry-list" role="list" aria-label="素材列表" aria-busy={loading}>
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="listitem"
          className={`entry-card${selectedEntryId === item.id ? ' is-selected' : ''}`}
          onClick={() => onSelect(item.id)}
        >
          <span className="entry-card__title">{item.title}</span>
          <span className="entry-card__meta">
            {item.entry_type} · {item.tags.length} 标签
            {item.favorite ? ' · 收藏' : ''}
            {item.pinned ? ' · 置顶' : ''}
          </span>
          <span className="entry-card__excerpt">{item.excerpt}</span>
        </button>
      ))}
      {hasMore && <div ref={sentinelRef} className="entry-list__sentinel" aria-hidden="true" />}
      {!loading && items.length === 0 && <p className="knowledge-empty" role="status">没有匹配的素材。</p>}
      <p className="entry-list__count" role="status">共 {total} 条</p>
    </div>
  );
}
