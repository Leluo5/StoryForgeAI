export type KnowledgeEntryView = 'original' | 'structured';

interface Props {
  value: KnowledgeEntryView;
  /** 是否可切换到结构化视图（无结构化数据时禁用并提示） */
  structuredDisabled: boolean;
  onChange: (view: KnowledgeEntryView) => void;
}

/**
 * 原文 / 结构化双视图切换（M3c-3 T31）。
 * 满足 F2 §8.1：切换保留阅读位置（滚动由上层保存，不卸载视图内容）。
 * 结构化不可用时展示禁用态。
 */
export function EntryViewToggle({ value, structuredDisabled, onChange }: Props) {
  return (
    <div role="group" aria-label="详情视图切换" className="entry-view-toggle">
      <button
        type="button"
        role="tab"
        aria-selected={value === 'original'}
        className={`entry-view-btn${value === 'original' ? ' is-active' : ''}`}
        onClick={() => onChange('original')}
      >
        原文
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={value === 'structured'}
        className={`entry-view-btn${value === 'structured' ? ' is-active' : ''}`}
        disabled={structuredDisabled}
        title={structuredDisabled ? '暂无结构化结果' : undefined}
        onClick={() => onChange('structured')}
      >
        结构化
      </button>
    </div>
  );
}
