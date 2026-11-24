import { useRef } from 'react';
import type { KnowledgeScope } from '@storyforge/contracts';

export interface KnowledgeTabItem {
  scope: KnowledgeScope;
  label: string;
}

interface Props {
  /** 当前选中库作用域 */
  value: KnowledgeScope;
  /** 可选页签；无作品上下文时仅全局库 */
  items: KnowledgeTabItem[];
  onChange: (scope: KnowledgeScope) => void;
}

/**
 * 两库页签（M3c-3 T30）：知识库（global）/ 作品库（work）。
 * 满足 F2 §6.2：role="tablist" + aria-selected + 键盘方向键切换；
 * 库切换由上层按 library_scope 重置缓存，保留各自滚动位置与搜索词（滚动位置由上层保存）。
 */
export function KnowledgeTabs({ value, items, onChange }: Props) {
  const tabRefs = useRef<Map<KnowledgeScope, HTMLButtonElement>>(new Map());

  const onKeyDown = (event: React.KeyboardEvent, currentIndex: number) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (currentIndex + delta + items.length) % items.length;
    const next = items[nextIndex] as KnowledgeTabItem;
    onChange(next.scope);
    tabRefs.current.get(next.scope)?.focus();
  };

  return (
    <div role="tablist" aria-label="素材库范围" className="knowledge-tabs">
      {items.map((item, index) => {
        const selected = item.scope === value;
        return (
          <button
            key={item.scope}
            ref={(el) => {
              if (el) tabRefs.current.set(item.scope, el);
              else tabRefs.current.delete(item.scope);
            }}
            role="tab"
            type="button"
            id={`knowledge-tab-${item.scope}`}
            aria-selected={selected}
            aria-controls={`knowledge-tabpanel-${item.scope}`}
            tabIndex={selected ? 0 : -1}
            className={`knowledge-tab${selected ? ' is-active' : ''}`}
            onClick={() => onChange(item.scope)}
            onKeyDown={(e) => onKeyDown(e, index)}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
