// ============================================================================
// M3c-3 知识库 · 类型选择器（T32）
// 依据：docs/04-功能交付档案/M3c-3-知识库/02-技术方案.md §6.4
//
// 职责：选择条目类型，「自动」+ 5 类（article/paper/novel/inspiration/setting）。
//       自动表示不指定类型，由服务端解析推断；选择后以受控 value 上报。
// ============================================================================

import type { KnowledgeEntryType } from '@storyforge/contracts';

/** 选择器值：'auto' 表示交由服务端自动推断，其余为五类显式类型 */
export type KnowledgeTypeValue = KnowledgeEntryType | 'auto';

export interface TypeOption {
  value: KnowledgeTypeValue;
  label: string;
}

export const KNOWLEDGE_TYPE_OPTIONS: TypeOption[] = [
  { value: 'auto', label: '自动' },
  { value: 'article', label: '文章' },
  { value: 'paper', label: '论文' },
  { value: 'novel', label: '小说' },
  { value: 'inspiration', label: '灵感' },
  { value: 'setting', label: '设定' }
];

interface Props {
  value: KnowledgeTypeValue;
  onChange: (value: KnowledgeTypeValue) => void;
  /** 禁用全部选项（提交中 / 无作品上下文） */
  disabled?: boolean;
  label?: string;
}

/** 类型选择器：`role="radiogroup"` + `aria-checked`，按钮组语义，键盘 Tab 可聚焦。 */
export function TypeSelector({ value, onChange, disabled = false, label = '条目类型' }: Props) {
  return (
    <div className="type-selector" role="radiogroup" aria-label={label}>
      {KNOWLEDGE_TYPE_OPTIONS.map((option) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            className={['type-selector__option', selected ? 'is-selected' : ''].filter(Boolean).join(' ')}
            disabled={disabled}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
