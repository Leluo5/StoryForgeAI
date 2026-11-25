// ============================================================================
// M3c-3 知识库 · 抽屉紧凑卡片（方案 D §3.3）
// 依据：docs/01-产品与设计/知识库工作台抽屉设计-方案D.md §3.3
//
// 职责：380px 抽屉内的紧凑卡片（≥72px）——
//       行首类型图标 + 标题单行省略 + ★收藏 + 有大纲标记；
//       次行「类型 · 更新时间 · 置顶」；标签 chips（最多 2 个）；
//       悬停浮现「引用」快捷按钮（≤2 次点击引用路径）。
// 数据口径：卡片只用 KnowledgeEntrySummary 真实字段，不推断服务端未返回的数值
//       （summary 无关联计数字段，故不展示伪造的「关联 N」）。
// ============================================================================

import type { KnowledgeEntrySummary, KnowledgeEntryType } from '@storyforge/contracts';

const TYPE_LABELS: Record<KnowledgeEntryType, string> = {
  article: '文章',
  paper: '论文',
  novel: '小说',
  inspiration: '灵感',
  setting: '设定集'
};

/** 行首类型图标（与方案 C 的 TypeIcon 同一套字形，保持两稿一致） */
const TYPE_ICONS: Record<KnowledgeEntryType, string> = {
  article: '📄',
  paper: '📊',
  novel: '📖',
  inspiration: '💡',
  setting: '🌍'
};

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('zh-CN');
}

interface Props {
  entry: KnowledgeEntrySummary;
  /** 正在预览该条目（卡片保持选中态） */
  current: boolean;
  /** 引用成功后短暂高亮 */
  referenced: boolean;
  onSelect: (entryId: string) => void;
  onReference: (entryId: string) => void;
}

/** 抽屉紧凑卡片（方案 D §3.3）。卡片整体可点，「引用」为独立按钮。 */
export function DrawerEntryCard({ entry, current, referenced, onSelect, onReference }: Props) {
  const tags = entry.tags.slice(0, 2);
  const cardClass = referenced ? 'kb-drawer__card kb-drawer__card--referenced' : 'kb-drawer__card';

  return (
    <div className={cardClass} data-entry-id={entry.id} aria-current={current ? 'true' : undefined}>
      <button type="button" className="kb-drawer__card-title-hit" onClick={() => onSelect(entry.id)}>
        <span className="kb-drawer__card-head">
          <span className="kb-drawer__card-icon" aria-hidden="true">
            {TYPE_ICONS[entry.entry_type] ?? '📄'}
          </span>
          <span className="kb-drawer__card-title">{entry.title || '未命名条目'}</span>
          {entry.favorite && <span className="kb-drawer__card-star" title="已收藏" aria-label="已收藏">★</span>}
          {entry.outline_status === 'ready' && (
            <span className="kb-drawer__card-star" title="已有大纲" aria-label="已有大纲">🗂</span>
          )}
        </span>
        <span className="kb-drawer__card-meta">
          <span>{TYPE_LABELS[entry.entry_type] ?? entry.entry_type}</span>
          <span>更新 {formatDate(entry.updated_at)}</span>
          {entry.pinned && <span>已置顶</span>}
          {entry.ref_status && entry.ref_status !== 'active' && (
            <span>引用{entry.ref_status === 'source_deleted' ? '已失效' : '异常'}</span>
          )}
        </span>
        {tags.length > 0 && (
          <span className="kb-drawer__card-tags">
            {tags.map((tag) => <span key={tag} className="kb-drawer__card-tag">{tag}</span>)}
          </span>
        )}
      </button>
      <button
        type="button"
        className="kb-drawer__card-ref"
        onClick={(event) => { event.stopPropagation(); onReference(entry.id); }}
      >
        引用
      </button>
    </div>
  );
}
